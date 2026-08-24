import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  parseSegmentCreate,
  type ExtractionResult,
  type SegmentCreate,
} from "@reflection/shared/contracts";
import {
  equivalenceKey,
  projectionFingerprintForBoundary,
  segmentIdFor,
  segmentIdForRequest,
  sourceFingerprint,
  type PreparedSegment,
} from "@reflection/shared/domain";
import { Client, type PoolClient, type QueryResultRow } from "pg";
import { describe, expect, test } from "vitest";

import {
  Database,
  JobNotRetryableError,
  type ClaimedJob,
} from "../src/database.js";

type DatabaseSettings = ConstructorParameters<typeof Database>[0];

const DATABASE_URL = process.env.REFLECTION_TEST_DATABASE_URL;
const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../migrations", import.meta.url),
);
const EMBEDDING = Array.from({ length: 1024 }, () => 0.01);
const OPPOSITE_EMBEDDING = Array.from({ length: 1024 }, () => -0.01);

function databaseUrl(): string {
  if (!DATABASE_URL) throw new Error("REFLECTION_TEST_DATABASE_URL is not set");
  return DATABASE_URL;
}

function settings(url = databaseUrl()): DatabaseSettings {
  return {
    databaseUrl: url,
    databasePoolMinSize: 1,
    databasePoolMaxSize: 8,
    migrationLockId: 7_320_260_818_002,
    migrationsDir: MIGRATIONS_DIR,
  } as DatabaseSettings;
}

function required<T>(
  value: T | null | undefined,
  message = "expected value",
): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function request(value: unknown): SegmentCreate {
  return parseSegmentCreate(value);
}

function updateRequest(
  source: SegmentCreate,
  update: Partial<SegmentCreate>,
): SegmentCreate {
  return parseSegmentCreate({ ...source, ...update });
}

function emptyPrepared(claimed: ClaimedJob, summary: string): PreparedSegment {
  return {
    id: claimed.segmentId,
    sessionId: claimed.request.session_id,
    startUserMessageId: claimed.request.start_user_message_id,
    endUserMessageId: claimed.request.end_user_message_id,
    sourceBoundaryVersion: claimed.request.source_boundary_version,
    startSourceMessageId: claimed.request.start_source_message_id,
    endSourceMessageId: claimed.request.end_source_message_id,
    summary,
    entities: [],
    claims: [],
    projectionVersion: claimed.request.projection_version,
  };
}

function preparedSegment(
  claimed: ClaimedJob,
  options: {
    endId: string;
    summary: string;
    subjectId: string;
    objectId: string;
    entitiesAreNew: boolean;
  },
): PreparedSegment {
  return {
    id: claimed.segmentId,
    sessionId: claimed.request.session_id,
    startUserMessageId: claimed.request.start_user_message_id,
    endUserMessageId: options.endId,
    sourceBoundaryVersion: claimed.request.source_boundary_version,
    startSourceMessageId: claimed.request.start_source_message_id,
    endSourceMessageId: claimed.request.end_source_message_id,
    summary: options.summary,
    entities: [
      {
        id: options.subjectId,
        canonicalName: "Reflection",
        normalizedName: "reflection",
        description: "A memory extraction service",
        aliases: ["Reflection"],
        embedding: options.entitiesAreNew ? EMBEDDING : null,
        isNew: options.entitiesAreNew,
      },
      {
        id: options.objectId,
        canonicalName: "PostgreSQL",
        normalizedName: "postgresql",
        description: "A relational database",
        aliases: ["Postgres"],
        embedding: options.entitiesAreNew ? EMBEDDING : null,
        isNew: options.entitiesAreNew,
      },
    ],
    claims: [
      {
        id: randomUUID(),
        subject: "Reflection",
        subjectEntityId: options.subjectId,
        predicate: "uses",
        confidence: 0.9,
        objectEntity: "PostgreSQL",
        objectEntityId: options.objectId,
        objectValue: null,
        equivalenceKey: equivalenceKey(options.subjectId, "uses", {
          objectEntityId: options.objectId,
          objectValue: null,
        }),
        embedding: EMBEDDING,
      },
      {
        id: randomUUID(),
        subject: "Reflection",
        subjectEntityId: options.subjectId,
        predicate: "has timeout",
        confidence: 0.4,
        objectEntity: null,
        objectEntityId: null,
        objectValue: "120 seconds",
        equivalenceKey: equivalenceKey(options.subjectId, "has timeout", {
          objectEntityId: null,
          objectValue: "120 seconds",
        }),
        embedding: OPPOSITE_EMBEDDING,
      },
    ],
    projectionVersion: claimed.request.projection_version,
  };
}

async function completeResolution(
  database: Database,
  claimed: ClaimedJob,
  prepared: PreparedSegment,
): Promise<boolean> {
  const extraction: ExtractionResult = claimed.extractionResult ?? {
    summary: prepared.summary,
    claims: [],
  };
  if (
    claimed.extractionResult === null &&
    !(await database.publishExtraction(claimed, extraction))
  ) {
    return false;
  }
  return database.commitResolution(claimed, extraction, prepared);
}

async function withClient<T>(
  database: Database,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database.pool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

async function truncate(database: Database): Promise<void> {
  await database.pool.query(
    "TRUNCATE segment_targets, claims, entity_aliases, entities, segments, " +
      "extraction_jobs RESTART IDENTITY CASCADE",
  );
}

async function within<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`operation exceeded ${milliseconds}ms`)),
      milliseconds,
    );
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe.sequential("Database PostgreSQL integration", () => {
  test.skipIf(!DATABASE_URL)(
    "preserves queue fencing, replacement, retry, and recall semantics",
    async () => {
      const database = new Database(settings());
      await database.open();
      try {
        await truncate(database);
        const firstRequest = request({
          session_id: "session",
          start_user_message_id: "start",
          end_user_message_id: "end-1",
          projection_version: 1,
          messages: [{ role: "user", text: "hello" }],
        });

        const first = await database.enqueue(firstRequest);
        const duplicate = await database.enqueue(
          updateRequest(firstRequest, { messages: firstRequest.messages }),
        );
        expect(duplicate.id).toBe(first.id);
        const identity = required(
          (
            await database.pool.query<
              QueryResultRow & {
                job_generation: string;
                job_fingerprint: string;
                target_generation: string;
                target_fingerprint: string;
              }
            >(
              `
              SELECT jobs.source_generation AS job_generation,
                     jobs.source_fingerprint AS job_fingerprint,
                     targets.source_generation AS target_generation,
                     targets.source_fingerprint AS target_fingerprint
              FROM extraction_jobs AS jobs
              JOIN segment_targets AS targets ON targets.job_id = jobs.id
              WHERE jobs.id = $1
              `,
              [first.id],
            )
          ).rows[0],
        );
        expect(BigInt(identity.job_generation)).toBe(1n);
        expect(identity.job_generation).toBe(identity.target_generation);
        expect(identity.job_fingerprint).toBe(identity.target_fingerprint);
        expect(identity.job_fingerprint).toBe(sourceFingerprint(firstRequest));

        const staleClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        const changedRequest = updateRequest(firstRequest, {
          messages: [{ role: "user", text: "hello, corrected" }],
        });
        const changed = await database.enqueue(changedRequest);
        expect(changed.id).toBe(first.id);
        expect(changed.status).toBe("running");

        expect(await database.segmentSummaries("session")).toEqual([]);
        const [recovered, currentClaimValue] = await withClient(
          database,
          async (client) => [
            await database.recoverRunningJobs(client),
            await database.claimOldestJob(client),
          ],
        );
        expect(recovered).toBe(1);
        const currentClaim = required(currentClaimValue);
        expect(currentClaim.id).toBe(first.id);
        expect(currentClaim.sourceGeneration).toBeGreaterThan(
          staleClaim.sourceGeneration,
        );
        expect(currentClaim.sourceFingerprint).toBe(
          sourceFingerprint(changedRequest),
        );
        expect(currentClaim.attempts).toBe(1);
        expect(currentClaim.leaseId).not.toBe(staleClaim.leaseId);
        expect(
          await database.finishFailedAttempt(staleClaim, "stale failure", {
            retryAfterSeconds: 0,
          }),
        ).toBe(false);

        const subjectId = randomUUID();
        const objectId = randomUUID();
        const firstPrepared = preparedSegment(currentClaim, {
          endId: "end-1",
          summary: "First tail snapshot",
          subjectId,
          objectId,
          entitiesAreNew: true,
        });
        await expect(
          completeResolution(database, staleClaim, firstPrepared),
        ).resolves.toBe(false);
        expect(await database.getSegment(first.segment_id)).toBeNull();

        await completeResolution(database, currentClaim, firstPrepared);
        const tail = await database.enqueue(
          updateRequest(changedRequest, { end_user_message_id: "end-2" }),
        );
        expect(tail.id).not.toBe(first.id);
        expect(tail.segment_id).toBe(first.segment_id);
        const tailClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(tailClaim.id).toBe(tail.id);
        await completeResolution(
          database,
          tailClaim,
          preparedSegment(tailClaim, {
            endId: "end-2",
            summary: "Latest tail snapshot",
            subjectId,
            objectId,
            entitiesAreNew: false,
          }),
        );
        const committedIdentity = required(
          (
            await database.pool.query<
              QueryResultRow & {
                source_generation: string;
                source_fingerprint: string;
                target_cleared: boolean;
              }
            >(
              `
              SELECT source_generation, source_fingerprint,
                     NOT EXISTS (
                         SELECT 1 FROM segment_targets WHERE segment_id = segments.id
                     ) AS target_cleared
              FROM segments
              WHERE id = $1
              `,
              [tailClaim.segmentId],
            )
          ).rows[0],
        );
        expect(BigInt(committedIdentity.source_generation)).toBe(
          tailClaim.sourceGeneration,
        );
        expect(committedIdentity.source_fingerprint).toBe(
          tailClaim.sourceFingerprint,
        );
        expect(committedIdentity.target_cleared).toBe(true);

        const segment = required(await database.getSegment(first.segment_id));
        const candidates = await database.entityCandidates(
          "Postgres",
          EMBEDDING,
        );
        const direct = await database.directClaims(EMBEDDING);
        const neighbors = await database.neighboringClaims(
          subjectId,
          EMBEDDING,
          0.75,
        );
        const summaries = await database.priorSummaries(
          "session",
          first.segment_id,
        );
        const segmentSummaries = await database.segmentSummaries("session");

        expect(segment.end_user_message_id).toBe("end-2");
        expect(segment.summary).toBe("Latest tail snapshot");
        expect(
          new Set(segment.claims.map((claim) => claim.object_value)),
        ).toEqual(new Set([null, "120 seconds"]));
        expect(
          new Set(segment.claims.map((claim) => claim.confidence)),
        ).toEqual(new Set([0.4, 0.9]));
        expect(candidates.map((candidate) => candidate.id)).toContain(objectId);
        expect(
          new Set(candidates.map((candidate) => candidate.description)).size,
        ).toBeGreaterThan(0);
        expect(new Set(direct.map((claim) => claim.segmentId))).toEqual(
          new Set([first.segment_id]),
        );
        expect(required(neighbors[0]).predicate).toBe("uses");
        expect(required(neighbors[0]).similarity).toBeGreaterThan(
          required(neighbors[1]).similarity,
        );
        expect(required(neighbors[0]).seedSimilarity).toBe(0.75);
        expect(summaries).toEqual([]);
        expect(segmentSummaries.map((item) => item.id)).toEqual([
          first.segment_id,
        ]);
        expect(required(segmentSummaries[0]).end_user_message_id).toBe("end-2");
        expect(required(segmentSummaries[0]).summary).toBe(
          "Latest tail snapshot",
        );

        const legacyRequest = request({
          session_id: "session",
          start_user_message_id: "legacy-start",
          end_user_message_id: "legacy-end",
          messages: [{ role: "user", text: "legacy" }],
        });
        const legacyJob = await database.enqueue(legacyRequest);
        const legacyClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        await completeResolution(
          database,
          legacyClaim,
          emptyPrepared(legacyClaim, "Unsafe legacy summary"),
        );
        const mixedSummaries = await database.segmentSummaries("session");
        expect(new Set(mixedSummaries.map((item) => item.id))).toEqual(
          new Set([first.segment_id, legacyJob.segment_id]),
        );
        expect(
          new Set(mixedSummaries.map((item) => item.projection_version)),
        ).toEqual(new Set([0, 1]));

        const safeJob = await database.enqueue(
          updateRequest(legacyRequest, { projection_version: 1 }),
        );
        expect(safeJob.id).toBe(legacyJob.id);
        expect(safeJob.status).toBe("pending");
        expect(
          new Set(
            (await database.segmentSummaries("session")).map(
              (item) => item.summary,
            ),
          ),
        ).not.toContain("Unsafe legacy summary");
        let safeClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(
          await database.finishFailedAttempt(safeClaim, "terminal v1 failure", {
            retryAfterSeconds: null,
          }),
        ).toBe(true);
        expect(
          new Set(
            (await database.segmentSummaries("session")).map(
              (item) => item.summary,
            ),
          ),
        ).not.toContain("Unsafe legacy summary");
        const retriedSafeJob = required(
          await database.retryFailedJob(safeJob.id),
        );
        expect(retriedSafeJob.status).toBe("pending");
        expect(retriedSafeJob.attempts).toBe(0);
        safeClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        await completeResolution(
          database,
          safeClaim,
          emptyPrepared(safeClaim, "Projection-safe summary"),
        );
        expect(
          new Set(
            (await database.segmentSummaries("session")).map(
              (item) => item.summary,
            ),
          ),
        ).toEqual(new Set(["Latest tail snapshot", "Projection-safe summary"]));
        const downgradeJob = await database.enqueue(
          updateRequest(legacyRequest, { end_user_message_id: "legacy-end-2" }),
        );
        expect(downgradeJob).toMatchObject({
          status: "superseded",
          error: "snapshot was superseded",
        });
        const preserved = required(
          await database.getSegment(safeJob.segment_id),
        );
        expect(preserved.summary).toBe("Projection-safe summary");
        expect(preserved.end_user_message_id).toBe("legacy-end");

        const forwardJob = await database.enqueue(
          updateRequest(legacyRequest, {
            end_user_message_id: "legacy-end-2",
            projection_version: 1,
          }),
        );
        expect(forwardJob.id).toBe(downgradeJob.id);
        expect(forwardJob.status).toBe("pending");
        const forwardClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        await completeResolution(
          database,
          forwardClaim,
          emptyPrepared(forwardClaim, "Projection-safe forward snapshot"),
        );

        const rewindJob = await database.enqueue(
          updateRequest(legacyRequest, { projection_version: 1 }),
        );
        expect(rewindJob.id).toBe(safeJob.id);
        expect(rewindJob.status).toBe("pending");
        const rewindClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        await completeResolution(
          database,
          rewindClaim,
          emptyPrepared(rewindClaim, "Projection-safe rewind snapshot"),
        );
        const rewound = required(await database.getSegment(safeJob.segment_id));
        expect(rewound.summary).toBe("Projection-safe rewind snapshot");
        expect(rewound.end_user_message_id).toBe("legacy-end");

        const pendingFuture = await database.enqueue(
          updateRequest(legacyRequest, {
            end_user_message_id: "legacy-end-3",
            projection_version: 1,
          }),
        );
        const replayCurrent = await database.enqueue(
          updateRequest(legacyRequest, { projection_version: 1 }),
        );
        expect(replayCurrent.status).toBe("pending");
        expect(await database.getJob(pendingFuture.id)).toMatchObject({
          status: "superseded",
          error: "snapshot was superseded",
        });
        const scrubbedFuture = required(
          (
            await database.pool.query<{ payload: unknown } & QueryResultRow>(
              "SELECT payload FROM extraction_jobs WHERE id = $1",
              [pendingFuture.id],
            )
          ).rows[0],
        );
        expect(scrubbedFuture.payload).toBeNull();
        const replayCurrentClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        await completeResolution(
          database,
          replayCurrentClaim,
          emptyPrepared(replayCurrentClaim, "Projection-safe replay snapshot"),
        );

        const pendingUpgradeRequest = request({
          session_id: "session",
          start_user_message_id: "pending-upgrade",
          end_user_message_id: "pending-upgrade-end",
          messages: [{ role: "user", text: "upgrade" }],
        });
        const pendingLegacy = await database.enqueue(pendingUpgradeRequest);
        const pendingSafe = await database.enqueue(
          updateRequest(pendingUpgradeRequest, { projection_version: 2 }),
        );
        expect(pendingSafe.id).toBe(pendingLegacy.id);
        expect(pendingSafe.projection_version).toBe(2);
        const pendingDowngrade = await database.enqueue(
          updateRequest(pendingUpgradeRequest, {
            end_user_message_id: "pending-downgrade",
            projection_version: 1,
          }),
        );
        expect(pendingDowngrade.status).toBe("superseded");
        const pendingSafeClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(pendingSafeClaim.id).toBe(pendingSafe.id);
        expect(pendingSafeClaim.request.projection_version).toBe(2);
        await completeResolution(
          database,
          pendingSafeClaim,
          emptyPrepared(pendingSafeClaim, "Safely upgraded while pending"),
        );

        const supportRequest = request({
          session_id: "other-session",
          start_user_message_id: "support-start",
          end_user_message_id: "support-end",
          messages: [{ role: "user", text: "same claim" }],
        });
        const supportJob = await database.enqueue(supportRequest);
        const supportClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        await completeResolution(
          database,
          supportClaim,
          preparedSegment(supportClaim, {
            endId: "support-end",
            summary: "Independent support",
            subjectId,
            objectId,
            entitiesAreNew: false,
          }),
        );
        const usesKey = equivalenceKey(subjectId, "uses", {
          objectEntityId: objectId,
          objectValue: null,
        });
        const support = required(
          (await database.supportForEquivalenceKeys([usesKey])).get(usesKey),
        );
        expect(support.supportCount).toBe(2);
        expect(support.sessionCount).toBe(2);
        expect(new Set(support.segmentIds)).toEqual(
          new Set([first.segment_id, supportJob.segment_id]),
        );

        const emptySharedJob = await database.enqueue(
          updateRequest(firstRequest, { end_user_message_id: "end-3" }),
        );
        expect(
          (await database.directClaims(EMBEDDING)).some(
            (claim) => claim.segmentId === first.segment_id,
          ),
        ).toBe(false);
        expect(
          (await database.neighboringClaims(subjectId, EMBEDDING, 0.75)).some(
            (claim) => claim.segmentId === first.segment_id,
          ),
        ).toBe(false);
        const pendingSupport = required(
          (await database.supportForEquivalenceKeys([usesKey])).get(usesKey),
        );
        expect(pendingSupport.supportCount).toBe(1);
        expect(pendingSupport.segmentIds).toEqual([supportJob.segment_id]);

        let emptySharedClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(
          await database.finishFailedAttempt(
            emptySharedClaim,
            "terminal corrected snapshot",
            { retryAfterSeconds: null },
          ),
        ).toBe(true);
        expect(
          (await database.directClaims(EMBEDDING)).some(
            (claim) => claim.segmentId === first.segment_id,
          ),
        ).toBe(false);
        expect(
          required(
            (await database.supportForEquivalenceKeys([usesKey])).get(usesKey),
          ).supportCount,
        ).toBe(1);

        await database.retryFailedJob(emptySharedJob.id);
        emptySharedClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        await completeResolution(
          database,
          emptySharedClaim,
          emptyPrepared(emptySharedClaim, "No claims in this snapshot"),
        );
        const sharedEntities = (
          await database.pool.query<{ id: string } & QueryResultRow>(
            "SELECT id FROM entities WHERE id = ANY($1::uuid[])",
            [[subjectId, objectId]],
          )
        ).rows;
        expect(new Set(sharedEntities.map((row) => row.id))).toEqual(
          new Set([subjectId, objectId]),
        );

        const orphanRequest = request({
          session_id: "orphan-session",
          start_user_message_id: "orphan-start",
          end_user_message_id: "orphan-end-1",
          messages: [{ role: "user", text: "temporary claim" }],
        });
        await database.enqueue(orphanRequest);
        const orphanClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        const orphanSubjectId = randomUUID();
        const orphanObjectId = randomUUID();
        await completeResolution(
          database,
          orphanClaim,
          preparedSegment(orphanClaim, {
            endId: "orphan-end-1",
            summary: "Temporary claims",
            subjectId: orphanSubjectId,
            objectId: orphanObjectId,
            entitiesAreNew: true,
          }),
        );
        await database.enqueue(
          updateRequest(orphanRequest, {
            end_user_message_id: "orphan-end-2",
          }),
        );
        const emptyClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        await completeResolution(
          database,
          emptyClaim,
          emptyPrepared(emptyClaim, "No durable claims"),
        );
        const orphanEntities = (
          await database.pool.query<{ id: string } & QueryResultRow>(
            "SELECT id FROM entities WHERE id = ANY($1::uuid[])",
            [[orphanSubjectId, orphanObjectId]],
          )
        ).rows;
        expect(orphanEntities).toEqual([]);

        const completedPayloads = (
          await database.pool.query<{ payload: unknown } & QueryResultRow>(
            "SELECT id, payload FROM extraction_jobs WHERE id = ANY($1::bigint[])",
            [[first.id, tail.id, supportJob.id]],
          )
        ).rows;
        expect(completedPayloads.every((row) => row.payload === null)).toBe(
          true,
        );

        const oldSnapshot = await database.enqueue(
          updateRequest(firstRequest, {
            start_user_message_id: "blocked-tail",
            end_user_message_id: "old",
          }),
        );
        const oldSnapshotClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(
          await database.finishFailedAttempt(
            oldSnapshotClaim,
            "terminal old snapshot",
            { retryAfterSeconds: null },
          ),
        ).toBe(true);
        const newerSnapshot = await database.enqueue(
          updateRequest(firstRequest, {
            start_user_message_id: "blocked-tail",
            end_user_message_id: "new",
          }),
        );
        const retryError = await database
          .retryFailedJob(oldSnapshot.id)
          .catch((error: unknown) => error);
        expect(retryError).toBeInstanceOf(JobNotRetryableError);
        if (!(retryError instanceof Error))
          throw new Error("expected retry error");
        expect(retryError.message).toMatch(/newer snapshot/);
        const newerSnapshotClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(newerSnapshotClaim.id).toBe(newerSnapshot.id);
        expect(
          await database.finishFailedAttempt(
            newerSnapshotClaim,
            "terminal newer snapshot",
            { retryAfterSeconds: null },
          ),
        ).toBe(true);
        const failedPayloads = (
          await database.pool.query<
            { id: string; status: string; payload: unknown } & QueryResultRow
          >(
            "SELECT id, status, payload FROM extraction_jobs WHERE id = ANY($1::bigint[])",
            [[oldSnapshot.id, newerSnapshot.id]],
          )
        ).rows;
        expect(
          failedPayloads.find((row) => row.id === String(oldSnapshot.id)),
        ).toMatchObject({ status: "superseded", payload: null });
        expect(
          failedPayloads.find((row) => row.id === String(newerSnapshot.id)),
        ).toMatchObject({ status: "failed" });
        expect(
          failedPayloads.find((row) => row.id === String(newerSnapshot.id))
            ?.payload,
        ).not.toBeNull();

        const retryRequest = updateRequest(firstRequest, {
          start_user_message_id: "retry-start",
          end_user_message_id: "retry-end",
        });
        const retryJob = await database.enqueue(retryRequest);
        const terminalClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(
          await database.finishFailedAttempt(terminalClaim, "terminal", {
            retryAfterSeconds: null,
          }),
        ).toBe(true);
        const exactFailedReplay = await database.enqueue(
          updateRequest(retryRequest, { processing_priority: 100 }),
        );
        expect(exactFailedReplay).toMatchObject({
          id: retryJob.id,
          status: "failed",
          attempts: terminalClaim.attempts,
          error: "terminal",
        });
        const retried = required(await database.retryFailedJob(retryJob.id));
        expect(retried.attempts).toBe(0);
        const retriedClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(retriedClaim.leaseId).not.toBe(terminalClaim.leaseId);
        await database.applyMigrations(MIGRATIONS_DIR);
        const stillRunning = required(await database.getJob(retriedClaim.id));
        expect(stillRunning.status).toBe("running");
        expect(
          await database.finishFailedAttempt(
            terminalClaim,
            "stale after explicit retry",
            { retryAfterSeconds: null },
          ),
        ).toBe(false);

        const newer = await database.enqueue(
          updateRequest(firstRequest, {
            start_user_message_id: "newer",
            end_user_message_id: "newer-end",
          }),
        );
        expect(
          await database.finishFailedAttempt(retriedClaim, "transient", {
            retryAfterSeconds: 60,
          }),
        ).toBe(true);
        const newerClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(newerClaim.id).toBe(newer.id);
        expect(required(await database.getJob(retried.id)).status).toBe(
          "pending",
        );
      } finally {
        await database.close();
      }
    },
    30_000,
  );

  test.skipIf(!DATABASE_URL)(
    "keeps running targets recoverable across replays and projection upgrades",
    async () => {
      const database = new Database(settings());
      await database.open();
      try {
        await truncate(database);
        const firstRequest = request({
          session_id: "running-session",
          start_user_message_id: "start",
          end_user_message_id: "A",
          projection_version: 1,
          messages: [{ role: "user", text: "A" }],
        });
        const firstJob = await database.enqueue(firstRequest);
        let firstClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        const [recovered, recoveredClaim] = await withClient(
          database,
          async (client) => [
            await database.recoverRunningJobs(client),
            await database.claimOldestJob(client),
          ],
        );
        expect(recovered).toBe(1);
        firstClaim = required(recoveredClaim);
        expect(firstClaim.attempts).toBe(2);
        await completeResolution(
          database,
          firstClaim,
          emptyPrepared(firstClaim, "A"),
        );

        const secondJob = await database.enqueue(
          updateRequest(firstRequest, { end_user_message_id: "B" }),
        );
        const secondClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(secondClaim.id).toBe(secondJob.id);
        expect(await database.segmentSummaries("running-session")).toEqual([]);
        const replay = await database.enqueue(firstRequest);
        expect(replay.id).toBe(firstJob.id);
        expect(replay.status).toBe("pending");
        expect(await database.segmentSummaries("running-session")).toEqual([]);

        expect(
          await completeResolution(
            database,
            secondClaim,
            emptyPrepared(secondClaim, "stale B"),
          ),
        ).toBe(false);
        const supersededJob = required(await database.getJob(secondJob.id));
        expect(supersededJob).toMatchObject({
          status: "superseded",
          error: "snapshot was superseded",
        });
        const staleResult = required(
          await database.getSegment(firstJob.segment_id),
        );
        expect(staleResult.end_user_message_id).toBe("A");
        expect(staleResult.summary).toBe("A");

        const replayClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(replayClaim.id).toBe(firstJob.id);
        await completeResolution(
          database,
          replayClaim,
          emptyPrepared(replayClaim, "A after stale B"),
        );
        const rewound = required(
          await database.getSegment(firstJob.segment_id),
        );
        expect(rewound.end_user_message_id).toBe("A");
        expect(rewound.summary).toBe("A after stale B");

        const failingJob = await database.enqueue(
          updateRequest(firstRequest, { end_user_message_id: "failing-B" }),
        );
        const failingClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(failingClaim.id).toBe(failingJob.id);
        await database.enqueue(firstRequest);
        expect(
          await database.finishFailedAttempt(failingClaim, "terminal failure", {
            retryAfterSeconds: null,
          }),
        ).toBe(true);
        expect(await database.segmentSummaries("running-session")).toEqual([]);
        const recoveredA = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(recoveredA.id).toBe(firstJob.id);
        await completeResolution(
          database,
          recoveredA,
          emptyPrepared(recoveredA, "A after failed B"),
        );
        const targetCount = required(
          (
            await database.pool.query<{ count: string } & QueryResultRow>(
              "SELECT count(*) AS count FROM segment_targets WHERE segment_id = $1",
              [firstJob.segment_id],
            )
          ).rows[0],
        );
        expect(BigInt(targetCount.count)).toBe(0n);

        const upgradeRequest = request({
          session_id: "running-session",
          start_user_message_id: "upgrade",
          end_user_message_id: "upgrade-end",
          messages: [{ role: "user", text: "upgrade" }],
        });
        const upgradeJob = await database.enqueue(upgradeRequest);
        const legacyClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(legacyClaim.id).toBe(upgradeJob.id);
        const deferredUpgrade = await database.enqueue(
          updateRequest(upgradeRequest, { projection_version: 1 }),
        );
        expect(deferredUpgrade.status).toBe("running");
        expect(deferredUpgrade.projection_version).toBe(0);
        expect(
          await completeResolution(
            database,
            legacyClaim,
            emptyPrepared(legacyClaim, "Legacy"),
          ),
        ).toBe(false);
        const upgradedJob = required(await database.getJob(upgradeJob.id));
        expect(upgradedJob.status).toBe("pending");
        expect(upgradedJob.projection_version).toBe(1);
        const upgradedClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(upgradedClaim.request.projection_version).toBe(1);
        const rollbackConnection = new Client({
          connectionString: databaseUrl(),
        });
        await rollbackConnection.connect();
        try {
          await rollbackConnection.query("BEGIN");
          await rollbackConnection.query("SELECT now()");
          await completeResolution(
            database,
            upgradedClaim,
            emptyPrepared(upgradedClaim, "Safe"),
          );
          expect(
            new Set(
              (await database.segmentSummaries("running-session")).map(
                (item) => item.summary,
              ),
            ),
          ).toEqual(new Set(["A after failed B", "Safe"]));
          await rollbackConnection.query(
            `
            UPDATE segments
            SET summary = 'unsafe rollback write', updated_at = now()
            WHERE id = $1
            `,
            [upgradeJob.segment_id],
          );
          await rollbackConnection.query("COMMIT");
        } catch (error) {
          await rollbackConnection.query("ROLLBACK");
          throw error;
        } finally {
          await rollbackConnection.end();
        }
        expect(
          new Set(
            (await database.segmentSummaries("running-session")).map(
              (item) => item.summary,
            ),
          ),
        ).toEqual(new Set(["A after failed B"]));
        const repaired = await database.enqueue(
          updateRequest(upgradeRequest, { projection_version: 1 }),
        );
        expect(repaired.status).toBe("pending");
      } finally {
        await database.close();
      }
    },
    20_000,
  );

  test.skipIf(!DATABASE_URL)(
    "filters prior summaries using each committed segment's current eligibility",
    async () => {
      const database = new Database(settings());
      await database.open();
      try {
        await truncate(database);
        const firstRequest = request({
          session_id: "summary-session",
          start_user_message_id: "first",
          end_user_message_id: "first-end",
          projection_version: 1,
          messages: [{ role: "user", text: "first" }],
        });
        const secondRequest = request({
          session_id: "summary-session",
          start_user_message_id: "second",
          end_user_message_id: "second-end",
          projection_version: 1,
          messages: [{ role: "user", text: "second" }],
        });
        for (const [source, summary] of [
          [firstRequest, "First summary"],
          [secondRequest, "Second summary"],
        ] as const) {
          await database.enqueue(source);
          const claim = required(
            await withClient(database, (client) =>
              database.claimOldestJob(client),
            ),
          );
          await completeResolution(
            database,
            claim,
            emptyPrepared(claim, summary),
          );
        }

        const firstSegmentId = segmentIdFor("summary-session", "first");
        const secondSegmentId = segmentIdFor("summary-session", "second");
        expect(
          await database.priorSummaries("summary-session", firstSegmentId),
        ).toEqual(["Second summary"]);

        const changedSecond = updateRequest(secondRequest, {
          messages: [{ role: "user", text: "second corrected" }],
        });
        await database.enqueue(changedSecond);
        expect(
          await database.priorSummaries("summary-session", firstSegmentId),
        ).toEqual([]);
        expect(
          (await database.segmentSummaries("summary-session")).map(
            (segment) => segment.id,
          ),
        ).toEqual([firstSegmentId]);
        let [summaries, boundaries, targets] =
          await database.sessionSegmentListing("summary-session");
        expect(summaries.map((summary) => summary.id)).toEqual([
          firstSegmentId,
        ]);
        expect(
          Object.fromEntries(
            boundaries.map((boundary) => [
              boundary.id,
              boundary.source_eligible,
            ]),
          ),
        ).toEqual({ [firstSegmentId]: true, [secondSegmentId]: false });
        expect(targets.map((target) => target.end_user_message_id)).toEqual([
          "second-end",
        ]);

        const futureSecond = updateRequest(secondRequest, {
          end_user_message_id: "second-future-end",
          messages: [
            { role: "user", text: "second" },
            { role: "assistant", text: "future" },
          ],
        });
        await database.enqueue(futureSecond);
        [, boundaries, targets] =
          await database.sessionSegmentListing("summary-session");
        const secondBoundary = required(
          boundaries.find((boundary) => boundary.id === secondSegmentId),
        );
        expect(secondBoundary.end_user_message_id).toBe("second-end");
        expect(secondBoundary.source_eligible).toBe(false);
        expect(targets.map((target) => target.end_user_message_id)).toEqual([
          "second-future-end",
        ]);

        await database.enqueue(secondRequest);
        const stagedSecond = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(
          await database.publishExtraction(stagedSecond, {
            summary: "Staged second summary",
            claims: [],
          }),
        ).toBe(true);
        expect(
          await database.priorSummaries("summary-session", firstSegmentId),
        ).toEqual(["Staged second summary"]);
        await database.pool.query(
          "UPDATE segments SET summary = 'corrupted' WHERE id = $1",
          [secondSegmentId],
        );
        expect(
          await database.priorSummaries("summary-session", firstSegmentId),
        ).toEqual(["Staged second summary"]);
        await database.pool.query(
          "UPDATE segment_targets SET summary_commit_fingerprint = repeat('0', 64) WHERE segment_id = $1",
          [secondSegmentId],
        );
        expect(
          await database.priorSummaries("summary-session", firstSegmentId),
        ).toEqual([]);
        expect(
          (await database.segmentSummaries("summary-session")).map(
            (segment) => segment.id,
          ),
        ).toEqual([firstSegmentId]);
        [summaries, boundaries] =
          await database.sessionSegmentListing("summary-session");
        expect(summaries.map((summary) => summary.id)).toEqual([
          firstSegmentId,
        ]);
        expect(
          Object.fromEntries(
            boundaries.map((boundary) => [
              boundary.id,
              boundary.source_eligible,
            ]),
          ),
        ).toEqual({ [firstSegmentId]: true, [secondSegmentId]: false });
      } finally {
        await database.close();
      }
    },
    15_000,
  );

  test.skipIf(!DATABASE_URL)(
    "supports v2 siblings, priority, staged summaries, retries, and stale fencing",
    async () => {
      const database = new Database(settings());
      await database.open();
      try {
        await truncate(database);
        const lowPriority = request({
          session_id: "v2-session",
          start_user_message_id: "turn",
          end_user_message_id: "turn",
          source_boundary_version: 2,
          start_source_message_id: "source-a",
          end_source_message_id: "source-b",
          projection_version: 1,
          messages: [{ role: "user", text: "first sibling" }],
        });
        const foreground = request({
          session_id: "v2-session",
          start_user_message_id: "turn",
          end_user_message_id: "turn",
          source_boundary_version: 2,
          start_source_message_id: "source-c",
          end_source_message_id: "source-d",
          projection_version: 1,
          processing_priority: 100,
          messages: [{ role: "assistant", text: "foreground sibling" }],
        });
        const lowJob = await database.enqueue(lowPriority);
        const foregroundJob = await database.enqueue(foreground);
        expect(lowJob.segment_id).not.toBe(foregroundJob.segment_id);
        expect(lowJob.start_user_message_id).toBe("turn");
        expect(foregroundJob).toMatchObject({
          source_boundary_version: 2,
          start_source_message_id: "source-c",
          end_source_message_id: "source-d",
          source_fingerprint: sourceFingerprint(foreground),
        });

        const foregroundClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(foregroundClaim.id).toBe(foregroundJob.id);
        const foregroundExtraction: ExtractionResult = {
          summary: "Foreground staged summary",
          claims: [],
        };
        expect(
          await database.publishExtraction(
            foregroundClaim,
            foregroundExtraction,
          ),
        ).toBe(true);
        let [summaries, boundaries, targets] =
          await database.sessionSegmentListing("v2-session");
        expect(summaries).toEqual([
          {
            id: foregroundJob.segment_id,
            start_user_message_id: "turn",
            end_user_message_id: "turn",
            source_boundary_version: 2,
            start_source_message_id: "source-c",
            end_source_message_id: "source-d",
            projection_version: 1,
            summary: "Foreground staged summary",
          },
        ]);
        expect(boundaries).toEqual([]);
        expect(targets).toHaveLength(2);
        expect(await database.getSegment(foregroundJob.segment_id)).toBeNull();

        expect(
          await database.finishFailedAttempt(
            foregroundClaim,
            "resolution failed",
            { retryAfterSeconds: null },
          ),
        ).toBe(true);
        expect(
          (await database.segmentSummaries("v2-session")).map(
            (summary) => summary.summary,
          ),
        ).toEqual(["Foreground staged summary"]);
        expect(
          required(await database.retryFailedJob(foregroundJob.id)).status,
        ).toBe("pending");
        const foregroundRetry = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(foregroundRetry.extractionResult).toEqual(foregroundExtraction);
        await database.commitResolution(
          foregroundRetry,
          foregroundExtraction,
          emptyPrepared(foregroundRetry, foregroundExtraction.summary),
        );

        const promoted = await database.enqueue(
          updateRequest(lowPriority, { processing_priority: 100 }),
        );
        expect(promoted.id).toBe(lowJob.id);
        const lowClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(lowClaim.id).toBe(lowJob.id);
        expect(lowClaim.request.processing_priority).toBe(100);
        const subjectId = randomUUID();
        const objectId = randomUUID();
        const lowExtraction: ExtractionResult = {
          summary: "First sibling committed",
          claims: [],
        };
        await database.publishExtraction(lowClaim, lowExtraction);
        await database.commitResolution(
          lowClaim,
          lowExtraction,
          preparedSegment(lowClaim, {
            endId: "turn",
            summary: lowExtraction.summary,
            subjectId,
            objectId,
            entitiesAreNew: true,
          }),
        );
        const committed = required(
          await database.getSegment(lowJob.segment_id),
        );
        expect(committed.claims).toHaveLength(2);

        const advanced = updateRequest(lowPriority, {
          end_source_message_id: "source-b2",
          messages: [{ role: "user", text: "advanced sibling" }],
        });
        const advancedJob = await database.enqueue(advanced);
        expect(advancedJob.segment_id).toBe(lowJob.segment_id);
        expect(advancedJob.id).not.toBe(lowJob.id);
        expect(
          (await database.segmentSummaries("v2-session")).some(
            (summary) => summary.id === lowJob.segment_id,
          ),
        ).toBe(false);
        expect(
          required(await database.getSegment(lowJob.segment_id)).claims,
        ).toHaveLength(2);
        const advancedClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        const advancedExtraction: ExtractionResult = {
          summary: "Advanced staged summary",
          claims: [],
        };
        expect(
          await database.publishExtraction(advancedClaim, advancedExtraction),
        ).toBe(true);
        const advancedDuplicate = await database.enqueue(
          updateRequest(advanced, { processing_priority: 100 }),
        );
        expect(advancedDuplicate).toMatchObject({
          id: advancedJob.id,
          status: "running",
        });
        const stagedIdentity = required(
          (
            await database.pool.query<
              QueryResultRow & {
                source_generation: string;
                processing_priority: number;
                extraction_result: unknown;
              }
            >(
              `
              SELECT source_generation, processing_priority, extraction_result
              FROM segment_targets
              WHERE segment_id = $1
              `,
              [advancedJob.segment_id],
            )
          ).rows[0],
        );
        expect(BigInt(stagedIdentity.source_generation)).toBe(
          advancedClaim.sourceGeneration,
        );
        expect(stagedIdentity.processing_priority).toBe(100);
        expect(stagedIdentity.extraction_result).toEqual(advancedExtraction);
        summaries = await database.segmentSummaries("v2-session");
        expect(
          summaries.find((summary) => summary.id === lowJob.segment_id)
            ?.summary,
        ).toBe("Advanced staged summary");
        expect(
          required(await database.getSegment(lowJob.segment_id)).summary,
        ).toBe("First sibling committed");

        const newest = updateRequest(advanced, {
          messages: [{ role: "user", text: "newest corrected source" }],
        });
        await database.enqueue(newest);
        expect(
          await database.publishExtraction(advancedClaim, advancedExtraction),
        ).toBe(false);
        await expect(
          database.commitResolution(
            advancedClaim,
            advancedExtraction,
            emptyPrepared(advancedClaim, advancedExtraction.summary),
          ),
        ).rejects.toThrow("lease changed");
        expect(
          required(await database.getSegment(lowJob.segment_id)).claims,
        ).toHaveLength(2);

        const newestClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        const newestExtraction: ExtractionResult = {
          summary: "Newest staged summary",
          claims: [],
        };
        await database.publishExtraction(newestClaim, newestExtraction);
        expect(
          required(await database.getSegment(lowJob.segment_id)).claims,
        ).toHaveLength(2);
        await database.finishFailedAttempt(newestClaim, "terminal resolution", {
          retryAfterSeconds: null,
        });
        [summaries, boundaries, targets] =
          await database.sessionSegmentListing("v2-session");
        expect(
          summaries.find((summary) => summary.id === lowJob.segment_id)
            ?.summary,
        ).toBe("Newest staged summary");
        expect(
          targets.find((target) => target.id === lowJob.segment_id)?.status,
        ).toBe("failed");
        expect(
          boundaries.find((boundary) => boundary.id === lowJob.segment_id)
            ?.source_eligible,
        ).toBe(false);
      } finally {
        await database.close();
      }
    },
    20_000,
  );

  test.skipIf(!DATABASE_URL)(
    "records checksummed migrations once and matches JavaScript fingerprints",
    async () => {
      const database = new Database(settings());
      await database.open();
      try {
        await truncate(database);
        const source = request({
          session_id: "unicode-会話",
          start_user_message_id: "turn-😀",
          end_user_message_id: "turn-😀",
          source_boundary_version: 2,
          start_source_message_id: "開始-é",
          end_source_message_id: "終了-😀",
          projection_version: 1,
          messages: [
            { role: "user", text: "Straße 😀" },
            { role: "assistant", text: "東京" },
          ],
        });
        const job = await database.enqueue(source);
        const claim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        const extraction: ExtractionResult = {
          summary: "Unicode summary 😀",
          claims: [],
        };
        await database.publishExtraction(claim, extraction);
        const before = required(
          (
            await database.pool.query<
              QueryResultRow & {
                status: string;
                lease_id: string;
                extraction_result: unknown;
                source_fingerprint: string;
              }
            >(
              `
              SELECT jobs.status, jobs.lease_id, targets.extraction_result,
                     targets.source_fingerprint
              FROM extraction_jobs AS jobs
              JOIN segment_targets AS targets ON targets.job_id = jobs.id
              WHERE jobs.id = $1
              `,
              [job.id],
            )
          ).rows[0],
        );
        await database.applyMigrations(MIGRATIONS_DIR);
        const after = required(
          (
            await database.pool.query<
              QueryResultRow & {
                status: string;
                lease_id: string;
                extraction_result: unknown;
                source_fingerprint: string;
              }
            >(
              `
              SELECT jobs.status, jobs.lease_id, targets.extraction_result,
                     targets.source_fingerprint
              FROM extraction_jobs AS jobs
              JOIN segment_targets AS targets ON targets.job_id = jobs.id
              WHERE jobs.id = $1
              `,
              [job.id],
            )
          ).rows[0],
        );
        expect(after).toEqual(before);

        const ledger = (
          await database.pool.query<
            QueryResultRow & { name: string; checksum: string }
          >(
            "SELECT name, checksum FROM reflection_schema_migrations ORDER BY name",
          )
        ).rows;
        expect(ledger.map((row) => row.name)).toEqual([
          "001_init.sql",
          "002_audit_hardening.sql",
          "003_claim_confidence_and_payload_cleanup.sql",
          "004_projection_safety.sql",
          "005_mutable_source_snapshots.sql",
          "006_canonical_source_spans.sql",
          "007_superseded_job_status.sql",
        ]);
        expect(
          ledger.every((row) => /^[0-9a-f]{64}$/u.test(row.checksum)),
        ).toBe(true);

        const sqlFingerprints = required(
          (
            await database.pool.query<
              QueryResultRow & {
                source_fingerprint: string;
                projection_fingerprint: string;
              }
            >(
              `
              SELECT reflection_source_fingerprint(
                         $1, $2, $3, 2, $4, $5, $6::jsonb
                     ) AS source_fingerprint,
                     reflection_projection_fingerprint(
                         $7::uuid, 2, $3, $5, $8, $9
                     ) AS projection_fingerprint
              `,
              [
                source.session_id,
                source.start_user_message_id,
                source.end_user_message_id,
                source.start_source_message_id,
                source.end_source_message_id,
                JSON.stringify(source),
                job.segment_id,
                extraction.summary,
                source.projection_version,
              ],
            )
          ).rows[0],
        );
        expect(sqlFingerprints.source_fingerprint).toBe(
          sourceFingerprint(source),
        );
        expect(sqlFingerprints.projection_fingerprint).toBe(
          projectionFingerprintForBoundary(
            job.segment_id,
            {
              sourceBoundaryVersion: 2,
              endUserMessageId: source.end_user_message_id,
              endSourceMessageId: required(source.end_source_message_id),
            },
            extraction.summary,
            source.projection_version,
          ),
        );
        expect(job.segment_id).toBe(segmentIdForRequest(source));

        const originalChecksum = required(
          ledger.find((row) => row.name === "001_init.sql"),
        ).checksum;
        await database.pool.query(
          "UPDATE reflection_schema_migrations SET checksum = repeat('0', 64) WHERE name = '001_init.sql'",
        );
        await expect(database.applyMigrations(MIGRATIONS_DIR)).rejects.toThrow(
          "migration checksum mismatch",
        );
        await database.pool.query(
          "UPDATE reflection_schema_migrations SET checksum = $1 WHERE name = '001_init.sql'",
          [originalChecksum],
        );
      } finally {
        await database.close();
      }
    },
    15_000,
  );

  test.skipIf(!DATABASE_URL)(
    "serializes concurrent target mutations without wedging or deadlocking",
    async () => {
      const database = new Database(settings());
      await database.open();
      try {
        await truncate(database);
        const firstRequest = request({
          session_id: "concurrent-session",
          start_user_message_id: "start",
          end_user_message_id: "A",
          projection_version: 1,
          messages: [{ role: "user", text: "A" }],
        });
        await database.enqueue(firstRequest);
        const recoveryConnection = await database.pool.connect();
        let running: ClaimedJob;
        let changedRequest: SegmentCreate;
        try {
          running = required(await database.claimOldestJob(recoveryConnection));
          changedRequest = updateRequest(firstRequest, {
            messages: [{ role: "user", text: "A corrected" }],
          });
          const [recovered, changed] = await within(
            Promise.all([
              database.recoverRunningJobs(recoveryConnection),
              database.enqueue(changedRequest),
            ]),
            5_000,
          );
          expect(recovered).toBe(1);
          expect(changed.id).toBe(running.id);
        } finally {
          recoveryConnection.release();
        }

        const state = required(
          (
            await database.pool.query<
              QueryResultRow & {
                status: string;
                attempts: number;
                source_fingerprint: string;
                target_fingerprint: string;
              }
            >(
              `
              SELECT jobs.status, jobs.attempts, jobs.source_fingerprint,
                     targets.source_fingerprint AS target_fingerprint
              FROM segment_targets AS targets
              JOIN extraction_jobs AS jobs ON jobs.id = targets.job_id
              WHERE targets.segment_id = $1
              `,
              [running.segmentId],
            )
          ).rows[0],
        );
        const changedClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(state.status).toBe("pending");
        expect(state.attempts).toBe(0);
        expect(state.source_fingerprint).toBe(state.target_fingerprint);
        expect(changedClaim.request).toEqual(changedRequest);
        expect(changedClaim.attempts).toBe(1);

        const nextRequest = updateRequest(changedRequest, {
          end_user_message_id: "B",
        });
        const [committed, nextJob] = await within(
          Promise.all([
            completeResolution(
              database,
              changedClaim,
              emptyPrepared(changedClaim, "Changed A"),
            ),
            database.enqueue(nextRequest),
          ]),
          5_000,
        );
        expect(typeof committed).toBe("boolean");
        const nextClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(nextClaim.id).toBe(nextJob.id);
        expect(nextClaim.request).toEqual(nextRequest);

        const finalRequest = updateRequest(nextRequest, {
          end_user_message_id: "C",
        });
        const [failed, finalJob] = await within(
          Promise.all([
            database.finishFailedAttempt(
              nextClaim,
              "terminal concurrent failure",
              { retryAfterSeconds: null },
            ),
            database.enqueue(finalRequest),
          ]),
          5_000,
        );
        expect(failed).toBe(true);
        const finalState = required(
          (
            await database.pool.query<
              QueryResultRow & { id: string; status: string }
            >(
              `
              SELECT jobs.id, jobs.status
              FROM segment_targets AS targets
              JOIN extraction_jobs AS jobs ON jobs.id = targets.job_id
              WHERE targets.segment_id = $1
              `,
              [running.segmentId],
            )
          ).rows[0],
        );
        const runningCount = required(
          (
            await database.pool.query<{ count: string } & QueryResultRow>(
              `
              SELECT count(*) AS count
              FROM extraction_jobs
              WHERE segment_id = $1 AND status = 'running'
              `,
              [running.segmentId],
            )
          ).rows[0],
        );
        expect(BigInt(finalState.id)).toBe(BigInt(finalJob.id));
        expect(finalState.status).toBe("pending");
        expect(BigInt(runningCount.count)).toBe(0n);
      } finally {
        await database.close();
      }
    },
    20_000,
  );

  test.skipIf(!DATABASE_URL)(
    "synchronizes deferred targets before recovering running jobs during migration",
    async () => {
      const connection = new Client({ connectionString: databaseUrl() });
      await connection.connect();
      let runningJobId: string;
      let changedFailedJobId: string;
      let unchangedFailedJobId: string;
      const originalLease = randomUUID();
      const oldRequest = request({
        session_id: "deferred-migration",
        start_user_message_id: "start",
        end_user_message_id: "end",
        messages: [{ role: "user", text: "old source" }],
      });
      const latestRequest = request({
        session_id: "deferred-migration",
        start_user_message_id: "start",
        end_user_message_id: "end",
        projection_version: 1,
        messages: [{ role: "user", text: "latest source" }],
      });
      const changedFailedOldRequest = request({
        session_id: "changed-failed-migration",
        start_user_message_id: "start",
        end_user_message_id: "end",
        messages: [{ role: "user", text: "old failed source" }],
      });
      const changedFailedLatestRequest = request({
        session_id: "changed-failed-migration",
        start_user_message_id: "start",
        end_user_message_id: "end",
        projection_version: 1,
        messages: [{ role: "user", text: "latest failed source" }],
      });
      const unchangedFailedRequest = request({
        session_id: "unchanged-failed-migration",
        start_user_message_id: "start",
        end_user_message_id: "end",
        messages: [{ role: "user", text: "unchanged failed source" }],
      });
      try {
        await connection.query(`
          DROP TABLE IF EXISTS reflection_schema_migrations, segment_targets,
              claims, entity_aliases, entities, segments, extraction_jobs CASCADE;
          DROP FUNCTION IF EXISTS reflection_source_fingerprint(TEXT, TEXT, TEXT, JSONB);
        `);
        for (const migrationName of [
          "001_init.sql",
          "002_audit_hardening.sql",
          "003_claim_confidence_and_payload_cleanup.sql",
          "004_projection_safety.sql",
        ]) {
          const sql = await readFile(
            `${MIGRATIONS_DIR}/${migrationName}`,
            "utf8",
          );
          await connection.query("BEGIN");
          try {
            await connection.query(sql);
            await connection.query("COMMIT");
          } catch (error) {
            await connection.query("ROLLBACK");
            throw error;
          }
        }

        const segmentId = segmentIdFor("deferred-migration", "start");
        runningJobId = required(
          (
            await connection.query<{ id: string } & QueryResultRow>(
              `
              INSERT INTO extraction_jobs (
                  segment_id, session_id, start_user_message_id, end_user_message_id,
                  projection_version, payload, status, attempts, lease_id, started_at
              )
              VALUES ($1, $2, $3, $4, 0, $5::jsonb, 'running', 2, $6, now())
              RETURNING id
              `,
              [
                segmentId,
                oldRequest.session_id,
                oldRequest.start_user_message_id,
                oldRequest.end_user_message_id,
                JSON.stringify(oldRequest),
                originalLease,
              ],
            )
          ).rows[0],
        ).id;
        await connection.query(
          `
          INSERT INTO segment_targets (
              segment_id, job_id, end_user_message_id, projection_version, payload
          )
          VALUES ($1, $2, $3, 1, $4::jsonb)
          `,
          [
            segmentId,
            runningJobId,
            latestRequest.end_user_message_id,
            JSON.stringify(latestRequest),
          ],
        );

        const changedFailedSegmentId = segmentIdFor(
          "changed-failed-migration",
          "start",
        );
        changedFailedJobId = required(
          (
            await connection.query<{ id: string } & QueryResultRow>(
              `
              INSERT INTO extraction_jobs (
                  segment_id, session_id, start_user_message_id, end_user_message_id,
                  projection_version, payload, status, attempts, error,
                  started_at, finished_at, next_attempt_at
              )
              VALUES (
                  $1, $2, $3, $4, 0, $5::jsonb, 'failed', 3, 'changed failure',
                  '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z',
                  '2026-01-03T00:00:00Z'
              )
              RETURNING id
              `,
              [
                changedFailedSegmentId,
                changedFailedOldRequest.session_id,
                changedFailedOldRequest.start_user_message_id,
                changedFailedOldRequest.end_user_message_id,
                JSON.stringify(changedFailedOldRequest),
              ],
            )
          ).rows[0],
        ).id;
        await connection.query(
          `
          INSERT INTO segment_targets (
              segment_id, job_id, end_user_message_id, projection_version, payload
          )
          VALUES ($1, $2, $3, 1, $4::jsonb)
          `,
          [
            changedFailedSegmentId,
            changedFailedJobId,
            changedFailedLatestRequest.end_user_message_id,
            JSON.stringify(changedFailedLatestRequest),
          ],
        );

        const unchangedFailedSegmentId = segmentIdFor(
          "unchanged-failed-migration",
          "start",
        );
        unchangedFailedJobId = required(
          (
            await connection.query<{ id: string } & QueryResultRow>(
              `
              INSERT INTO extraction_jobs (
                  segment_id, session_id, start_user_message_id, end_user_message_id,
                  projection_version, payload, status, attempts, error,
                  started_at, finished_at, next_attempt_at
              )
              VALUES (
                  $1, $2, $3, $4, 0, $5::jsonb, 'failed', 4, 'unchanged failure',
                  '2026-02-01T00:00:00Z', '2026-02-02T00:00:00Z',
                  '2026-02-03T00:00:00Z'
              )
              RETURNING id
              `,
              [
                unchangedFailedSegmentId,
                unchangedFailedRequest.session_id,
                unchangedFailedRequest.start_user_message_id,
                unchangedFailedRequest.end_user_message_id,
                JSON.stringify(unchangedFailedRequest),
              ],
            )
          ).rows[0],
        ).id;
        await connection.query(
          `
          INSERT INTO segment_targets (
              segment_id, job_id, end_user_message_id, projection_version, payload
          )
          VALUES ($1, $2, $3, 0, $4::jsonb)
          `,
          [
            unchangedFailedSegmentId,
            unchangedFailedJobId,
            unchangedFailedRequest.end_user_message_id,
            JSON.stringify(unchangedFailedRequest),
          ],
        );
      } finally {
        await connection.end();
      }

      const database = new Database(settings());
      await database.open();
      try {
        await database.applyMigrations(MIGRATIONS_DIR);
        const identity = required(
          (
            await database.pool.query<
              QueryResultRow & {
                status: string;
                attempts: number;
                lease_id: string | null;
                projection_version: number;
                payload: unknown;
                source_generation: string;
                source_fingerprint: string;
                target_generation: string;
                target_fingerprint: string;
              }
            >(
              `
              SELECT jobs.status, jobs.attempts, jobs.lease_id, jobs.projection_version,
                     jobs.payload, jobs.source_generation, jobs.source_fingerprint,
                     targets.source_generation AS target_generation,
                     targets.source_fingerprint AS target_fingerprint
              FROM extraction_jobs AS jobs
              JOIN segment_targets AS targets ON targets.job_id = jobs.id
              WHERE jobs.id = $1
              `,
              [runningJobId],
            )
          ).rows[0],
        );
        const failedStates = new Map(
          (
            await database.pool.query<
              QueryResultRow & {
                id: string;
                status: string;
                attempts: number;
                error: string | null;
                lease_id: string | null;
                started_at: Date | null;
                finished_at: Date | null;
                next_attempt_at: Date;
                projection_version: number;
                payload: unknown;
                source_generation: string;
                source_fingerprint: string;
              }
            >(
              `
              SELECT id, status, attempts, error, lease_id, started_at, finished_at,
                     next_attempt_at, projection_version, payload,
                     source_generation, source_fingerprint
              FROM extraction_jobs
              WHERE id = ANY($1::bigint[])
              `,
              [[changedFailedJobId, unchangedFailedJobId]],
            )
          ).rows.map((row) => [row.id, row]),
        );
        expect(identity.status).toBe("running");
        expect(identity.lease_id).toBe(originalLease);
        expect(identity.attempts).toBe(0);
        expect(identity.projection_version).toBe(1);
        expect(identity.payload).toEqual(latestRequest);
        expect(identity.source_generation).toBe(identity.target_generation);
        expect(identity.source_fingerprint).toBe(identity.target_fingerprint);
        expect(identity.source_fingerprint).toBe(
          sourceFingerprint(latestRequest),
        );

        const changedFailedState = required(
          failedStates.get(changedFailedJobId),
        );
        expect(changedFailedState.status).toBe("pending");
        expect(changedFailedState.attempts).toBe(0);
        expect(changedFailedState.error).toBeNull();
        expect(changedFailedState.lease_id).toBeNull();
        expect(changedFailedState.started_at).toBeNull();
        expect(changedFailedState.finished_at).toBeNull();
        expect(
          Date.parse(String(changedFailedState.next_attempt_at)),
        ).toBeGreaterThan(Date.parse("2026-01-03T00:00:00Z"));
        expect(changedFailedState.projection_version).toBe(1);
        expect(changedFailedState.payload).toEqual(changedFailedLatestRequest);
        expect(changedFailedState.source_fingerprint).toBe(
          sourceFingerprint(changedFailedLatestRequest),
        );

        const unchangedFailedState = required(
          failedStates.get(unchangedFailedJobId),
        );
        expect(unchangedFailedState.status).toBe("failed");
        expect(unchangedFailedState.attempts).toBe(4);
        expect(unchangedFailedState.error).toBe("unchanged failure");
        expect(unchangedFailedState.lease_id).toBeNull();
        expect(unchangedFailedState.started_at).not.toBeNull();
        expect(unchangedFailedState.finished_at).not.toBeNull();
        expect(
          new Date(String(unchangedFailedState.next_attempt_at)).toISOString(),
        ).toBe("2026-02-03T00:00:00.000Z");
        expect(unchangedFailedState.projection_version).toBe(0);
        expect(unchangedFailedState.payload).toEqual(unchangedFailedRequest);
        expect(unchangedFailedState.source_fingerprint).toBe(
          sourceFingerprint(unchangedFailedRequest),
        );

        const [recovered, firstClaim, secondClaim] = await withClient(
          database,
          async (client) => [
            await database.recoverRunningJobs(client),
            await database.claimOldestJob(client),
            await database.claimOldestJob(client),
          ],
        );
        expect(recovered).toBe(1);
        const claims = new Map(
          [required(firstClaim), required(secondClaim)].map((claim) => [
            claim.id,
            claim,
          ]),
        );
        const claimed = required(claims.get(Number(runningJobId)));
        expect(claimed.request).toEqual(latestRequest);
        expect(claimed.sourceGeneration).toBe(
          BigInt(identity.target_generation),
        );
        expect(claimed.sourceFingerprint).toBe(identity.target_fingerprint);
        expect(claimed.attempts).toBe(1);
        expect(claimed.leaseId).not.toBe(originalLease);
        const changedFailedClaim = required(
          claims.get(Number(changedFailedJobId)),
        );
        expect(changedFailedClaim.request).toEqual(changedFailedLatestRequest);
        expect(changedFailedClaim.attempts).toBe(1);
        const unchangedAfterClaims = required(
          await database.getJob(Number(unchangedFailedJobId)),
        );
        expect(unchangedAfterClaims.status).toBe("failed");
        expect(unchangedAfterClaims.attempts).toBe(4);
        expect(unchangedAfterClaims.error).toBe("unchanged failure");
      } finally {
        await database.close();
      }
    },
    20_000,
  );

  test.skipIf(!DATABASE_URL)(
    "migrates the legacy schema in place and preserves historical target precedence",
    async () => {
      const connection = new Client({ connectionString: databaseUrl() });
      await connection.connect();
      try {
        await connection.query(`
          DROP TABLE IF EXISTS reflection_schema_migrations, segment_targets,
              claims, entity_aliases, entities, segments, extraction_jobs CASCADE;
          CREATE EXTENSION IF NOT EXISTS vector;
          CREATE EXTENSION IF NOT EXISTS pg_trgm;
          CREATE TABLE extraction_jobs (
              id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
              segment_id UUID NOT NULL UNIQUE,
              session_id TEXT NOT NULL,
              start_user_message_id TEXT NOT NULL,
              end_user_message_id TEXT NOT NULL,
              payload JSONB NOT NULL,
              status TEXT NOT NULL DEFAULT 'pending',
              attempts INTEGER NOT NULL DEFAULT 0,
              error TEXT,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              started_at TIMESTAMPTZ,
              finished_at TIMESTAMPTZ,
              UNIQUE (session_id, start_user_message_id, end_user_message_id)
          );
          CREATE TABLE segments (
              id UUID PRIMARY KEY,
              session_id TEXT NOT NULL,
              start_user_message_id TEXT NOT NULL,
              end_user_message_id TEXT NOT NULL,
              summary VARCHAR(1000) NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              UNIQUE (session_id, start_user_message_id)
          );
          CREATE TABLE entities (
              id UUID PRIMARY KEY,
              canonical_name TEXT NOT NULL,
              normalized_name TEXT NOT NULL,
              embedding vector(1024) NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE TABLE entity_aliases (
              entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
              alias TEXT NOT NULL,
              normalized_alias TEXT NOT NULL,
              PRIMARY KEY (entity_id, normalized_alias)
          );
          CREATE TABLE claims (
              id UUID PRIMARY KEY,
              segment_id UUID NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
              subject_text TEXT NOT NULL,
              subject_entity_id UUID NOT NULL REFERENCES entities(id),
              predicate TEXT NOT NULL,
              object_text TEXT NOT NULL,
              object_entity_id UUID NOT NULL REFERENCES entities(id),
              equivalence_key CHAR(64) NOT NULL,
              embedding vector(1024) NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          INSERT INTO extraction_jobs (
              segment_id, session_id, start_user_message_id, end_user_message_id, payload,
              status, started_at
          ) VALUES (
              '00000000-0000-4000-8000-000000000001', 'legacy', 'start', 'end', '{}',
              'running', now()
          );
          INSERT INTO extraction_jobs (
              segment_id, session_id, start_user_message_id, end_user_message_id, payload,
              status, finished_at
          ) VALUES (
              '00000000-0000-0000-0000-000000000006',
              'legacy-succeeded', 'start', 'end', '{"messages":["private"]}',
              'succeeded', now()
          );
          INSERT INTO segments (
              id, session_id, start_user_message_id, end_user_message_id, summary
          ) VALUES (
              '00000000-0000-0000-0000-000000000002', 'legacy', 'start', 'end', 'summary'
          );
          INSERT INTO entities (id, canonical_name, normalized_name, embedding)
          VALUES
              (
                  '00000000-0000-0000-0000-000000000003', 'Subject', 'subject',
                  array_fill(0.01::real, ARRAY[1024])::vector
              ),
              (
                  '00000000-0000-0000-0000-000000000004', 'Object', 'object',
                  array_fill(0.01::real, ARRAY[1024])::vector
              );
          INSERT INTO claims (
              id, segment_id, subject_text, subject_entity_id, predicate, object_text,
              object_entity_id, equivalence_key, embedding
          ) VALUES (
              '00000000-0000-0000-0000-000000000005',
              '00000000-0000-0000-0000-000000000002',
              'Subject', '00000000-0000-0000-0000-000000000003', 'uses', 'Object',
              '00000000-0000-0000-0000-000000000004', repeat('a', 64),
              array_fill(0.01::real, ARRAY[1024])::vector
          );
        `);
      } finally {
        await connection.end();
      }

      const database = new Database(settings());
      await database.open();
      try {
        const migratedJob = required(
          (
            await database.pool.query<
              QueryResultRow & {
                status: string;
                lease_id: string | null;
                next_attempt_at: Date | null;
              }
            >(
              "SELECT status, lease_id, next_attempt_at FROM extraction_jobs WHERE id = 1",
            )
          ).rows[0],
        );
        const succeeded = required(
          (
            await database.pool.query<{ payload: unknown } & QueryResultRow>(
              "SELECT payload FROM extraction_jobs WHERE status = 'succeeded'",
            )
          ).rows[0],
        );
        const entities = (
          await database.pool.query<{ description: string } & QueryResultRow>(
            "SELECT description FROM entities ORDER BY canonical_name",
          )
        ).rows;
        const migratedClaim = required(
          (
            await database.pool.query<
              QueryResultRow & {
                object_entity_text: string | null;
                object_entity_id: string | null;
                object_value: string | null;
                confidence: number;
              }
            >(`
              SELECT object_entity_text, object_entity_id, object_value, confidence
              FROM claims
            `)
          ).rows[0],
        );
        const oldColumn = required(
          (
            await database.pool.query<{ count: string } & QueryResultRow>(`
              SELECT count(*) AS count
              FROM information_schema.columns
              WHERE table_name = 'claims' AND column_name = 'object_text'
            `)
          ).rows[0],
        );
        const payloadColumn = required(
          (
            await database.pool.query<
              { is_nullable: string } & QueryResultRow
            >(`
              SELECT is_nullable
              FROM information_schema.columns
              WHERE table_name = 'extraction_jobs' AND column_name = 'payload'
            `)
          ).rows[0],
        );
        expect(migratedJob.status).toBe("pending");
        expect(migratedJob.lease_id).toBeNull();
        expect(migratedJob.next_attempt_at).not.toBeNull();
        expect(succeeded.payload).toBeNull();
        expect(new Set(entities.map((row) => row.description))).toEqual(
          new Set(["Entity: Object", "Entity: Subject"]),
        );
        expect(migratedClaim.object_entity_text).toBe("Object");
        expect(migratedClaim.object_entity_id).not.toBeNull();
        expect(migratedClaim.object_value).toBeNull();
        expect(migratedClaim.confidence).toBe(1);
        expect(BigInt(oldColumn.count)).toBe(0n);
        expect(payloadColumn.is_nullable).toBe("YES");

        await database.pool.query(
          "UPDATE extraction_jobs SET payload = NULL WHERE id = 1",
        );
        expect(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        ).toBeNull();
        const invalidPayloadJob = required(await database.getJob(1));
        expect(invalidPayloadJob.status).toBe("failed");
        expect(invalidPayloadJob.error).toBe(
          "invalid persisted payload: payload is null",
        );
        const [, legacyBoundaries] =
          await database.sessionSegmentListing("legacy");
        expect(legacyBoundaries).toHaveLength(1);
        expect(required(legacyBoundaries[0]).source_fingerprint).toBeNull();

        await database.pool.query(`
          INSERT INTO extraction_jobs (
              segment_id, session_id, start_user_message_id, end_user_message_id, payload
          ) VALUES (
              '00000000-0000-4000-8000-000000000001',
              'legacy', 'start', 'new-end', '{}'
          )
        `);
        const sameSegmentCount = required(
          (
            await database.pool.query<{ count: string } & QueryResultRow>(`
              SELECT count(*) AS count FROM extraction_jobs
              WHERE segment_id = '00000000-0000-4000-8000-000000000001'
            `)
          ).rows[0],
        );
        expect(BigInt(sameSegmentCount.count)).toBe(2n);

        await database.pool.query(`
          DELETE FROM reflection_schema_migrations
          WHERE name IN (
              '005_mutable_source_snapshots.sql',
              '006_canonical_source_spans.sql'
          )
        `);

        const migrationSegmentId = segmentIdFor("migration-session", "start");
        const oldRequest = request({
          session_id: "migration-session",
          start_user_message_id: "start",
          end_user_message_id: "old-end",
          messages: [{ role: "user", text: "old" }],
        });
        const latestRequest = updateRequest(oldRequest, {
          end_user_message_id: "latest-end",
        });
        const failedSegmentId = segmentIdFor(
          "failed-migration-session",
          "start",
        );
        const failedRequest = request({
          session_id: "failed-migration-session",
          start_user_message_id: "start",
          end_user_message_id: "failed-end",
          messages: [{ role: "user", text: "failed retained source" }],
        });
        const precedenceSegmentId = segmentIdFor("precedence-session", "start");
        const activeRequest = request({
          session_id: "precedence-session",
          start_user_message_id: "start",
          end_user_message_id: "active-end",
          messages: [{ role: "user", text: "active source" }],
        });
        const newerFailedRequest = request({
          session_id: "precedence-session",
          start_user_message_id: "start",
          end_user_message_id: "newer-failed-end",
          messages: [{ role: "user", text: "newer failed source" }],
        });
        const forwardSegmentId = segmentIdFor("forward-history", "start");
        const oldFailedForwardRequest = request({
          session_id: "forward-history",
          start_user_message_id: "start",
          end_user_message_id: "old-failed-end",
          messages: [{ role: "user", text: "old failed snapshot" }],
        });
        const rewindSegmentId = segmentIdFor("rewind-history", "start");
        const failedNewRequest = request({
          session_id: "rewind-history",
          start_user_message_id: "start",
          end_user_message_id: "failed-new-end",
          projection_version: 1,
          messages: [{ role: "user", text: "failed forward snapshot" }],
        });
        const v0TargetSegmentId = segmentIdFor("v0-target-history", "start");
        const v0TargetRequest = request({
          session_id: "v0-target-history",
          start_user_message_id: "start",
          end_user_message_id: "v0-target-end",
          messages: [{ role: "user", text: "failed v0 target" }],
        });

        for (const source of [oldRequest, latestRequest]) {
          await database.pool.query(
            `
            INSERT INTO extraction_jobs (
                segment_id, session_id, start_user_message_id, end_user_message_id,
                projection_version, payload, source_generation, source_fingerprint
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, 0, NULL)
            `,
            [
              migrationSegmentId,
              source.session_id,
              source.start_user_message_id,
              source.end_user_message_id,
              source.projection_version,
              JSON.stringify(source),
            ],
          );
        }
        for (const [segmentId, source] of [
          [failedSegmentId, failedRequest],
          [precedenceSegmentId, newerFailedRequest],
        ] as const) {
          await database.pool.query(
            `
            INSERT INTO extraction_jobs (
                segment_id, session_id, start_user_message_id, end_user_message_id,
                projection_version, payload, status, attempts, error, finished_at,
                source_generation, source_fingerprint
            )
            VALUES (
                $1, $2, $3, $4, $5, $6::jsonb, 'failed', 3,
                'legacy failure', now(), 0, NULL
            )
            `,
            [
              segmentId,
              source.session_id,
              source.start_user_message_id,
              source.end_user_message_id,
              source.projection_version,
              JSON.stringify(source),
            ],
          );
        }
        await database.pool.query(
          `
          INSERT INTO extraction_jobs (
              segment_id, session_id, start_user_message_id, end_user_message_id,
              projection_version, payload, source_generation, source_fingerprint
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, 0, NULL)
          `,
          [
            precedenceSegmentId,
            activeRequest.session_id,
            activeRequest.start_user_message_id,
            activeRequest.end_user_message_id,
            activeRequest.projection_version,
            JSON.stringify(activeRequest),
          ],
        );

        for (const segment of [
          {
            id: forwardSegmentId,
            sessionId: "forward-history",
            endId: "forward-committed-end",
            summary: "Later equal-version forward commit",
            projectionVersion: 0,
            timestamp: "2026-01-02T00:00:00Z",
          },
          {
            id: rewindSegmentId,
            sessionId: "rewind-history",
            endId: "rewind-end",
            summary: "Later v1 rewind commit",
            projectionVersion: 1,
            timestamp: "2026-01-03T00:00:00Z",
          },
          {
            id: v0TargetSegmentId,
            sessionId: "v0-target-history",
            endId: "committed-v1-end",
            summary: "Committed v1 summary",
            projectionVersion: 1,
            timestamp: "2026-01-01T00:00:00Z",
          },
        ]) {
          await database.pool.query(
            `
            INSERT INTO segments (
                id, session_id, start_user_message_id, end_user_message_id, summary,
                projection_version, projection_commit_fingerprint, created_at, updated_at
            )
            VALUES (
                $1, $2, 'start', $3, $4::text, $5,
                reflection_projection_fingerprint($1, $3, $4::text, $5), $6, $6
            )
            `,
            [
              segment.id,
              segment.sessionId,
              segment.endId,
              segment.summary,
              segment.projectionVersion,
              segment.timestamp,
            ],
          );
        }

        const historicalJobs: ReadonlyArray<{
          segmentId: string;
          source: SegmentCreate;
          status: "failed" | "succeeded";
          attempts: number;
          error: string | null;
          finishedAt: string;
          payload: boolean;
        }> = [
          {
            segmentId: forwardSegmentId,
            source: oldFailedForwardRequest,
            status: "failed",
            attempts: 3,
            error: "old forward failure",
            finishedAt: "2026-01-01T00:00:00Z",
            payload: true,
          },
          {
            segmentId: forwardSegmentId,
            source: request({
              session_id: "forward-history",
              start_user_message_id: "start",
              end_user_message_id: "forward-committed-end",
              messages: [{ role: "user", text: "unused" }],
            }),
            status: "succeeded",
            attempts: 1,
            error: null,
            finishedAt: "2026-01-02T00:00:00Z",
            payload: false,
          },
          {
            segmentId: rewindSegmentId,
            source: request({
              session_id: "rewind-history",
              start_user_message_id: "start",
              end_user_message_id: "rewind-end",
              projection_version: 1,
              messages: [{ role: "user", text: "unused" }],
            }),
            status: "succeeded",
            attempts: 1,
            error: null,
            finishedAt: "2026-01-03T00:00:00Z",
            payload: false,
          },
          {
            segmentId: rewindSegmentId,
            source: failedNewRequest,
            status: "failed",
            attempts: 3,
            error: "failed newer boundary",
            finishedAt: "2026-01-02T00:00:00Z",
            payload: true,
          },
          {
            segmentId: v0TargetSegmentId,
            source: v0TargetRequest,
            status: "failed",
            attempts: 3,
            error: "failed v0 target",
            finishedAt: "2026-01-02T00:00:00Z",
            payload: true,
          },
        ];
        for (const historical of historicalJobs) {
          await database.pool.query(
            `
            INSERT INTO extraction_jobs (
                segment_id, session_id, start_user_message_id, end_user_message_id,
                projection_version, payload, status, attempts, error, finished_at,
                source_generation, source_fingerprint
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, 0, NULL)
            `,
            [
              historical.segmentId,
              historical.source.session_id,
              historical.source.start_user_message_id,
              historical.source.end_user_message_id,
              historical.source.projection_version,
              historical.payload ? JSON.stringify(historical.source) : null,
              historical.status,
              historical.attempts,
              historical.error,
              historical.finishedAt,
            ],
          );
        }

        await database.applyMigrations(MIGRATIONS_DIR);
        await database.applyMigrations(MIGRATIONS_DIR);
        const migratedJobs = (
          await database.pool.query<
            QueryResultRow & {
              id: string;
              end_user_message_id: string;
              source_generation: string;
              source_fingerprint: string;
              job_id: string;
            }
          >(
            `
            SELECT jobs.id, jobs.end_user_message_id, jobs.source_generation,
                   jobs.source_fingerprint, targets.job_id
            FROM extraction_jobs AS jobs
            JOIN segment_targets AS targets ON targets.segment_id = jobs.segment_id
            WHERE jobs.segment_id = $1 AND jobs.status = 'pending'
            `,
            [migrationSegmentId],
          )
        ).rows;
        const migratedTargets = new Map(
          (
            await database.pool.query<
              QueryResultRow & {
                segment_id: string;
                job_id: string;
                status: string;
                end_user_message_id: string;
                source_fingerprint: string;
              }
            >(
              `
              SELECT targets.segment_id, targets.job_id, jobs.status,
                     jobs.end_user_message_id, jobs.source_fingerprint
              FROM segment_targets AS targets
              JOIN extraction_jobs AS jobs ON jobs.id = targets.job_id
              WHERE targets.segment_id = ANY($1::uuid[])
              `,
              [
                [
                  failedSegmentId,
                  precedenceSegmentId,
                  forwardSegmentId,
                  rewindSegmentId,
                  v0TargetSegmentId,
                ],
              ],
            )
          ).rows.map((row) => [row.segment_id, row]),
        );
        expect(migratedJobs).toHaveLength(1);
        const migratedLatest = required(migratedJobs[0]);
        expect(migratedLatest.id).toBe(migratedLatest.job_id);
        expect(migratedLatest.end_user_message_id).toBe("latest-end");
        expect(BigInt(migratedLatest.source_generation)).toBe(2n);
        expect(migratedLatest.source_fingerprint).toBe(
          sourceFingerprint(latestRequest),
        );
        const failedTarget = required(migratedTargets.get(failedSegmentId));
        expect(failedTarget.status).toBe("failed");
        expect(failedTarget.end_user_message_id).toBe("failed-end");
        expect(failedTarget.source_fingerprint).toBe(
          sourceFingerprint(failedRequest),
        );
        const precedenceTarget = required(
          migratedTargets.get(precedenceSegmentId),
        );
        expect(precedenceTarget.status).toBe("pending");
        expect(precedenceTarget.end_user_message_id).toBe("active-end");
        expect(migratedTargets.has(forwardSegmentId)).toBe(false);
        expect(migratedTargets.has(rewindSegmentId)).toBe(false);
        const v0Target = required(migratedTargets.get(v0TargetSegmentId));
        expect(v0Target.status).toBe("failed");
        expect(v0Target.end_user_message_id).toBe("v0-target-end");

        const replayedV0Target = await database.enqueue(v0TargetRequest);
        expect(replayedV0Target.status).toBe("failed");
        expect(replayedV0Target.attempts).toBe(3);
        const retriedFailed = required(
          await database.retryFailedJob(Number(failedTarget.job_id)),
        );
        expect(retriedFailed.status).toBe("pending");
        expect(retriedFailed.attempts).toBe(0);
      } finally {
        await database.close();
      }
    },
    30_000,
  );
});
