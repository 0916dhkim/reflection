import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, readdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  sourceSegmentIdForRequest,
  type SourceInfo,
} from "@reflection/shared/sources";
import { describe, expect, test, vi } from "vitest";

import {
  Database,
  JobNotRetryableError,
  type ClaimedJob,
} from "../src/database.js";
import {
  EXTRACTION_VALIDATION_VERSION,
  type ValidatedExtractionResult,
} from "../src/extraction-validation.js";
import { createApp } from "../src/app.js";
import { loadSettings } from "../src/config.js";
import {
  nativeSourceFingerprint,
  nativeProjectionFingerprint,
  nativeSegmentIdForRequest,
  parseNativeSegmentCreate,
  type NativeSegmentCreate,
} from "@reflection/shared/native";
import {
  parseIngestJobResponse,
  parseIngestSegmentResponse,
  parseIngestSessionSegmentsResponse,
} from "@reflection/shared/ingestion";
import type { PreparedSegment as IngestPreparedSegment } from "../src/ingestion.js";

const NATIVE_SOURCE = {
  id: "native-source",
  kind: "opencode-v2",
  identity_scheme: "source-v1",
} as const;
function nativeRequest(): NativeSegmentCreate {
  return parseNativeSegmentCreate({
    source_id: NATIVE_SOURCE.id,
    session_id: "native-session",
    source_boundary_version: 3,
    start_source_message_id: "m0",
    end_source_message_id: "m10",
    projection_version: 3,
    processing_priority: 50,
    messages: [
      "system",
      "user",
      "assistant",
      "synthetic",
      "shell",
      "skill",
      "compaction",
      "idle",
      "agent-switched",
      "model-switched",
      "location-switched",
    ].map((type, index) => ({
      id: `m${index}`,
      type,
      text: `Unicode 😀 é 漢字 : ${index}\n"quoted"`,
    })),
  });
}
function nativePrepared(
  claim: ClaimedJob,
  summary: string,
): IngestPreparedSegment {
  if (claim.request.source_boundary_version !== 3)
    throw new Error("expected native claim");
  const entityId = randomUUID();
  return {
    id: claim.segmentId,
    sessionId: claim.request.session_id,
    sourceBoundaryVersion: 3,
    startSourceMessageId: claim.request.start_source_message_id,
    endSourceMessageId: claim.request.end_source_message_id,
    projectionVersion: 3,
    summary,
    entities: [
      {
        id: entityId,
        canonicalName: "Native source",
        normalizedName: "native source",
        description: "Native source",
        aliases: [],
        embedding: EMBEDDING,
        isNew: true,
      },
    ],
    claims: [
      {
        id: randomUUID(),
        subject: "Native source",
        subjectEntityId: entityId,
        predicate: "preserves",
        confidence: 1,
        objectEntity: null,
        objectEntityId: null,
        objectValue: "machine events",
        equivalenceKey: equivalenceKey(entityId, "preserves", {
          objectEntityId: null,
          objectValue: "machine events",
        }),
        embedding: EMBEDDING,
      },
    ],
  };
}
async function openNativeDatabase() {
  const database = new Database(settings());
  await openDatabase(database);
  await truncate(database);
  await database.pool.query(
    "INSERT INTO reflection_sources VALUES ($1, 'opencode-v2', 'source-v1') ON CONFLICT DO NOTHING",
    [NATIVE_SOURCE.id],
  );
  return database;
}

type DatabaseSettings = ConstructorParameters<typeof Database>[0];

const DATABASE_URL = process.env.REFLECTION_TEST_DATABASE_URL;
const SOURCE_ID = "test-source";
async function openDatabase(database: Database): Promise<void> {
  await database.applyMigrations(MIGRATIONS_DIR);
  await database.pool.query(
    "INSERT INTO reflection_sources(source_id, kind, identity_scheme) VALUES ($1, 'opencode-v1', 'legacy') ON CONFLICT DO NOTHING",
    [SOURCE_ID],
  );
  for (const args of [
    ["install-indexes"],
    ["cutover", "--old-writers-stopped"],
  ]) {
    execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../scripts/source-ownership.mjs", import.meta.url),
        ),
        ...args,
      ],
      {
        env: { ...process.env, DATABASE_URL: databaseUrl() },
      },
    );
  }
  await database.open();
}
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

function validatedExtractionResult(
  value: ExtractionResult,
): ValidatedExtractionResult {
  return value as ValidatedExtractionResult;
}

function updateRequest(
  source: SegmentCreate,
  update: Partial<SegmentCreate>,
): SegmentCreate {
  return parseSegmentCreate({ ...source, ...update });
}

function emptyPrepared(claimed: ClaimedJob, summary: string): PreparedSegment {
  if (claimed.request.source_boundary_version === 3)
    throw new Error("expected legacy claim");
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
  if (claimed.request.source_boundary_version === 3)
    throw new Error("expected legacy claim");
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
  const extraction =
    claimed.extractionResult ??
    validatedExtractionResult({ summary: prepared.summary, claims: [] });
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
  test("009-only operator fixtures remain legacy until native schema expansion and index preparation", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "reflection-cp009-migrations-"),
    );
    const database = new Database(settings());
    const run = (...args: string[]) =>
      execFileSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../../scripts/source-ownership.mjs", import.meta.url),
          ),
          ...args,
        ],
        {
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl(),
            MIGRATIONS_DIR: directory,
          },
        },
      );
    try {
      await database.pool.query(
        "DROP SCHEMA public CASCADE; CREATE SCHEMA public",
      );
      for (const name of await readdir(MIGRATIONS_DIR)) {
        if (/^00[1-9]_.*\.sql$/.test(name))
          await copyFile(join(MIGRATIONS_DIR, name), join(directory, name));
      }
      run("expand");
      expect(
        (
          await database.pool.query(
            "SELECT name FROM reflection_schema_migrations",
          )
        ).rows,
      ).toHaveLength(9);
      run("install-indexes");
      expect(
        (
          await database.pool.query(
            "SELECT to_regclass('segments_source_v3_start_key') AS index",
          )
        ).rows[0].index,
      ).toBeNull();
      run("cutover", "--old-writers-stopped");
      await expect(database.open()).rejects.toThrow(
        "source indexes are not ready",
      );
      expect(
        (
          await database.pool.query(
            "SELECT name FROM reflection_schema_migrations",
          )
        ).rows,
      ).toHaveLength(10);
      expect(
        (
          await database.pool.query(`SELECT convalidated FROM pg_constraint
        WHERE conname IN ('segments_source_boundary_check', 'extraction_jobs_source_boundary_check', 'segment_targets_source_boundary_check')`)
        ).rows,
      ).toEqual([
        { convalidated: false },
        { convalidated: false },
        { convalidated: false },
      ]);
      run("install-indexes");
      expect(
        (
          await database.pool.query(`SELECT convalidated FROM pg_constraint
        WHERE conname IN ('segments_source_boundary_check', 'extraction_jobs_source_boundary_check', 'segment_targets_source_boundary_check')`)
        ).rows,
      ).toEqual([
        { convalidated: true },
        { convalidated: true },
        { convalidated: true },
      ]);
      await database.open();
    } finally {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("boundary validation allows legacy DML and cannot be bypassed by ready indexes", async () => {
    const database = new Database(settings());
    await openDatabase(database);
    const validator = await database.pool.connect();
    const tables = ["segments", "extraction_jobs", "segment_targets"];
    try {
      await truncate(database);
      for (const table of tables) {
        const name = `${table}_source_boundary_check`;
        const definition = (
          await database.pool.query(
            "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2",
            [table, name],
          )
        ).rows[0].definition;
        await database.pool.query(
          `ALTER TABLE ${table} DROP CONSTRAINT ${name}, ADD CONSTRAINT ${name} ${definition} NOT VALID`,
        );
        await expect(database.open()).rejects.toThrow(
          "source boundary checks are not validated",
        );
      }
      await validator.query(
        "BEGIN; SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='2s'",
      );
      for (const table of tables)
        await validator.query(
          `ALTER TABLE ${table} VALIDATE CONSTRAINT ${table}_source_boundary_check`,
        );
      const locks = (
        await validator.query(`SELECT mode FROM pg_locks WHERE pid=pg_backend_pid()
        AND relation IN ('segments'::regclass, 'extraction_jobs'::regclass, 'segment_targets'::regclass)
        AND locktype='relation' AND granted`)
      ).rows;
      expect(locks).toHaveLength(3);
      expect(
        locks.every((row) => row.mode === "ShareUpdateExclusiveLock"),
      ).toBe(true);

      // Hold the validator's actual relation locks until rollback while another
      // connection writes legacy rows through every affected table.
      await within(
        (async () => {
          const source = {
            ...request({
              session_id: "online-validation",
              start_user_message_id: "start",
              end_user_message_id: "end",
              projection_version: 2,
              messages: [{ role: "user", text: "legacy writes continue" }],
            }),
            source_id: SOURCE_ID,
          };
          const job = await database.enqueue(source);
          const claim = required(
            await withClient(database, (client) =>
              database.claimOldestJob(client),
            ),
          );
          expect(
            await completeResolution(
              database,
              claim,
              emptyPrepared(claim, "Legacy summary"),
            ),
          ).toBe(true);
          expect(
            await database.getSegment(SOURCE_ID, job.segment_id),
          ).toMatchObject({ summary: "Legacy summary" });
          await expect(
            database.pool.query(
              "UPDATE segments SET source_boundary_version=4 WHERE id=$1",
              [job.segment_id],
            ),
          ).rejects.toMatchObject({ code: "23514" });
        })(),
        2000,
      );
      await validator.query("ROLLBACK");
      await expect(database.open()).rejects.toThrow(
        "source boundary checks are not validated",
      );
      execFileSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../../scripts/source-ownership.mjs", import.meta.url),
          ),
          "install-indexes",
        ],
        { env: { ...process.env, DATABASE_URL: databaseUrl() } },
      );
      await database.open();
    } finally {
      await validator.query("ROLLBACK");
      validator.release();
      await database.close();
    }
  });

  test("native indexes are explicit startup prerequisites and isolate identical source cursors", async () => {
    const database = await openNativeDatabase();
    try {
      for (const name of [
        "segments_source_v3_start_key",
        "extraction_jobs_source_v3_boundary_key",
      ]) {
        await database.pool.query(`DROP INDEX ${name}`);
        await expect(database.open()).rejects.toThrow(
          "source indexes are not ready",
        );
        execFileSync(
          process.execPath,
          [
            fileURLToPath(
              new URL("../../scripts/source-ownership.mjs", import.meta.url),
            ),
            "install-indexes",
          ],
          { env: { ...process.env, DATABASE_URL: databaseUrl() } },
        );
        await database.open();
      }
      const other = { ...NATIVE_SOURCE, id: "native-other" };
      await database.pool.query(
        "INSERT INTO reflection_sources VALUES ($1, 'opencode-v2', 'source-v1') ON CONFLICT DO NOTHING",
        [other.id],
      );
      const first = nativeRequest();
      const second = { ...first, source_id: other.id };
      const [a, b] = await Promise.all([
        database.enqueue(first),
        database.enqueue(second),
      ]);
      expect(a.segment_id).not.toBe(b.segment_id);
      expect(a.source_fingerprint).not.toBe(b.source_fingerprint);
      expect(await database.getJob(first.source_id, b.id)).toBeNull();
      expect(await database.getJob(second.source_id, a.id)).toBeNull();
      expect(
        (
          await database.sessionSegmentListing(
            first.source_id,
            first.session_id,
          )
        )[2].map((t) => t.id),
      ).toEqual([a.segment_id]);
      expect(
        (
          await database.sessionSegmentListing(
            second.source_id,
            second.session_id,
          )
        )[2].map((t) => t.id),
      ).toEqual([b.segment_id]);
      const claim = required(
        await withClient(database, (c) =>
          database.claimOldestJob(c, [
            { sourceId: first.source_id, sessionId: first.session_id },
          ]),
        ),
      );
      expect(claim.sourceId).toBe(second.source_id);
      expect(claim.request).toEqual(second);
      const extraction = validatedExtractionResult({
        summary: "Source fenced",
        claims: [],
      });
      await expect(
        database.publishExtraction(
          { ...claim, sourceId: first.source_id, request: first },
          extraction,
        ),
      ).rejects.toThrow();
      expect(await database.publishExtraction(claim, extraction)).toBe(true);
      expect(
        await database.segmentSummaries(first.source_id, first.session_id),
      ).toEqual([]);
      expect(
        await database.segmentSummaries(second.source_id, second.session_id),
      ).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  test("native fingerprints match SQL UTF-8 framing, types, order, sources, and projections", async () => {
    const database = await openNativeDatabase();
    try {
      const golden = parseNativeSegmentCreate({
        source_id: "source-a",
        session_id: "session😀",
        source_boundary_version: 3,
        start_source_message_id: "m😀-1",
        end_source_message_id: "m2",
        projection_version: 3,
        processing_priority: 0,
        messages: [
          { id: "m😀-1", type: "user", text: "  hi 😀\n" },
          { id: "m2", type: "synthetic", text: "" },
        ],
      });
      expect(nativeSourceFingerprint(golden)).toBe(
        "eaab4957c25565e7a89822598f22b86ea6ae45e2cf82af91b6a57354e1194b4b",
      );
      const base = nativeRequest();
      const variants = [
        base,
        golden,
        { ...base, source_id: "another-source" },
        { ...base, session_id: "other:session" },
        {
          ...base,
          messages: base.messages.map((m, i) =>
            i === 3 ? { ...m, type: "user" as const } : m,
          ),
        },
        {
          ...base,
          messages: base.messages.map((m, i) =>
            i === 3 ? { ...m, text: `${m.text}:changed` } : m,
          ),
        },
        {
          ...base,
          messages: [
            base.messages[0]!,
            base.messages[2]!,
            base.messages[1]!,
            ...base.messages.slice(3),
          ],
        },
      ];
      const fingerprints = new Set<string>();
      for (const value of variants) {
        const row = (
          await database.pool.query(
            `SELECT reflection_source_fingerprint($1,$2,NULL,NULL,3,$3,$4,$5::jsonb) AS fingerprint`,
            [
              value.source_id,
              value.session_id,
              value.start_source_message_id,
              value.end_source_message_id,
              JSON.stringify(value),
            ],
          )
        ).rows[0];
        expect(row.fingerprint).toBe(nativeSourceFingerprint(value));
        fingerprints.add(row.fingerprint);
      }
      expect(fingerprints.size).toBe(variants.length);
      const id = nativeSegmentIdForRequest(base, NATIVE_SOURCE);
      expect(
        nativeSegmentIdForRequest(variants[2]!, {
          ...NATIVE_SOURCE,
          id: variants[2]!.source_id,
        }),
      ).not.toBe(id);
      for (const summary of [
        "Summary",
        "Unicode 😀 漢字 é:2:3",
        "",
        "line\nline",
      ]) {
        const row = (
          await database.pool.query(
            "SELECT reflection_projection_fingerprint($1::uuid,3,NULL,$2,$3,3) AS fingerprint",
            [id, base.end_source_message_id, summary],
          )
        ).rows[0];
        expect(row.fingerprint).toBe(
          nativeProjectionFingerprint(
            id,
            base.end_source_message_id,
            summary,
            3,
          ),
        );
      }
    } finally {
      await database.close();
    }
  });

  test("native HTTP enqueue, staged manifest, commit, recall, and replacement preserve SQL NULL boundaries", async () => {
    const database = await openNativeDatabase();
    const app = createApp({
      settings: loadSettings({
        DATABASE_URL: databaseUrl(),
        REFLECTION_API_KEY: "test-key",
        OPENROUTER_API_KEY: "synthetic",
        VOYAGE_API_KEY: "synthetic",
        MIGRATIONS_DIR,
      }),
      dependencies: {
        database,
        worker: { start() {}, stop: async () => {}, wake() {} },
        searchService: { search: async () => ({ claims: [] }) },
      },
      logger: false,
    });
    const headers = { "x-api-key": "test-key" };
    try {
      const source = nativeRequest();
      const manifestUrl = `/v1/sessions/${source.session_id}/segments?source_id=${source.source_id}`;
      const emptyNative = await app.inject({ url: manifestUrl, headers });
      expect(emptyNative.statusCode).toBe(200);
      expect(
        parseIngestSessionSegmentsResponse(
          emptyNative.json(),
          source.source_id,
        ),
      ).toEqual({
        source_id: source.source_id,
        session_id: source.session_id,
        manifest_version: 3,
        segments: [],
        boundaries: [],
        targets: [],
      });
      const emptyLegacy = await app.inject({
        url: `/v1/sessions/${source.session_id}/segments?source_id=${SOURCE_ID}`,
        headers,
      });
      expect(emptyLegacy.statusCode).toBe(200);
      expect(
        parseIngestSessionSegmentsResponse(emptyLegacy.json(), SOURCE_ID)
          .manifest_version,
      ).toBe(2);
      expect(
        (
          await app.inject({
            url: `/v1/sessions/${source.session_id}/segments?source_id=unknown`,
            headers,
          })
        ).statusCode,
      ).toBe(422);
      for (const extra of [
        { start_user_message_id: null },
        { end_user_message_id: null },
        { start_user_message_id: "fake" },
      ]) {
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/v1/segments",
              headers,
              payload: { ...source, ...extra },
            })
          ).statusCode,
        ).toBe(422);
      }
      const response = await app.inject({
        method: "POST",
        url: "/v1/segments",
        headers,
        payload: source,
      });
      expect(response.statusCode).toBe(202);
      const job = parseIngestJobResponse(response.json(), source.source_id);
      expect(job).not.toHaveProperty("start_user_message_id");
      expect(job).not.toHaveProperty("end_user_message_id");
      const stored = (
        await database.pool.query(
          "SELECT start_user_message_id, end_user_message_id, payload FROM extraction_jobs WHERE id=$1",
          [job.id],
        )
      ).rows[0];
      expect(stored).toEqual({
        start_user_message_id: null,
        end_user_message_id: null,
        payload: source,
      });
      const claim = required(
        await withClient(database, (c) => database.claimOldestJob(c)),
      );
      expect(claim.request).toEqual(source);
      const prepared = nativePrepared(claim, "Native summary");
      const extraction = validatedExtractionResult({
        summary: prepared.summary,
        claims: [],
      });
      expect(await database.publishExtraction(claim, extraction)).toBe(true);
      const staged = parseIngestSessionSegmentsResponse(
        (await app.inject({ url: manifestUrl, headers })).json(),
        source.source_id,
      );
      expect(staged.manifest_version).toBe(3);
      expect(staged.segments).toHaveLength(1);
      expect(staged.targets).toHaveLength(1);
      expect(staged.segments[0]).not.toHaveProperty("start_user_message_id");
      expect(await database.commitResolution(claim, extraction, prepared)).toBe(
        true,
      );
      expect(
        (await database.directClaims(EMBEDDING)).map((c) => c.segmentId),
      ).toEqual([job.segment_id]);
      expect(
        (
          await database.pool.query(
            "SELECT start_user_message_id, end_user_message_id FROM segments WHERE id=$1",
            [job.segment_id],
          )
        ).rows[0],
      ).toEqual({ start_user_message_id: null, end_user_message_id: null });
      expect(
        (
          await database.pool.query(
            "SELECT payload FROM extraction_jobs WHERE id=$1",
            [job.id],
          )
        ).rows[0].payload,
      ).toBeNull();
      const segment = parseIngestSegmentResponse(
        (
          await app.inject({
            url: `/v1/segments/${job.segment_id}?source_id=${source.source_id}`,
            headers,
          })
        ).json(),
        source.source_id,
      );
      expect(segment.source_boundary_version).toBe(3);
      expect(segment).not.toHaveProperty("end_user_message_id");
      const manifest = parseIngestSessionSegmentsResponse(
        (await app.inject({ url: manifestUrl, headers })).json(),
      );
      expect(manifest.manifest_version).toBe(3);
      expect(manifest.targets).toEqual([]);
      expect(manifest.boundaries[0]).toMatchObject({
        source_boundary_version: 3,
        source_eligible: true,
      });
      expect(
        await database.sessionSegmentListing(SOURCE_ID, source.session_id),
      ).toEqual([[], [], []]);
      expect((await database.enqueue(source)).status).toBe("succeeded");
      const changed = {
        ...source,
        messages: source.messages.map((m, i) =>
          i === 1 ? { ...m, text: "changed text" } : m,
        ),
      };
      expect((await database.enqueue(changed)).id).toBe(job.id);
      expect(
        await database.segmentSummaries(source.source_id, source.session_id),
      ).toEqual([]);
      expect(await database.directClaims(EMBEDDING)).toEqual([]);
      const replacement = required(
        await withClient(database, (c) => database.claimOldestJob(c)),
      );
      expect(replacement.extractionResult).toBeNull();
      expect(replacement.sourceGeneration).toBeGreaterThan(
        claim.sourceGeneration,
      );
      expect(await database.publishExtraction(claim, extraction)).toBe(false);
      const legacy = {
        ...request({
          session_id: "legacy-under-v2-registry",
          start_user_message_id: "turn",
          end_user_message_id: "turn",
          source_boundary_version: 2,
          start_source_message_id: "legacy-start",
          end_source_message_id: "legacy-end",
          projection_version: 2,
          messages: [{ role: "user", text: "legacy source" }],
        }),
        source_id: source.source_id,
      };
      await database.enqueue(legacy);
      const legacyResponse = await app.inject({
        url: `/v1/sessions/${legacy.session_id}/segments?source_id=${source.source_id}`,
        headers,
      });
      expect(legacyResponse.statusCode).toBe(200);
      const legacyManifest = parseIngestSessionSegmentsResponse(
        legacyResponse.json(),
        source.source_id,
      );
      expect(legacyManifest.manifest_version).toBe(2);
      expect(legacyManifest.targets[0]?.source_boundary_version).toBe(2);
      await database.enqueue({ ...legacy, session_id: source.session_id });
      const mixed = await app.inject({ url: manifestUrl, headers });
      expect(mixed.statusCode).toBe(409);
      expect(mixed.json()).toEqual({
        detail: "source manifest mixes legacy and native boundaries",
      });
    } finally {
      await app.close();
    }
  });

  test("native retries, restart, recovery, concurrent replacement, lease and source fencing", async () => {
    const database = await openNativeDatabase();
    try {
      const source = nativeRequest();
      await expect(
        database.enqueue({ ...source, source_id: SOURCE_ID }),
      ).rejects.toThrow("opencode-v2 source-v1");
      const job = await database.enqueue(source);
      let claim = required(
        await withClient(database, (c) => database.claimOldestJob(c)),
      );
      const first = claim;
      const extraction = validatedExtractionResult({
        summary: "Reusable stage",
        claims: [],
      });
      await expect(
        database.publishExtraction(
          { ...claim, sourceId: SOURCE_ID },
          extraction,
        ),
      ).rejects.toThrow();
      await expect(
        database.publishExtraction(
          { ...claim, sourceFingerprint: "0".repeat(64) },
          extraction,
        ),
      ).rejects.toThrow("identity mismatch");
      expect(
        await database.publishExtraction(
          { ...claim, leaseId: randomUUID() },
          extraction,
        ),
      ).toBe(false);
      expect(await database.publishExtraction(claim, extraction)).toBe(true);
      expect(
        await database.finishFailedAttempt(claim, "retry later", {
          retryAfterSeconds: 0,
        }),
      ).toBe(true);
      claim = required(
        await withClient(database, (c) => database.claimOldestJob(c)),
      );
      expect(claim.extractionResult).toEqual(extraction);
      expect(claim.request).toEqual(source);
      expect(
        await database.finishFailedAttempt(claim, "terminal", {
          retryAfterSeconds: null,
        }),
      ).toBe(true);
      await database.pool.query(
        "UPDATE extraction_jobs SET payload=NULL WHERE id=$1",
        [job.id],
      );
      expect(await database.retryFailedJob(SOURCE_ID, job.id)).toBeNull();
      expect(
        (await database.retryFailedJob(source.source_id, job.id))?.status,
      ).toBe("pending");
      claim = required(
        await withClient(database, (c) => database.claimOldestJob(c)),
      );
      expect(claim.extractionResult).toEqual(extraction);
      await database.finishFailedAttempt(claim, "restart", {
        retryAfterSeconds: null,
      });
      await database.retryFailedJob(source.source_id, job.id, {
        restartExtraction: true,
      });
      claim = required(
        await withClient(database, (c) => database.claimOldestJob(c)),
      );
      expect(claim.extractionResult).toBeNull();
      expect(
        await withClient(database, (c) => database.recoverRunningJobs(c)),
      ).toBe(1);
      expect(await database.publishExtraction(claim, extraction)).toBe(false);
      claim = required(
        await withClient(database, (c) => database.claimOldestJob(c)),
      );
      expect(claim.request).toEqual(source);
      const changed = {
        ...source,
        messages: source.messages.map((m, i) =>
          i === 1 ? { ...m, text: "new snapshot" } : m,
        ),
      };
      await Promise.all([database.enqueue(changed), database.enqueue(changed)]);
      expect(await database.publishExtraction(claim, extraction)).toBe(false);
      claim = required(
        await withClient(database, (c) => database.claimOldestJob(c)),
      );
      expect(claim.request).toEqual(changed);
      const extended = {
        ...changed,
        end_source_message_id: "m11",
        messages: [
          ...changed.messages,
          { id: "m11", type: "synthetic" as const, text: "machine event" },
        ],
      };
      const newer = await database.enqueue(extended);
      expect(newer.id).not.toBe(job.id);
      expect(newer.segment_id).toBe(job.segment_id);
      expect(
        await withClient(database, (c) => database.recoverRunningJobs(c)),
      ).toBe(1);
      expect((await database.getJob(source.source_id, job.id))?.status).toBe(
        "superseded",
      );
      claim = required(
        await withClient(database, (c) => database.claimOldestJob(c)),
      );
      expect(claim.request).toEqual(extended);
      await expect(
        database.commitResolution(
          first,
          extraction,
          nativePrepared(first, extraction.summary),
        ),
      ).rejects.toThrow("lease changed");
      await database.finishFailedAttempt(claim, "terminal", {
        retryAfterSeconds: null,
      });
      expect(
        (await database.supersedeFailedJob(source.source_id, newer.id))?.status,
      ).toBe("superseded");
      expect(
        await database.sessionSegmentListing(
          source.source_id,
          source.session_id,
        ),
      ).toEqual([[], [], []]);
    } finally {
      await database.close();
    }
  });

  test("native SQL constraints reject user fields, malformed payloads, and nonexhaustive boundaries", async () => {
    const database = await openNativeDatabase();
    try {
      const source = nativeRequest();
      const job = await database.enqueue(source);
      for (const table of ["extraction_jobs", "segment_targets"]) {
        for (const payload of [
          { ...source, start_user_message_id: null },
          { ...source, end_user_message_id: "fake" },
          { ...source, source_id: "different" },
          { ...source, source_id: null },
          { ...source, messages: [] },
          {
            ...source,
            messages: [{ id: "m0", type: "tool", text: "bad type" }],
          },
          {
            ...source,
            messages: source.messages.map((m, i) =>
              i === 0 ? { ...m, id: "bad-start" } : m,
            ),
          },
          {
            ...source,
            messages: source.messages.map((m, i) =>
              i === 1 ? { ...m, text: null } : m,
            ),
          },
          {
            ...source,
            messages: source.messages.map((m, i) =>
              i === 1 ? { ...m, id: "m0" } : m,
            ),
          },
          { ...source, projection_version: 2 },
          { ...source, source_boundary_version: "3" },
          { ...source, processing_priority: 0.5 },
        ])
          await expect(
            database.pool.query(`UPDATE ${table} SET payload=$1::jsonb`, [
              JSON.stringify(payload),
            ]),
          ).rejects.toMatchObject({ code: "23514" });
        for (const set of [
          "end_user_message_id='fake'",
          "source_boundary_version=4",
          "source_boundary_version=1",
          "source_boundary_version=2",
          "start_source_message_id=NULL",
          "source_id=NULL",
        ]) {
          await expect(
            database.pool.query(`UPDATE ${table} SET ${set}`),
          ).rejects.toMatchObject({ code: "23514" });
        }
      }
      await expect(
        database.pool.query(
          "UPDATE extraction_jobs SET payload=NULL WHERE id=$1",
          [job.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      const claim = required(
        await withClient(database, (c) => database.claimOldestJob(c)),
      );
      const extraction = validatedExtractionResult({
        summary: "Native",
        claims: [],
      });
      await database.publishExtraction(claim, extraction);
      await database.commitResolution(
        claim,
        extraction,
        nativePrepared(claim, extraction.summary),
      );
      for (const set of [
        "start_user_message_id='fake'",
        "end_user_message_id='fake'",
        "source_boundary_version=4",
        "source_boundary_version=1",
        "source_boundary_version=2",
        "start_source_message_id=NULL",
        "source_id=NULL",
        "projection_version=2",
      ]) {
        await expect(
          database.pool.query(`UPDATE segments SET ${set}`),
        ).rejects.toMatchObject({ code: "23514" });
      }
    } finally {
      await database.close();
    }
  });

  test.skipIf(!DATABASE_URL)(
    "expands a fresh database through the operator without starting or preparing the application",
    async () => {
      const database = new Database(settings());
      const run = (...args: string[]) =>
        promisify(execFile)(
          process.execPath,
          [
            fileURLToPath(
              new URL("../../scripts/source-ownership.mjs", import.meta.url),
            ),
            ...args,
          ],
          {
            env: {
              ...process.env,
              DATABASE_URL: databaseUrl(),
              MIGRATIONS_DIR,
            },
          },
        );
      try {
        // This suite requires an explicitly disposable database and already
        // recreates legacy schemas. Exercise expansion from a genuinely empty one.
        await database.pool.query(
          "DROP SCHEMA public CASCADE; CREATE SCHEMA public",
        );
        expect((await run("expand")).stdout).toContain(
          "transactional schema expansion complete",
        );
        expect(await database.listSources()).toEqual([]);
        const ledger = (
          await database.pool.query(
            "SELECT * FROM reflection_schema_migrations ORDER BY name",
          )
        ).rows;
        expect(ledger).toHaveLength(10);
        expect(ledger[8]).toMatchObject({
          name: "009_source_ownership_expansion.sql",
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(
          (
            await database.pool.query(
              "SELECT to_regclass('extraction_jobs_source_v1_boundary_key') AS new_index, to_regclass('extraction_jobs_v1_boundary_key') AS old_index",
            )
          ).rows[0],
        ).toEqual({
          new_index: null,
          old_index: "extraction_jobs_v1_boundary_key",
        });
        const legacy = request({
          session_id: "old-writer",
          start_user_message_id: "start",
          end_user_message_id: "end",
          messages: [{ role: "user", text: "legacy source" }],
        });
        const write = () =>
          database.pool.query(
            `INSERT INTO extraction_jobs (segment_id, session_id, start_user_message_id, end_user_message_id, payload)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (session_id, start_user_message_id, end_user_message_id) WHERE source_boundary_version = 1
        DO UPDATE SET payload = EXCLUDED.payload RETURNING id, source_id, status, attempts`,
            [
              segmentIdForRequest(legacy),
              legacy.session_id,
              legacy.start_user_message_id,
              legacy.end_user_message_id,
              JSON.stringify(legacy),
            ],
          );
        const first = (await write()).rows[0];
        expect(first).toMatchObject({
          source_id: null,
          status: "pending",
          attempts: 0,
        });
        expect((await write()).rows[0]).toEqual(first);
        await run("expand");
        expect(
          (
            await database.pool.query(
              "SELECT * FROM reflection_schema_migrations ORDER BY name",
            )
          ).rows,
        ).toEqual(ledger);
        expect(await database.listSources()).toEqual([]);
        await expect(database.open()).rejects.toThrow(
          "source indexes are not ready",
        );
        await run("install-indexes");
        await expect(database.open()).rejects.toThrow("stop old writers");
        expect(await database.listSources()).toEqual([]);
        await run(
          "register",
          "--id",
          SOURCE_ID,
          "--kind",
          "opencode-v1",
          "--identity-scheme",
          "legacy",
        );
        await run("cutover", "--old-writers-stopped");
        await database.open();
        expect(
          (await database.getJob(SOURCE_ID, Number(first.id)))?.status,
        ).toBe("pending");
        await database.pool.query(
          "UPDATE reflection_schema_migrations SET checksum = repeat('0', 64) WHERE name = '009_source_ownership_expansion.sql'",
        );
        await expect(run("expand")).rejects.toThrow();
        await expect(database.applyMigrations(MIGRATIONS_DIR)).rejects.toThrow(
          "migration checksum mismatch",
        );
        await database.pool.query(
          "UPDATE reflection_schema_migrations SET checksum = $1 WHERE name = '009_source_ownership_expansion.sql'",
          [ledger[8].checksum],
        );
      } finally {
        await database.close();
      }
    },
  );
  test
    .skipIf(!DATABASE_URL)
    .each(["current", "historical", "fingerprint", "ownership"])(
    "quarantines %s corruption without losing retained data or starving another session",
    async (corruption) => {
      const database = new Database(settings());
      await openDatabase(database);
      try {
        await truncate(database);
        const source = {
          ...request({
            session_id: "poisoned",
            start_user_message_id: "start",
            end_user_message_id: "old",
            messages: [{ role: "user", text: "original" }],
          }),
          source_id: SOURCE_ID,
        };
        const historical = await database.enqueue(source);
        const initial = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        await completeResolution(
          database,
          initial,
          preparedSegment(initial, {
            endId: "old",
            summary: "committed",
            subjectId: randomUUID(),
            objectId: randomUUID(),
            entitiesAreNew: true,
          }),
        );
        const current = await database.enqueue({
          ...source,
          end_user_message_id: "new",
          processing_priority: 100,
        });
        const running = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        await database.publishExtraction(
          running,
          validatedExtractionResult({ summary: "retained stage", claims: [] }),
        );
        await database.finishFailedAttempt(running, "retry", {
          retryAfterSeconds: 0,
        });
        await database.pool.query(
          "UPDATE extraction_jobs SET next_attempt_at = now() - INTERVAL '1 second' WHERE id = $1",
          [current.id],
        );
        const healthy = await database.enqueue({
          ...source,
          session_id: "healthy",
        });
        if (corruption === "ownership") {
          await database.pool.query(
            "INSERT INTO reflection_sources VALUES ('quarantine-other', 'opencode-v2', 'source-v1') ON CONFLICT DO NOTHING",
          );
          await database.pool.query(
            "UPDATE segment_targets SET source_id = 'quarantine-other' WHERE segment_id = $1",
            [current.segment_id],
          );
        } else if (corruption === "fingerprint") {
          await database.pool.query(
            "UPDATE extraction_jobs SET payload = jsonb_set(payload, '{messages,0,text}', '\"changed\"') WHERE id = $1",
            [current.id],
          );
        } else {
          await database.pool.query(
            "UPDATE extraction_jobs SET payload = '{}'::jsonb WHERE id = $1",
            [corruption === "historical" ? historical.id : current.id],
          );
        }
        const retained = async () => ({
          targets: (
            await database.pool.query(
              "SELECT * FROM segment_targets ORDER BY segment_id",
            )
          ).rows,
          claims: (
            await database.pool.query("SELECT * FROM claims ORDER BY id")
          ).rows,
          segments: (
            await database.pool.query("SELECT * FROM segments ORDER BY id")
          ).rows,
          jobs: (
            await database.pool.query(
              "SELECT id, segment_id, source_id, payload, source_fingerprint, source_generation FROM extraction_jobs ORDER BY id",
            )
          ).rows,
        });
        const before = await retained();
        const oldJob = await database.getJob(SOURCE_ID, historical.id);
        const healthyBefore = await database.getJob(SOURCE_ID, healthy.id);
        expect(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        ).toBeNull();
        expect(await database.getJob(SOURCE_ID, current.id)).toMatchObject({
          status: "failed",
          error:
            "OwnershipValidationError: persisted segment group quarantined",
          finished_at: expect.any(String),
        });
        expect(await database.getJob(SOURCE_ID, historical.id)).toEqual(oldJob);
        expect(await database.getJob(SOURCE_ID, healthy.id)).toEqual(
          healthyBefore,
        );
        expect(await retained()).toEqual(before);
        expect(
          required(
            await withClient(database, (client) =>
              database.claimOldestJob(client),
            ),
          ).id,
        ).toBe(healthy.id);
        expect(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        ).toBeNull();
      } finally {
        await database.close();
      }
    },
  );

  test.skipIf(!DATABASE_URL)(
    "isolates a corrupt running group while recovering healthy groups",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      try {
        await truncate(database);
        const source = {
          ...request({
            session_id: "bad-recovery",
            start_user_message_id: "start",
            end_user_message_id: "end",
            messages: [{ role: "user", text: "source" }],
          }),
          source_id: SOURCE_ID,
        };
        const bad = await database.enqueue(source);
        const badClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        await database.publishExtraction(
          badClaim,
          validatedExtractionResult({ summary: "preserved stage", claims: [] }),
        );
        const good = await database.enqueue({
          ...source,
          session_id: "good-recovery",
        });
        await withClient(database, (client) => database.claimOldestJob(client));
        await database.pool.query(
          "UPDATE extraction_jobs SET payload = '{}'::jsonb WHERE id = $1",
          [bad.id],
        );
        const before = (
          await database.pool.query(
            "SELECT * FROM segment_targets ORDER BY segment_id",
          )
        ).rows;
        expect(
          await withClient(database, (client) =>
            database.recoverRunningJobs(client),
          ),
        ).toBe(1);
        expect(await database.getJob(SOURCE_ID, bad.id)).toMatchObject({
          status: "failed",
          error:
            "OwnershipValidationError: persisted segment group quarantined",
        });
        expect(
          (
            await database.pool.query(
              "SELECT payload, lease_id FROM extraction_jobs WHERE id = $1",
              [bad.id],
            )
          ).rows[0],
        ).toEqual({ payload: {}, lease_id: null });
        expect(
          (
            await database.pool.query(
              "SELECT * FROM segment_targets ORDER BY segment_id",
            )
          ).rows,
        ).toEqual(before);
        expect(
          required(
            await withClient(database, (client) =>
              database.claimOldestJob(client),
            ),
          ).id,
        ).toBe(good.id);
      } finally {
        await database.close();
      }
    },
  );

  test.each(["claim", "recovery"])(
    "quarantines native payloads in legacy boundary rows during %s without starving healthy work",
    async (operation) => {
      const database = new Database(settings());
      await openDatabase(database);
      try {
        await truncate(database);
        const source = {
          ...request({
            session_id: "mixed-boundary-bad",
            start_user_message_id: "turn",
            end_user_message_id: "turn",
            source_boundary_version: 2,
            start_source_message_id: "m0",
            end_source_message_id: "m10",
            projection_version: 2,
            processing_priority: 100,
            messages: [{ role: "user", text: "legacy source" }],
          }),
          source_id: SOURCE_ID,
        };
        const bad = await database.enqueue(source);
        const badClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        const extraction = validatedExtractionResult({
          summary: "Retained legacy stage",
          claims: [],
        });
        await database.publishExtraction(badClaim, extraction);
        if (operation === "claim") {
          await database.finishFailedAttempt(badClaim, "retry", {
            retryAfterSeconds: 0,
          });
        }
        const good = await database.enqueue({
          ...source,
          session_id: "mixed-boundary-good",
          processing_priority: 0,
        });
        if (operation === "recovery") {
          expect(
            required(
              await withClient(database, (client) =>
                database.claimOldestJob(client),
              ),
            ).id,
          ).toBe(good.id);
        }
        const payload = parseNativeSegmentCreate({
          ...nativeRequest(),
          source_id: SOURCE_ID,
          session_id: source.session_id,
        });
        await database.pool.query(
          "UPDATE extraction_jobs SET payload=$1::jsonb WHERE id=$2",
          [JSON.stringify(payload), bad.id],
        );
        const snapshot = async () => ({
          jobs: (
            await database.pool.query(
              "SELECT * FROM extraction_jobs ORDER BY id",
            )
          ).rows,
          targets: (
            await database.pool.query(
              "SELECT * FROM segment_targets ORDER BY segment_id",
            )
          ).rows,
        });
        const before = await snapshot();
        expect(
          before.jobs.find((row) => Number(row.id) === bad.id),
        ).toMatchObject({ source_boundary_version: 2, payload });

        const forged = { ...badClaim, leaseId: randomUUID() };
        for (const mutate of [
          () => database.publishExtraction(forged, extraction),
          () =>
            database.finishFailedAttempt(forged, "forged", {
              retryAfterSeconds: null,
            }),
          () =>
            database.commitResolution(
              forged,
              extraction,
              emptyPrepared(forged, extraction.summary),
            ),
        ]) {
          await expect(mutate()).rejects.toMatchObject({
            name: "OwnershipValidationError",
            message: "persisted payload has mismatched source boundary version",
          });
          expect(await snapshot()).toEqual(before);
        }

        if (operation === "claim") {
          expect(
            await withClient(database, (client) =>
              database.claimOldestJob(client),
            ),
          ).toBeNull();
        } else {
          expect(
            await withClient(database, (client) =>
              database.recoverRunningJobs(client),
            ),
          ).toBe(1);
        }
        const quarantined = await snapshot();
        const badRow = quarantined.jobs.find(
          (row) => Number(row.id) === bad.id,
        );
        expect(badRow).toMatchObject({
          status: "failed",
          lease_id: null,
          payload,
          error:
            "OwnershipValidationError: persisted segment group quarantined",
          finished_at: expect.any(String),
        });
        expect(quarantined.targets).toEqual(before.targets);
        expect(
          required(
            await withClient(database, (client) =>
              database.claimOldestJob(client),
            ),
          ).id,
        ).toBe(good.id);
        expect(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        ).toBeNull();
        expect(
          (await snapshot()).jobs.find((row) => Number(row.id) === bad.id),
        ).toEqual(badRow);
      } finally {
        await database.close();
      }
    },
  );

  test.skipIf(!DATABASE_URL).each(["claim", "recovery"])(
    "does not quarantine operational or registry errors during %s",
    async (operation) => {
      const database = new Database(settings());
      await openDatabase(database);
      try {
        await truncate(database);
        const job = await database.enqueue({
          ...request({
            session_id: "operational-error",
            start_user_message_id: "start",
            end_user_message_id: "end",
            messages: [{ role: "user", text: "source" }],
          }),
          source_id: SOURCE_ID,
        });
        if (operation === "recovery")
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          );
        const failure = Object.assign(new Error("connection interrupted"), {
          code: "08006",
        });
        for (const kind of ["database", "registry", "legacy"]) {
          if (kind === "legacy")
            await database.pool.query(
              "UPDATE extraction_jobs SET source_id = NULL; UPDATE segment_targets SET source_id = NULL",
            );
          const before = (
            await database.pool.query("SELECT * FROM extraction_jobs")
          ).rows;
          await withClient(database, async (client) => {
            const query = client.query.bind(client);
            const spy = vi.spyOn(client, "query").mockImplementation((async (
              text: string,
              values?: unknown[],
            ) => {
              if (
                kind === "database" &&
                text.includes("SELECT * FROM segments")
              )
                throw failure;
              if (
                kind !== "database" &&
                text.includes("SELECT source_id, kind, identity_scheme")
              )
                return { rows: [] };
              return query(text, values);
            }) as typeof client.query);
            try {
              const result =
                operation === "claim"
                  ? database.claimOldestJob(client)
                  : database.recoverRunningJobs(client);
              if (kind === "database")
                await expect(result).rejects.toBe(failure);
              else
                await expect(result).rejects.toThrow(
                  kind === "legacy"
                    ? "registered legacy source"
                    : "unknown source",
                );
            } finally {
              spy.mockRestore();
            }
          });
          expect(
            (await database.pool.query("SELECT * FROM extraction_jobs")).rows,
          ).toEqual(before);
        }
        expect((await database.getJob(SOURCE_ID, job.id))?.status).toBe(
          operation === "claim" ? "pending" : "running",
        );
      } finally {
        await database.close();
      }
    },
  );
  test.skipIf(!DATABASE_URL)(
    "routes job mutations using only strict source bodies and fences wrong owners",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      const worker = {
        start: vi.fn(),
        stop: vi.fn(async () => {}),
        wake: vi.fn(),
      };
      const app = createApp({
        settings: loadSettings({
          DATABASE_URL: databaseUrl(),
          REFLECTION_API_KEY: "test-key",
          OPENROUTER_API_KEY: "synthetic",
          VOYAGE_API_KEY: "synthetic",
          MIGRATIONS_DIR,
        }),
        dependencies: {
          database,
          worker,
          searchService: { search: async () => ({ claims: [] }) },
        },
        logger: false,
      });
      try {
        await truncate(database);
        await database.pool.query(
          "INSERT INTO reflection_sources VALUES ('route-other', 'opencode-v2', 'source-v1') ON CONFLICT DO NOTHING",
        );
        const job = await database.enqueue({
          ...request({
            session_id: "route",
            start_user_message_id: "start",
            end_user_message_id: "end",
            messages: [{ role: "user", text: "source" }],
          }),
          source_id: SOURCE_ID,
        });
        const claim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        await database.finishFailedAttempt(claim, "failure", {
          retryAfterSeconds: null,
        });
        const snapshot = await database.getJob(SOURCE_ID, job.id);
        for (const action of ["retry", "restart", "supersede"]) {
          const url = `/v1/jobs/${job.id}/${action}`;
          const headers = { "x-api-key": "test-key" };
          expect(
            (await app.inject({ method: "POST", url, headers })).statusCode,
          ).toBe(422);
          expect(
            (
              await app.inject({
                method: "POST",
                url: `${url}?source_id=${SOURCE_ID}`,
                headers,
              })
            ).statusCode,
          ).toBe(422);
          expect(
            (
              await app.inject({
                method: "POST",
                url,
                headers,
                payload: { source_id: SOURCE_ID, extra: true },
              })
            ).statusCode,
          ).toBe(422);
          expect(
            (
              await app.inject({
                method: "POST",
                url,
                headers,
                payload: { source_id: "route-other" },
              })
            ).statusCode,
          ).toBe(404);
          expect(await database.getJob(SOURCE_ID, job.id)).toEqual(snapshot);
        }
        expect(worker.wake).not.toHaveBeenCalled();
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/v1/jobs/${job.id}/retry`,
              headers: { "x-api-key": "test-key" },
              payload: { source_id: SOURCE_ID },
            })
          ).statusCode,
        ).toBe(202);
        expect((await database.getJob(SOURCE_ID, job.id))?.status).toBe(
          "pending",
        );
      } finally {
        await app.close();
      }
    },
  );

  test.skipIf(!DATABASE_URL)(
    "bounds concurrent operator waits, backfill locks, and expansion DDL waits",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      const blocker = await database.pool.connect();
      const run = (...args: string[]) =>
        promisify(execFile)(
          process.execPath,
          [
            fileURLToPath(
              new URL("../../scripts/source-ownership.mjs", import.meta.url),
            ),
            ...args,
          ],
          {
            env: { ...process.env, DATABASE_URL: databaseUrl() },
            timeout: 12000,
          },
        );
      try {
        await truncate(database);
        await blocker.query("SELECT pg_advisory_lock($1)", [
          settings().migrationLockId,
        ]);
        const started = Date.now();
        const results = await Promise.allSettled([
          run("install-indexes"),
          run(
            "register",
            "--id",
            "blocked",
            "--kind",
            "opencode-v2",
            "--identity-scheme",
            "source-v1",
          ),
        ]);
        for (const result of results) {
          expect(result.status).toBe("rejected");
          if (result.status === "rejected")
            expect(result.reason.stderr).toContain("55P03");
        }
        expect(Date.now() - started).toBeLessThan(11000);
        await blocker.query("SELECT pg_advisory_unlock($1)", [
          settings().migrationLockId,
        ]);
        const job = await database.enqueue({
          ...request({
            session_id: "locked",
            start_user_message_id: "start",
            end_user_message_id: "end",
            messages: [{ role: "user", text: "source" }],
          }),
          source_id: SOURCE_ID,
        });
        await database.pool.query(
          "UPDATE extraction_jobs SET source_id = NULL; UPDATE segment_targets SET source_id = NULL",
        );
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [job.segment_id],
        );
        await expect(
          run("backfill", "--legacy-source", SOURCE_ID),
        ).rejects.toMatchObject({ stderr: expect.stringContaining("55P03") });
        await blocker.query("ROLLBACK");
        await blocker.query(
          "BEGIN; LOCK TABLE segments IN ACCESS EXCLUSIVE MODE",
        );
        await withClient(database, async (client) => {
          await client.query("BEGIN");
          try {
            await expect(
              client.query(
                await readFile(
                  `${MIGRATIONS_DIR}/009_source_ownership_expansion.sql`,
                  "utf8",
                ),
              ),
            ).rejects.toMatchObject({ code: "55P03" });
          } finally {
            await client.query("ROLLBACK");
          }
        });
        await blocker.query("ROLLBACK");
        await run("backfill", "--legacy-source", SOURCE_ID);
        const secret = "secret-should-never-appear";
        await expect(
          promisify(execFile)(
            process.execPath,
            [
              fileURLToPath(
                new URL("../../scripts/source-ownership.mjs", import.meta.url),
              ),
              "register",
            ],
            {
              env: {
                ...process.env,
                DATABASE_URL: `postgresql://invalid:${secret}@127.0.0.1:1/db`,
              },
              timeout: 7000,
            },
          ),
        ).rejects.toMatchObject({
          stderr: expect.not.stringContaining(secret),
        });
      } finally {
        await blocker.query("ROLLBACK");
        await blocker.query("SELECT pg_advisory_unlock_all()");
        blocker.release();
        await database.close();
      }
    },
    30000,
  );

  test.skipIf(!DATABASE_URL)(
    "backfill rejects malformed canonical data without changing IDs or hashes",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      const run = () =>
        promisify(execFile)(
          process.execPath,
          [
            fileURLToPath(
              new URL("../../scripts/source-ownership.mjs", import.meta.url),
            ),
            "backfill",
            "--legacy-source",
            SOURCE_ID,
          ],
          { env: { ...process.env, DATABASE_URL: databaseUrl() } },
        );
      try {
        await truncate(database);
        const original = request({
          session_id: "canonical",
          start_user_message_id: "start",
          end_user_message_id: "end",
          messages: [{ role: "user", text: "original" }],
        });
        const job = await database.enqueue({
          ...original,
          source_id: SOURCE_ID,
        });
        await database.pool.query(
          "UPDATE extraction_jobs SET source_id = NULL; UPDATE segment_targets SET source_id = NULL",
        );
        await database.pool.query(
          "UPDATE extraction_jobs SET payload = jsonb_set(payload, '{messages,0,text}', '\"tampered\"')",
        );
        const before = (
          await database.pool.query("SELECT * FROM extraction_jobs")
        ).rows;
        await expect(run()).rejects.toThrow();
        expect(
          (await database.pool.query("SELECT * FROM extraction_jobs")).rows,
        ).toEqual(before);
        await database.pool.query(
          "UPDATE extraction_jobs SET payload = $1::jsonb",
          [JSON.stringify(original)],
        );
        const invalidId = randomUUID();
        await database.pool.query(
          "UPDATE extraction_jobs SET segment_id = $1",
          [invalidId],
        );
        await database.pool.query(
          "UPDATE segment_targets SET segment_id = $1",
          [invalidId],
        );
        await expect(run()).rejects.toThrow();
        expect(
          (
            await database.pool.query(
              "SELECT segment_id, source_id, source_fingerprint FROM extraction_jobs",
            )
          ).rows,
        ).toEqual([
          {
            segment_id: invalidId,
            source_id: null,
            source_fingerprint: sourceFingerprint(original),
          },
        ]);
        await database.pool.query(
          "UPDATE extraction_jobs SET segment_id = $1",
          [job.segment_id],
        );
        await database.pool.query(
          "UPDATE segment_targets SET segment_id = $1",
          [job.segment_id],
        );
        await run();
        const after = (
          await database.pool.query(
            "SELECT segment_id, source_fingerprint, payload, source_id FROM extraction_jobs",
          )
        ).rows[0];
        expect(after).toEqual({
          segment_id: job.segment_id,
          source_fingerprint: sourceFingerprint(original),
          payload: original,
          source_id: SOURCE_ID,
        });
      } finally {
        await database.close();
      }
    },
  );
  test.skipIf(!DATABASE_URL)(
    "guards index cutover and resumes ownership enforcement without replacing UUID keys",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      const run = (...args: string[]) =>
        execFileSync(
          process.execPath,
          [
            fileURLToPath(
              new URL("../../scripts/source-ownership.mjs", import.meta.url),
            ),
            ...args,
          ],
          {
            env: { ...process.env, DATABASE_URL: databaseUrl() },
            stdio: "pipe",
          },
        ).toString();
      try {
        await truncate(database);
        await database.pool.query("DROP INDEX segments_source_v1_start_key");
        await expect(database.open()).rejects.toThrow("indexes are not ready");
        await database.pool.query(
          "CREATE UNIQUE INDEX segments_source_v1_start_key ON segments(id)",
        );
        expect(() => run("install-indexes")).toThrow();
        await database.pool.query("DROP INDEX segments_source_v1_start_key");
        run("install-indexes");
        expect(() => run("enforce")).toThrow();
        const enqueued = await database.enqueue({
          ...request({
            session_id: "enforce",
            start_user_message_id: "start",
            end_user_message_id: "end",
            messages: [{ role: "user", text: "source" }],
          }),
          source_id: SOURCE_ID,
        });
        await database.pool.query(
          "UPDATE extraction_jobs SET source_id = NULL; UPDATE segment_targets SET source_id = NULL",
        );
        expect(() => run("enforce", "--old-writers-stopped")).toThrow();
        await database.pool.query(
          'UPDATE segment_targets SET payload = payload || \'{"source_id":"wrong"}\'::jsonb',
        );
        expect(() => run("backfill", "--legacy-source", SOURCE_ID)).toThrow();
        expect(
          (
            await database.pool.query(
              "SELECT source_id FROM extraction_jobs WHERE id = $1",
              [enqueued.id],
            )
          ).rows[0]?.source_id,
        ).toBeNull();
        await database.pool.query(
          "UPDATE segment_targets SET payload = payload - 'source_id'",
        );
        run("backfill", "--legacy-source", SOURCE_ID, "--batch-size", "1");
        expect(run("enforce", "--old-writers-stopped")).toContain(
          "ownership enforced",
        );
        expect(run("enforce", "--old-writers-stopped")).toContain(
          "ownership enforced",
        );
        await expect(
          database.pool.query("UPDATE extraction_jobs SET source_id = NULL"),
        ).rejects.toThrow();
        const primary = (
          await database.pool.query(
            "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'segments'::regclass AND contype = 'p'",
          )
        ).rows[0];
        expect(primary?.definition).toBe("PRIMARY KEY (id)");
        const claimsFk = (
          await database.pool.query(
            "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'claims'::regclass AND confrelid = 'segments'::regclass",
          )
        ).rows[0];
        expect(claimsFk?.definition).toContain(
          "FOREIGN KEY (segment_id) REFERENCES segments(id)",
        );
      } finally {
        // Restore the expansion phase for the historical raw-SQL fixtures below.
        await database.pool.query(
          "ALTER TABLE segment_targets DROP CONSTRAINT IF EXISTS segment_targets_owned_job_fkey",
        );
        for (const table of [
          "segments",
          "extraction_jobs",
          "segment_targets",
        ]) {
          await database.pool.query(
            `ALTER TABLE ${table} ALTER COLUMN source_id DROP NOT NULL, DROP CONSTRAINT IF EXISTS ${table}_source_owned`,
          );
        }
        await database.close();
      }
    },
  );

  test.skipIf(!DATABASE_URL)(
    "isolates identical boundaries and rejects forged claims and contradictory payload owners",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      try {
        await truncate(database);
        const secondSource: SourceInfo = {
          id: "test-v2",
          kind: "opencode-v2",
          identity_scheme: "source-v1",
        };
        await database.pool.query(
          "INSERT INTO reflection_sources VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
          [secondSource.id, secondSource.kind, secondSource.identity_scheme],
        );
        const legacy = {
          ...request({
            session_id: "same",
            start_user_message_id: "start",
            end_user_message_id: "end",
            messages: [{ role: "user", text: "same content" }],
          }),
          source_id: SOURCE_ID,
        };
        const modern = { ...legacy, source_id: secondSource.id };
        await expect(
          database.enqueue({ ...modern, source_id: "unknown" }),
        ).rejects.toThrow("unknown source");
        const first = await database.enqueue(legacy);
        const second = await database.enqueue(modern);
        expect(first.segment_id).toBe(segmentIdForRequest(legacy));
        expect(second.segment_id).toBe(
          sourceSegmentIdForRequest(modern, secondSource),
        );
        expect(second.segment_id).not.toBe(first.segment_id);
        expect(await database.getJob(secondSource.id, first.id)).toBeNull();
        expect(
          await database.retryFailedJob(secondSource.id, first.id),
        ).toBeNull();
        expect(
          await database.supersedeFailedJob(secondSource.id, first.id),
        ).toBeNull();
        await expect(database.getJob("unknown", first.id)).rejects.toThrow(
          "unknown source",
        );
        await expect(
          database.getSegment("unknown", first.segment_id),
        ).rejects.toThrow("unknown source");
        await expect(
          database.sessionSegmentListing("unknown", "same"),
        ).rejects.toThrow("unknown source");
        await expect(
          database.priorSummaries("unknown", "same", first.segment_id),
        ).rejects.toThrow("unknown source");
        const modernClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client, [
              { sourceId: SOURCE_ID, sessionId: "same" },
            ]),
          ),
        );
        expect(modernClaim.id).toBe(second.id);
        expect(modernClaim.sourceId).toBe(secondSource.id);
        const legacyClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        const extraction = validatedExtractionResult({
          summary: "modern summary",
          claims: [],
        });
        for (const forged of [
          { ...modernClaim, sourceId: SOURCE_ID },
          { ...modernClaim, id: legacyClaim.id },
          { ...modernClaim, segmentId: first.segment_id },
          {
            ...modernClaim,
            request: { ...modernClaim.request, source_id: SOURCE_ID },
          },
        ]) {
          await expect(
            database.publishExtraction(forged, extraction),
          ).rejects.toThrow();
          await expect(
            database.finishFailedAttempt(forged, "forged", {
              retryAfterSeconds: null,
            }),
          ).rejects.toThrow();
          await expect(
            database.commitResolution(
              forged,
              extraction,
              emptyPrepared(forged, extraction.summary),
            ),
          ).rejects.toThrow();
        }
        expect(
          (await database.getJob(secondSource.id, second.id))?.status,
        ).toBe("running");
        await database.publishExtraction(modernClaim, extraction);
        await database.commitResolution(
          modernClaim,
          extraction,
          emptyPrepared(modernClaim, extraction.summary),
        );
        expect(
          await database.getSegment(SOURCE_ID, second.segment_id),
        ).toBeNull();
        expect(
          (await database.getSegment(secondSource.id, second.segment_id))
            ?.source_id,
        ).toBe(secondSource.id);
        expect(await database.segmentSummaries(SOURCE_ID, "same")).toEqual([]);
        expect(
          (await database.segmentSummaries(secondSource.id, "same"))[0]
            ?.summary,
        ).toBe(extraction.summary);
        await database.pool.query(
          "UPDATE segments SET source_id = $1 WHERE id = $2",
          [SOURCE_ID, second.segment_id],
        );
        await expect(database.enqueue(modern)).rejects.toThrow(
          "contradictory segment ownership",
        );
        await database.pool.query(
          "UPDATE segments SET source_id = $1 WHERE id = $2",
          [secondSource.id, second.segment_id],
        );
        await database.pool.query(
          "UPDATE segment_targets SET source_id = $1 WHERE segment_id = $2",
          [secondSource.id, first.segment_id],
        );
        await expect(
          database.publishExtraction(legacyClaim, extraction),
        ).rejects.toThrow("contradictory segment ownership");
        expect((await database.getJob(SOURCE_ID, first.id))?.status).toBe(
          "running",
        );
        await database.pool.query(
          "UPDATE segment_targets SET source_id = $1 WHERE segment_id = $2",
          [SOURCE_ID, first.segment_id],
        );
        await database.finishFailedAttempt(legacyClaim, "failed", {
          retryAfterSeconds: null,
        });
        await database.pool.query(
          "UPDATE segment_targets SET payload = payload || jsonb_build_object('source_id', $1::text) WHERE segment_id = $2",
          [secondSource.id, first.segment_id],
        );
        for (const operation of [
          () => database.enqueue(legacy),
          () => database.retryFailedJob(SOURCE_ID, first.id),
          () => database.supersedeFailedJob(SOURCE_ID, first.id),
        ])
          await expect(operation()).rejects.toThrow();
        expect((await database.getJob(SOURCE_ID, first.id))?.status).toBe(
          "failed",
        );
        expect(
          (
            await database.pool.query(
              "SELECT payload->>'source_id' AS source FROM segment_targets WHERE segment_id = $1",
              [first.segment_id],
            )
          ).rows[0]?.source,
        ).toBe(secondSource.id);
      } finally {
        await database.close();
      }
    },
  );

  test.skipIf(!DATABASE_URL)(
    "keeps null-owned legacy jobs, manifests, and recall available during bounded backfill",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      const run = (...args: string[]) =>
        execFileSync(
          process.execPath,
          [
            fileURLToPath(
              new URL("../../scripts/source-ownership.mjs", import.meta.url),
            ),
            ...args,
          ],
          { env: { ...process.env, DATABASE_URL: databaseUrl() } },
        ).toString();
      try {
        await truncate(database);
        const source = {
          ...request({
            session_id: "legacy-backfill",
            start_user_message_id: "start",
            end_user_message_id: "end",
            messages: [{ role: "user", text: "source" }],
          }),
          source_id: SOURCE_ID,
        };
        const enqueued = await database.enqueue(source);
        await database.pool.query(
          "UPDATE extraction_jobs SET source_id = NULL; UPDATE segment_targets SET source_id = NULL",
        );
        expect((await database.getJob(SOURCE_ID, enqueued.id))?.source_id).toBe(
          SOURCE_ID,
        );
        expect(
          (
            await database.sessionSegmentListing(SOURCE_ID, source.session_id)
          )[2],
        ).toHaveLength(1);
        expect(
          await withClient(database, (client) =>
            database.claimOldestJob(client, [
              { sourceId: SOURCE_ID, sessionId: source.session_id },
            ]),
          ),
        ).toBeNull();
        const claim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(claim.sourceId).toBe(SOURCE_ID);
        await completeResolution(
          database,
          claim,
          preparedSegment(claim, {
            endId: "end",
            summary: "legacy summary",
            subjectId: randomUUID(),
            objectId: randomUUID(),
            entitiesAreNew: true,
          }),
        );
        await database.pool.query("UPDATE segments SET source_id = NULL");
        const direct = await database.directClaims(EMBEDDING);
        expect(direct).toHaveLength(2);
        expect(direct.every((row) => row.sourceId === SOURCE_ID)).toBe(true);
        const neighbor = await database.neighboringClaims(
          required(direct[0]).subjectEntityId,
          EMBEDDING,
          0.8,
        );
        expect(neighbor.every((row) => row.sourceId === SOURCE_ID)).toBe(true);
        const support = await database.supportForEquivalenceKeys(
          direct.map((row) => row.equivalenceKey),
        );
        expect([...support.values()][0]?.segments).toEqual([
          { source_id: SOURCE_ID, segment_id: enqueued.segment_id },
        ]);
        await database.pool.query(
          "INSERT INTO reflection_sources VALUES ('backfill-v2', 'opencode-v2', 'source-v1') ON CONFLICT DO NOTHING",
        );
        const modernJob = await database.enqueue({
          ...source,
          source_id: "backfill-v2",
        });
        const modernClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        const shared = required(
          direct.find((row) => row.objectEntityId !== null),
        );
        await completeResolution(
          database,
          modernClaim,
          preparedSegment(modernClaim, {
            endId: "end",
            summary: "modern summary",
            subjectId: shared.subjectEntityId,
            objectId: required(shared.objectEntityId),
            entitiesAreNew: false,
          }),
        );
        const combined = required(
          (
            await database.supportForEquivalenceKeys([shared.equivalenceKey])
          ).get(shared.equivalenceKey),
        );
        expect(combined.sessionCount).toBe(2);
        expect(combined.supportCount).toBe(2);
        expect(combined.segments).toEqual(
          expect.arrayContaining([
            { source_id: SOURCE_ID, segment_id: enqueued.segment_id },
            { source_id: "backfill-v2", segment_id: modernJob.segment_id },
          ]),
        );
        expect(
          run("backfill", "--legacy-source", SOURCE_ID, "--batch-size", "1"),
        ).toContain("backfilled 1");
        expect(
          run("backfill", "--legacy-source", SOURCE_ID, "--batch-size", "1"),
        ).toContain("backfilled 0");
        expect(
          (await database.directClaims(EMBEDDING)).filter(
            (row) => row.sourceId === SOURCE_ID,
          ),
        ).toEqual(direct);
        expect(
          (
            await database.sessionSegmentListing(SOURCE_ID, source.session_id)
          )[0][0]?.summary,
        ).toBe("legacy summary");
        await expect(
          database.pool.query(
            "UPDATE reflection_sources SET identity_scheme = 'source-v1' WHERE source_id = $1",
            [SOURCE_ID],
          ),
        ).rejects.toThrow("immutable");
      } finally {
        await database.close();
      }
    },
  );

  test.skipIf(!DATABASE_URL)(
    "reports bounded queue diagnostics without source payloads or raw errors",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      try {
        await truncate(database);
        const jobs = [];
        for (const name of [
          "due",
          "delayed",
          "running",
          "rate-limited",
          "invalid",
          "succeeded",
          "superseded",
        ]) {
          jobs.push(
            await database.enqueue({
              ...request({
                session_id: "queue-status",
                start_user_message_id: name,
                end_user_message_id: name,
                messages: [{ role: "user", text: name }],
              }),
              source_id: SOURCE_ID,
            }),
          );
        }
        const due = required(jobs[0]);
        const delayed = required(jobs[1]);
        const running = required(jobs[2]);
        const rateLimited = required(jobs[3]);
        const invalid = required(jobs[4]);
        const succeeded = required(jobs[5]);
        const superseded = required(jobs[6]);

        await database.pool.query(
          `UPDATE extraction_jobs
           SET next_attempt_at = now() + INTERVAL '1 hour',
               error = 'UpstreamTimeoutError: upstream request timed out'
           WHERE id = $1`,
          [delayed.id],
        );
        await database.pool.query(
          `UPDATE extraction_jobs
           SET status = 'running', lease_id = $2, attempts = 1,
               started_at = now() - INTERVAL '2 minutes'
           WHERE id = $1`,
          [running.id, randomUUID()],
        );
        await database.pool.query(
          `UPDATE extraction_jobs
           SET status = 'failed', attempts = 3, finished_at = now() - INTERVAL '10 minutes',
               error = CASE id
                   WHEN $1 THEN 'UpstreamRequestError: upstream request failed: 429 Too Many Requests'
                    WHEN $2 THEN 'TerminalExtractionValidationError: generated embedding input is 40000 UTF-8 bytes; maximum is 30000'
               END
           WHERE id = ANY($3::bigint[])`,
          [rateLimited.id, invalid.id, [rateLimited.id, invalid.id]],
        );
        await database.pool.query(
          `UPDATE extraction_jobs
           SET status = 'succeeded', payload = NULL,
               finished_at = now() - INTERVAL '30 minutes'
           WHERE id = $1`,
          [succeeded.id],
        );
        await database.pool.query(
          `UPDATE extraction_jobs
           SET status = 'superseded', payload = NULL,
               finished_at = now() - INTERVAL '2 days'
           WHERE id = $1`,
          [superseded.id],
        );

        const status = await database.queueStatus();

        expect(status.job_counts).toEqual({
          total: 7,
          pending: 2,
          running: 1,
          succeeded: 1,
          failed: 2,
          superseded: 1,
        });
        expect(status.target_counts).toEqual(status.job_counts);
        expect(status.pending_due).toBe(1);
        expect(status.pending_delayed).toBe(1);
        expect(status.oldest_due_job).toMatchObject({
          id: due.id,
          attempts: 0,
          processing_priority: 0,
        });
        expect(status.oldest_due_job?.age_seconds).toBeGreaterThanOrEqual(0);
        expect(status.running_jobs).toHaveLength(1);
        expect(status.running_jobs[0]).toMatchObject({
          id: running.id,
          attempts: 1,
          processing_priority: 0,
        });
        expect(status.running_jobs[0]?.age_seconds).toBeGreaterThanOrEqual(119);
        expect(status.running_jobs_truncated).toBe(false);
        expect(status.failure_categories).toEqual([
          {
            category: "TerminalExtractionValidationError",
            count: 1,
            pending: 0,
            failed: 1,
            latest_finished_at: expect.any(String),
          },
          {
            category: "UpstreamHttp429",
            count: 1,
            pending: 0,
            failed: 1,
            latest_finished_at: expect.any(String),
          },
          {
            category: "UpstreamTimeoutError",
            count: 1,
            pending: 1,
            failed: 0,
            latest_finished_at: null,
          },
        ]);
        expect(status.failure_categories_truncated).toBe(false);
        expect(status.recent_terminal_jobs).toEqual([
          { window_seconds: 300, succeeded: 0, failed: 0 },
          { window_seconds: 3_600, succeeded: 1, failed: 2 },
          { window_seconds: 86_400, succeeded: 1, failed: 2 },
        ]);
        expect(JSON.stringify(status)).not.toContain("Too Many Requests");
        expect(JSON.stringify(status)).not.toContain("messages");

        const writer = new Client({ connectionString: databaseUrl() });
        await writer.connect();
        const originalConnect = database.pool.connect.bind(database.pool);
        const connectSpy = vi.spyOn(database.pool, "connect");
        connectSpy.mockImplementationOnce((async () => {
          const client = await originalConnect();
          const originalQuery = client.query;
          const runQuery = originalQuery.bind(client) as unknown as (
            text: string,
            values?: unknown[],
          ) => Promise<unknown>;
          client.query = (async (text: string, values?: unknown[]) => {
            const result = await runQuery(text, values);
            if (text.startsWith("BEGIN TRANSACTION")) {
              client.query = originalQuery;
              await writer.query(
                `UPDATE extraction_jobs
                   SET status = 'running', lease_id = $2, attempts = 1,
                       started_at = clock_timestamp()
                   WHERE id = $1`,
                [due.id, randomUUID()],
              );
            }
            return result;
          }) as typeof client.query;
          return client;
        }) as typeof database.pool.connect);
        try {
          const interleaved = await database.queueStatus();
          const claimed = required(
            interleaved.running_jobs.find((job) => job.id === due.id),
          );
          expect(claimed.age_seconds).toBeGreaterThanOrEqual(0);
          expect(Date.parse(interleaved.observed_at)).toBeGreaterThanOrEqual(
            Date.parse(required(claimed.started_at)),
          );
        } finally {
          connectSpy.mockRestore();
          await writer.end();
        }
      } finally {
        await database.close();
      }
    },
    30_000,
  );

  test.skipIf(!DATABASE_URL)(
    "preserves queue fencing, replacement, retry, and recall semantics",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      try {
        await truncate(database);
        const firstRequest = request({
          session_id: "session",
          start_user_message_id: "start",
          end_user_message_id: "end-1",
          projection_version: 1,
          messages: [{ role: "user", text: "hello" }],
        });

        const first = await database.enqueue({
          ...firstRequest,
          source_id: SOURCE_ID,
        });
        const duplicate = await database.enqueue({
          ...updateRequest(firstRequest, { messages: firstRequest.messages }),
          source_id: SOURCE_ID,
        });
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
        const changed = await database.enqueue({
          ...changedRequest,
          source_id: SOURCE_ID,
        });
        expect(changed.id).toBe(first.id);
        expect(changed.status).toBe("running");

        expect(await database.segmentSummaries(SOURCE_ID, "session")).toEqual(
          [],
        );
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
        expect(
          await database.getSegment(SOURCE_ID, first.segment_id),
        ).toBeNull();

        await completeResolution(database, currentClaim, firstPrepared);
        const tail = await database.enqueue({
          ...updateRequest(changedRequest, { end_user_message_id: "end-2" }),
          source_id: SOURCE_ID,
        });
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

        const segment = required(
          await database.getSegment(SOURCE_ID, first.segment_id),
        );
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
          SOURCE_ID,
          "session",
          first.segment_id,
        );
        const segmentSummaries = await database.segmentSummaries(
          SOURCE_ID,
          "session",
        );

        expect(segment).toHaveProperty("end_user_message_id", "end-2");
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
        expect(required(segmentSummaries[0])).toHaveProperty(
          "end_user_message_id",
          "end-2",
        );
        expect(required(segmentSummaries[0]).summary).toBe(
          "Latest tail snapshot",
        );

        const legacyRequest = request({
          session_id: "session",
          start_user_message_id: "legacy-start",
          end_user_message_id: "legacy-end",
          messages: [{ role: "user", text: "legacy" }],
        });
        const legacyJob = await database.enqueue({
          ...legacyRequest,
          source_id: SOURCE_ID,
        });
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
        const mixedSummaries = await database.segmentSummaries(
          SOURCE_ID,
          "session",
        );
        expect(new Set(mixedSummaries.map((item) => item.id))).toEqual(
          new Set([first.segment_id, legacyJob.segment_id]),
        );
        expect(
          new Set(mixedSummaries.map((item) => item.projection_version)),
        ).toEqual(new Set([0, 1]));

        const safeJob = await database.enqueue({
          ...updateRequest(legacyRequest, { projection_version: 1 }),
          source_id: SOURCE_ID,
        });
        expect(safeJob.id).toBe(legacyJob.id);
        expect(safeJob.status).toBe("pending");
        expect(
          new Set(
            (await database.segmentSummaries(SOURCE_ID, "session")).map(
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
            (await database.segmentSummaries(SOURCE_ID, "session")).map(
              (item) => item.summary,
            ),
          ),
        ).not.toContain("Unsafe legacy summary");
        const retriedSafeJob = required(
          await database.retryFailedJob(SOURCE_ID, safeJob.id),
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
            (await database.segmentSummaries(SOURCE_ID, "session")).map(
              (item) => item.summary,
            ),
          ),
        ).toEqual(new Set(["Latest tail snapshot", "Projection-safe summary"]));
        const downgradeJob = await database.enqueue({
          ...updateRequest(legacyRequest, {
            end_user_message_id: "legacy-end-2",
          }),
          source_id: SOURCE_ID,
        });
        expect(downgradeJob).toMatchObject({
          status: "superseded",
          error: "snapshot was superseded",
        });
        const preserved = required(
          await database.getSegment(SOURCE_ID, safeJob.segment_id),
        );
        expect(preserved.summary).toBe("Projection-safe summary");
        expect(preserved).toHaveProperty("end_user_message_id", "legacy-end");

        const forwardJob = await database.enqueue({
          ...updateRequest(legacyRequest, {
            end_user_message_id: "legacy-end-2",
            projection_version: 1,
          }),
          source_id: SOURCE_ID,
        });
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

        const rewindJob = await database.enqueue({
          ...updateRequest(legacyRequest, { projection_version: 1 }),
          source_id: SOURCE_ID,
        });
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
        const rewound = required(
          await database.getSegment(SOURCE_ID, safeJob.segment_id),
        );
        expect(rewound.summary).toBe("Projection-safe rewind snapshot");
        expect(rewound).toHaveProperty("end_user_message_id", "legacy-end");

        const pendingFuture = await database.enqueue({
          ...updateRequest(legacyRequest, {
            end_user_message_id: "legacy-end-3",
            projection_version: 1,
          }),
          source_id: SOURCE_ID,
        });
        const replayCurrent = await database.enqueue({
          ...updateRequest(legacyRequest, { projection_version: 1 }),
          source_id: SOURCE_ID,
        });
        expect(replayCurrent.status).toBe("pending");
        expect(
          await database.getJob(SOURCE_ID, pendingFuture.id),
        ).toMatchObject({
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
        const pendingLegacy = await database.enqueue({
          ...pendingUpgradeRequest,
          source_id: SOURCE_ID,
        });
        const pendingSafe = await database.enqueue({
          ...updateRequest(pendingUpgradeRequest, { projection_version: 2 }),
          source_id: SOURCE_ID,
        });
        expect(pendingSafe.id).toBe(pendingLegacy.id);
        expect(pendingSafe.projection_version).toBe(2);
        const pendingDowngrade = await database.enqueue({
          ...updateRequest(pendingUpgradeRequest, {
            end_user_message_id: "pending-downgrade",
            projection_version: 1,
          }),
          source_id: SOURCE_ID,
        });
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
        const supportJob = await database.enqueue({
          ...supportRequest,
          source_id: SOURCE_ID,
        });
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
        expect(
          new Set(support.segments.map((segment) => segment.segment_id)),
        ).toEqual(new Set([first.segment_id, supportJob.segment_id]));

        const emptySharedJob = await database.enqueue({
          ...updateRequest(firstRequest, { end_user_message_id: "end-3" }),
          source_id: SOURCE_ID,
        });
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
        expect(
          pendingSupport.segments.map((segment) => segment.segment_id),
        ).toEqual([supportJob.segment_id]);

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

        await database.retryFailedJob(SOURCE_ID, emptySharedJob.id);
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
        await database.enqueue({ ...orphanRequest, source_id: SOURCE_ID });
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
        await database.enqueue({
          ...updateRequest(orphanRequest, {
            end_user_message_id: "orphan-end-2",
          }),
          source_id: SOURCE_ID,
        });
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

        const oldSnapshot = await database.enqueue({
          ...updateRequest(firstRequest, {
            start_user_message_id: "blocked-tail",
            end_user_message_id: "old",
          }),
          source_id: SOURCE_ID,
        });
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
        const newerSnapshot = await database.enqueue({
          ...updateRequest(firstRequest, {
            start_user_message_id: "blocked-tail",
            end_user_message_id: "new",
          }),
          source_id: SOURCE_ID,
        });
        const retryError = await database
          .retryFailedJob(SOURCE_ID, oldSnapshot.id)
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
        const retryJob = await database.enqueue({
          ...retryRequest,
          source_id: SOURCE_ID,
        });
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
        const exactFailedReplay = await database.enqueue({
          ...updateRequest(retryRequest, { processing_priority: 100 }),
          source_id: SOURCE_ID,
        });
        expect(exactFailedReplay).toMatchObject({
          id: retryJob.id,
          status: "failed",
          attempts: terminalClaim.attempts,
          error: "terminal",
        });
        const retried = required(
          await database.retryFailedJob(SOURCE_ID, retryJob.id),
        );
        expect(retried.attempts).toBe(0);
        const retriedClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(retriedClaim.leaseId).not.toBe(terminalClaim.leaseId);
        await database.applyMigrations(MIGRATIONS_DIR);
        const stillRunning = required(
          await database.getJob(SOURCE_ID, retriedClaim.id),
        );
        expect(stillRunning.status).toBe("running");
        expect(
          await database.finishFailedAttempt(
            terminalClaim,
            "stale after explicit retry",
            { retryAfterSeconds: null },
          ),
        ).toBe(false);

        const newer = await database.enqueue({
          ...updateRequest(firstRequest, {
            start_user_message_id: "newer",
            end_user_message_id: "newer-end",
          }),
          source_id: SOURCE_ID,
        });
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
        expect(
          required(await database.getJob(SOURCE_ID, retried.id)).status,
        ).toBe("pending");
      } finally {
        await database.close();
      }
    },
    30_000,
  );

  test.skipIf(!DATABASE_URL)(
    "does not rewrite existing aliases and persists newly learned aliases",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      try {
        await truncate(database);
        const firstRequest = request({
          session_id: "alias-session",
          start_user_message_id: "start",
          end_user_message_id: "end-1",
          projection_version: 1,
          messages: [{ role: "user", text: "Reflection uses PostgreSQL." }],
        });
        const firstJob = await database.enqueue({
          ...firstRequest,
          source_id: SOURCE_ID,
        });
        const firstClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        const subjectId = randomUUID();
        const objectId = randomUUID();
        const firstPrepared = preparedSegment(firstClaim, {
          endId: "end-1",
          summary: "Reflection uses PostgreSQL.",
          subjectId,
          objectId,
          entitiesAreNew: true,
        });
        await completeResolution(database, firstClaim, {
          ...firstPrepared,
          entities: firstPrepared.entities.map((entity) => ({
            ...entity,
            aliases:
              entity.id === objectId
                ? [
                    "Postgres",
                    ...Array.from(
                      { length: 15 },
                      (_, index) => `Historical alias ${index}`,
                    ),
                  ]
                : entity.aliases,
          })),
        });
        const initialAlias = required(
          (
            await database.pool.query<
              QueryResultRow & { alias: string; row_version: string }
            >(
              `
              SELECT alias, xmin::text AS row_version
              FROM entity_aliases
              WHERE entity_id = $1 AND normalized_alias = 'postgres'
              `,
              [objectId],
            )
          ).rows[0],
        );
        const boundedCandidate = (
          await database.entityCandidates("Postgres", EMBEDDING)
        ).find((candidate) => candidate.id === objectId);
        expect(required(boundedCandidate).aliases).toHaveLength(10);
        expect(required(boundedCandidate).aliases).toContain("Postgres");

        const secondJob = await database.enqueue({
          ...updateRequest(firstRequest, { end_user_message_id: "end-2" }),
          source_id: SOURCE_ID,
        });
        const secondClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(secondClaim.id).toBe(secondJob.id);
        const secondPrepared = preparedSegment(secondClaim, {
          endId: "end-2",
          summary: "Reflection still uses PostgreSQL.",
          subjectId,
          objectId,
          entitiesAreNew: false,
        });
        await completeResolution(database, secondClaim, {
          ...secondPrepared,
          entities: secondPrepared.entities.map((entity) => ({
            ...entity,
            aliases: entity.id === objectId ? ["POSTGRES", "PGSQL"] : [],
          })),
        });

        const aliases = await database.pool.query<
          QueryResultRow & {
            alias: string;
            normalized_alias: string;
            row_version: string;
          }
        >(
          `
          SELECT alias, normalized_alias, xmin::text AS row_version
          FROM entity_aliases
          WHERE entity_id = $1
            AND normalized_alias IN ('pgsql', 'postgres')
          ORDER BY normalized_alias
          `,
          [objectId],
        );
        expect(aliases.rows).toEqual([
          {
            alias: "PGSQL",
            normalized_alias: "pgsql",
            row_version: expect.any(String),
          },
          {
            alias: initialAlias.alias,
            normalized_alias: "postgres",
            row_version: initialAlias.row_version,
          },
        ]);
        expect(initialAlias.alias).toBe("Postgres");
        const learnedAliasCandidate = (
          await database.entityCandidates("PGSQL", EMBEDDING)
        ).find((candidate) => candidate.id === objectId);
        expect(required(learnedAliasCandidate).aliases).toContain("PGSQL");
        expect(firstJob.segment_id).toBe(secondJob.segment_id);
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
      await openDatabase(database);
      try {
        await truncate(database);
        const firstRequest = request({
          session_id: "running-session",
          start_user_message_id: "start",
          end_user_message_id: "A",
          projection_version: 1,
          messages: [{ role: "user", text: "A" }],
        });
        const firstJob = await database.enqueue({
          ...firstRequest,
          source_id: SOURCE_ID,
        });
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

        const secondJob = await database.enqueue({
          ...updateRequest(firstRequest, { end_user_message_id: "B" }),
          source_id: SOURCE_ID,
        });
        const secondClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(secondClaim.id).toBe(secondJob.id);
        expect(
          await database.segmentSummaries(SOURCE_ID, "running-session"),
        ).toEqual([]);
        const replay = await database.enqueue({
          ...firstRequest,
          source_id: SOURCE_ID,
        });
        expect(replay.id).toBe(firstJob.id);
        expect(replay.status).toBe("pending");
        expect(
          await database.segmentSummaries(SOURCE_ID, "running-session"),
        ).toEqual([]);

        expect(
          await completeResolution(
            database,
            secondClaim,
            emptyPrepared(secondClaim, "stale B"),
          ),
        ).toBe(false);
        const supersededJob = required(
          await database.getJob(SOURCE_ID, secondJob.id),
        );
        expect(supersededJob).toMatchObject({
          status: "superseded",
          error: "snapshot was superseded",
        });
        const staleResult = required(
          await database.getSegment(SOURCE_ID, firstJob.segment_id),
        );
        expect(staleResult).toHaveProperty("end_user_message_id", "A");
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
          await database.getSegment(SOURCE_ID, firstJob.segment_id),
        );
        expect(rewound).toHaveProperty("end_user_message_id", "A");
        expect(rewound.summary).toBe("A after stale B");

        const failingJob = await database.enqueue({
          ...updateRequest(firstRequest, { end_user_message_id: "failing-B" }),
          source_id: SOURCE_ID,
        });
        const failingClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(failingClaim.id).toBe(failingJob.id);
        await database.enqueue({ ...firstRequest, source_id: SOURCE_ID });
        expect(
          await database.finishFailedAttempt(failingClaim, "terminal failure", {
            retryAfterSeconds: null,
          }),
        ).toBe(true);
        expect(
          await database.segmentSummaries(SOURCE_ID, "running-session"),
        ).toEqual([]);
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
        const upgradeJob = await database.enqueue({
          ...upgradeRequest,
          source_id: SOURCE_ID,
        });
        const legacyClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(legacyClaim.id).toBe(upgradeJob.id);
        const deferredUpgrade = await database.enqueue({
          ...updateRequest(upgradeRequest, { projection_version: 1 }),
          source_id: SOURCE_ID,
        });
        expect(deferredUpgrade.status).toBe("running");
        expect(deferredUpgrade.projection_version).toBe(0);
        expect(
          await completeResolution(
            database,
            legacyClaim,
            emptyPrepared(legacyClaim, "Legacy"),
          ),
        ).toBe(false);
        const upgradedJob = required(
          await database.getJob(SOURCE_ID, upgradeJob.id),
        );
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
              (
                await database.segmentSummaries(SOURCE_ID, "running-session")
              ).map((item) => item.summary),
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
            (await database.segmentSummaries(SOURCE_ID, "running-session")).map(
              (item) => item.summary,
            ),
          ),
        ).toEqual(new Set(["A after failed B"]));
        const repaired = await database.enqueue({
          ...updateRequest(upgradeRequest, { projection_version: 1 }),
          source_id: SOURCE_ID,
        });
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
      await openDatabase(database);
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
          await database.enqueue({ ...source, source_id: SOURCE_ID });
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
          await database.priorSummaries(
            SOURCE_ID,
            "summary-session",
            firstSegmentId,
          ),
        ).toEqual(["Second summary"]);

        const changedSecond = updateRequest(secondRequest, {
          messages: [{ role: "user", text: "second corrected" }],
        });
        await database.enqueue({ ...changedSecond, source_id: SOURCE_ID });
        expect(
          await database.priorSummaries(
            SOURCE_ID,
            "summary-session",
            firstSegmentId,
          ),
        ).toEqual([]);
        expect(
          (await database.segmentSummaries(SOURCE_ID, "summary-session")).map(
            (segment) => segment.id,
          ),
        ).toEqual([firstSegmentId]);
        let [summaries, boundaries, targets] =
          await database.sessionSegmentListing(SOURCE_ID, "summary-session");
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
        expect(
          targets.map((target) =>
            target.source_boundary_version === 3
              ? null
              : target.end_user_message_id,
          ),
        ).toEqual(["second-end"]);

        const futureSecond = updateRequest(secondRequest, {
          end_user_message_id: "second-future-end",
          messages: [
            { role: "user", text: "second" },
            { role: "assistant", text: "future" },
          ],
        });
        await database.enqueue({ ...futureSecond, source_id: SOURCE_ID });
        [, boundaries, targets] = await database.sessionSegmentListing(
          SOURCE_ID,
          "summary-session",
        );
        const secondBoundary = required(
          boundaries.find((boundary) => boundary.id === secondSegmentId),
        );
        expect(secondBoundary).toHaveProperty(
          "end_user_message_id",
          "second-end",
        );
        expect(secondBoundary.source_eligible).toBe(false);
        expect(
          targets.map((target) =>
            target.source_boundary_version === 3
              ? null
              : target.end_user_message_id,
          ),
        ).toEqual(["second-future-end"]);

        await database.enqueue({ ...secondRequest, source_id: SOURCE_ID });
        const stagedSecond = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(
          await database.publishExtraction(
            stagedSecond,
            validatedExtractionResult({
              summary: "Staged second summary",
              claims: [],
            }),
          ),
        ).toBe(true);
        expect(
          await database.priorSummaries(
            SOURCE_ID,
            "summary-session",
            firstSegmentId,
          ),
        ).toEqual(["Staged second summary"]);
        await database.pool.query(
          "UPDATE segments SET summary = 'corrupted' WHERE id = $1",
          [secondSegmentId],
        );
        expect(
          await database.priorSummaries(
            SOURCE_ID,
            "summary-session",
            firstSegmentId,
          ),
        ).toEqual(["Staged second summary"]);
        await database.pool.query(
          "UPDATE segment_targets SET summary_commit_fingerprint = repeat('0', 64) WHERE segment_id = $1",
          [secondSegmentId],
        );
        expect(
          await database.priorSummaries(
            SOURCE_ID,
            "summary-session",
            firstSegmentId,
          ),
        ).toEqual([]);
        expect(
          (await database.segmentSummaries(SOURCE_ID, "summary-session")).map(
            (segment) => segment.id,
          ),
        ).toEqual([firstSegmentId]);
        [summaries, boundaries] = await database.sessionSegmentListing(
          SOURCE_ID,
          "summary-session",
        );
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
    "requeues an exact committed source when its summary is empty",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      try {
        await truncate(database);
        const source = request({
          session_id: "empty-summary-session",
          start_user_message_id: "start",
          end_user_message_id: "end",
          projection_version: 1,
          messages: [{ role: "user", text: "source" }],
        });
        const initial = await database.enqueue({
          ...source,
          source_id: SOURCE_ID,
        });
        const claim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        await completeResolution(
          database,
          claim,
          emptyPrepared(claim, "Initial summary"),
        );
        const blankSummary =
          "\t\n\v\f\r \u00a0\u1680\u2000\u2007\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
        await database.pool.query(
          `UPDATE segments
           SET summary = $2::text,
               projection_commit_fingerprint = reflection_projection_fingerprint(
                   id,
                   source_boundary_version,
                   end_user_message_id,
                   end_source_message_id,
                   $2::text,
                   projection_version
               )
           WHERE id = $1`,
          [initial.segment_id, blankSummary],
        );

        const [summaries, boundaries] = await database.sessionSegmentListing(
          SOURCE_ID,
          "empty-summary-session",
        );
        expect(summaries).toEqual([]);
        expect(boundaries).toMatchObject([
          { id: initial.segment_id, source_eligible: false },
        ]);

        const requeued = await database.enqueue({
          ...source,
          source_id: SOURCE_ID,
        });
        expect(requeued).toMatchObject({
          id: initial.id,
          segment_id: initial.segment_id,
          status: "pending",
          source_fingerprint: sourceFingerprint(source),
        });
        const stagedBlank = { summary: blankSummary, claims: [] };
        await database.pool.query(
          `UPDATE segment_targets
           SET extraction_result = $2::jsonb,
               extraction_validation_version = 1,
               extraction_validation_fingerprint =
                   reflection_extraction_validation_fingerprint(
                       $2::jsonb, 1, source_fingerprint
                   ),
               summary_commit_fingerprint = reflection_projection_fingerprint(
                   segment_id,
                   source_boundary_version,
                   end_user_message_id,
                   end_source_message_id,
                   $3::text,
                   projection_version
               )
           WHERE segment_id = $1`,
          [initial.segment_id, JSON.stringify(stagedBlank), blankSummary],
        );
        const repairClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(repairClaim.extractionResult).toBeNull();
        await expect(
          database.publishExtraction(
            repairClaim,
            validatedExtractionResult(stagedBlank),
          ),
        ).rejects.toThrow(
          "extraction summary must contain non-whitespace text",
        );
        await completeResolution(
          database,
          repairClaim,
          emptyPrepared(repairClaim, "Repaired summary"),
        );
        expect(
          (
            await database.segmentSummaries(SOURCE_ID, "empty-summary-session")
          ).map((segment) => segment.summary),
        ).toEqual(["Repaired summary"]);
      } finally {
        await database.close();
      }
    },
    15_000,
  );

  test.skipIf(!DATABASE_URL)(
    "requeues a failed exact target when its staged extraction is stale",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      try {
        await truncate(database);
        const source = request({
          session_id: "stale-staged-session",
          start_user_message_id: "turn",
          end_user_message_id: "turn",
          messages: [{ role: "user", text: "stale staged source" }],
        });
        const enqueued = await database.enqueue({
          ...source,
          source_id: SOURCE_ID,
        });
        const claim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        const extraction = validatedExtractionResult({
          summary: "Staged under the old validator",
          claims: [],
        });
        expect(await database.publishExtraction(claim, extraction)).toBe(true);
        expect(
          await database.finishFailedAttempt(claim, "resolution failed", {
            retryAfterSeconds: null,
          }),
        ).toBe(true);
        await database.pool.query(
          `UPDATE segment_targets
           SET extraction_validation_version = 1,
               extraction_validation_fingerprint =
                   reflection_extraction_validation_fingerprint(
                       extraction_result, 1, source_fingerprint
                   )
           WHERE segment_id = $1`,
          [enqueued.segment_id],
        );

        expect(
          await database.segmentSummaries(SOURCE_ID, source.session_id),
        ).toEqual([]);
        const replayed = await database.enqueue({
          ...source,
          source_id: SOURCE_ID,
        });
        expect(replayed).toMatchObject({ id: enqueued.id, status: "pending" });
        const target = required(
          (
            await database.pool.query<
              QueryResultRow & { extraction_result: unknown | null }
            >(
              "SELECT extraction_result FROM segment_targets WHERE segment_id = $1",
              [enqueued.segment_id],
            )
          ).rows[0],
        );
        expect(target.extraction_result).toBeNull();
        const freshClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(freshClaim.extractionResult).toBeNull();
      } finally {
        await database.close();
      }
    },
  );

  test.skipIf(!DATABASE_URL)(
    "supports v2 siblings, priority, staged summaries, retries, and stale fencing",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
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
        const foregroundJob = await database.enqueue({
          ...foreground,
          source_id: SOURCE_ID,
        });
        const lowJob = await database.enqueue({
          ...lowPriority,
          source_id: SOURCE_ID,
        });
        expect(lowJob.segment_id).not.toBe(foregroundJob.segment_id);
        expect(lowJob).toHaveProperty("start_user_message_id", "turn");
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
        const foregroundExtraction = validatedExtractionResult({
          summary: "Foreground staged summary",
          claims: [],
        });
        expect(
          await database.publishExtraction(
            foregroundClaim,
            foregroundExtraction,
          ),
        ).toBe(true);
        let [summaries, boundaries, targets] =
          await database.sessionSegmentListing(SOURCE_ID, "v2-session");
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
        expect(
          await database.getSegment(SOURCE_ID, foregroundJob.segment_id),
        ).toBeNull();

        expect(
          await database.finishFailedAttempt(
            foregroundClaim,
            "resolution failed",
            { retryAfterSeconds: null },
          ),
        ).toBe(true);
        expect(
          (await database.segmentSummaries(SOURCE_ID, "v2-session")).map(
            (summary) => summary.summary,
          ),
        ).toEqual(["Foreground staged summary"]);
        expect(
          required(await database.retryFailedJob(SOURCE_ID, foregroundJob.id))
            .status,
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

        const promoted = await database.enqueue({
          ...updateRequest(lowPriority, { processing_priority: 100 }),
          source_id: SOURCE_ID,
        });
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
        const lowExtraction = validatedExtractionResult({
          summary: "First sibling committed",
          claims: [],
        });
        await database.publishExtraction(lowClaim, lowExtraction);
        expect(
          await database.finishFailedAttempt(lowClaim, "resolution failed", {
            retryAfterSeconds: null,
          }),
        ).toBe(true);
        await expect(
          database.pool.query(
            `UPDATE segment_targets
              SET extraction_result = jsonb_set(
                  extraction_result,
                  '{summary}',
                  '"rollback output"'::jsonb
              )
              WHERE segment_id = $1`,
            [lowJob.segment_id],
          ),
        ).rejects.toThrow("segment_targets_extraction_validation_check");
        await database.pool.query(
          `UPDATE segment_targets
           SET extraction_validation_version = 1,
               extraction_validation_fingerprint =
                   reflection_extraction_validation_fingerprint(
                       extraction_result, 1, source_fingerprint
                   )
           WHERE segment_id = $1`,
          [lowJob.segment_id],
        );
        expect(
          (await database.segmentSummaries(SOURCE_ID, "v2-session")).some(
            (summary) => summary.id === lowJob.segment_id,
          ),
        ).toBe(false);
        await database.retryFailedJob(SOURCE_ID, lowJob.id);
        const lowRetry = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(lowRetry.extractionResult).toBeNull();
        await database.publishExtraction(lowRetry, lowExtraction);
        await database.commitResolution(
          lowRetry,
          lowExtraction,
          preparedSegment(lowRetry, {
            endId: "turn",
            summary: lowExtraction.summary,
            subjectId,
            objectId,
            entitiesAreNew: true,
          }),
        );
        const committed = required(
          await database.getSegment(SOURCE_ID, lowJob.segment_id),
        );
        expect(committed.claims).toHaveLength(2);

        const advanced = updateRequest(lowPriority, {
          end_source_message_id: "source-b2",
          messages: [{ role: "user", text: "advanced sibling" }],
        });
        const advancedJob = await database.enqueue({
          ...advanced,
          source_id: SOURCE_ID,
        });
        expect(advancedJob.segment_id).toBe(lowJob.segment_id);
        expect(advancedJob.id).not.toBe(lowJob.id);
        expect(
          (await database.segmentSummaries(SOURCE_ID, "v2-session")).some(
            (summary) => summary.id === lowJob.segment_id,
          ),
        ).toBe(false);
        expect(
          required(await database.getSegment(SOURCE_ID, lowJob.segment_id))
            .claims,
        ).toHaveLength(2);
        const advancedClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        const advancedExtraction = validatedExtractionResult({
          summary: "Advanced staged summary",
          claims: [],
        });
        expect(
          await database.publishExtraction(advancedClaim, advancedExtraction),
        ).toBe(true);
        const advancedDuplicate = await database.enqueue({
          ...updateRequest(advanced, { processing_priority: 100 }),
          source_id: SOURCE_ID,
        });
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
        summaries = await database.segmentSummaries(SOURCE_ID, "v2-session");
        expect(
          summaries.find((summary) => summary.id === lowJob.segment_id)
            ?.summary,
        ).toBe("Advanced staged summary");
        expect(
          required(await database.getSegment(SOURCE_ID, lowJob.segment_id))
            .summary,
        ).toBe("First sibling committed");

        const newest = updateRequest(advanced, {
          messages: [{ role: "user", text: "newest corrected source" }],
        });
        await database.enqueue({ ...newest, source_id: SOURCE_ID });
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
          required(await database.getSegment(SOURCE_ID, lowJob.segment_id))
            .claims,
        ).toHaveLength(2);

        const newestClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        const newestExtraction = validatedExtractionResult({
          summary: "Newest staged summary",
          claims: [],
        });
        await database.publishExtraction(newestClaim, newestExtraction);
        expect(
          required(await database.getSegment(SOURCE_ID, lowJob.segment_id))
            .claims,
        ).toHaveLength(2);
        await database.finishFailedAttempt(newestClaim, "terminal resolution", {
          retryAfterSeconds: null,
        });
        [summaries, boundaries, targets] = await database.sessionSegmentListing(
          SOURCE_ID,
          "v2-session",
        );
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
      await openDatabase(database);
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
        const job = await database.enqueue({ ...source, source_id: SOURCE_ID });
        const claim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        const extraction = validatedExtractionResult({
          summary: "Unicode summary 😀",
          claims: [],
        });
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
          "008_extraction_validation.sql",
          "009_source_ownership_expansion.sql",
          "010_native_source_spans.sql",
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
        const validationFingerprints = required(
          (
            await database.pool.query<
              QueryResultRow & { current: string; other_source: string }
            >(
              `SELECT reflection_extraction_validation_fingerprint(
                          $1::jsonb, 1, $2::char(64)
                      ) AS current,
                      reflection_extraction_validation_fingerprint(
                          $1::jsonb, 1, $3::char(64)
                      ) AS other_source`,
              [
                JSON.stringify(extraction),
                sqlFingerprints.source_fingerprint,
                "0".repeat(64),
              ],
            )
          ).rows[0],
        );
        expect(validationFingerprints.current).not.toBe(
          validationFingerprints.other_source,
        );
        expect(job.segment_id).toBe(segmentIdForRequest(source));

        const unstagedSource = request({
          session_id: "old-writer-fence",
          start_user_message_id: "turn",
          end_user_message_id: "turn",
          messages: [{ role: "user", text: "The service uses ModelClient." }],
        });
        const unstaged = await database.enqueue({
          ...unstagedSource,
          source_id: SOURCE_ID,
        });
        const oldWriterExtraction = {
          summary: "The service uses ModelClinet.",
          claims: [],
        };
        await expect(
          database.pool.query(
            `UPDATE segment_targets
             SET extraction_result = $2::jsonb,
                 summary_commit_fingerprint = reflection_projection_fingerprint(
                     segment_id,
                     source_boundary_version,
                     end_user_message_id,
                     end_source_message_id,
                     $3::text,
                     projection_version
                 )
             WHERE segment_id = $1`,
            [
              unstaged.segment_id,
              JSON.stringify(oldWriterExtraction),
              oldWriterExtraction.summary,
            ],
          ),
        ).rejects.toThrow("segment_targets_extraction_validation_check");

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
    "invalidates and requeues failed staged extraction in migration 008",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      try {
        await truncate(database);
        const source = request({
          session_id: "validation-migration",
          start_user_message_id: "turn",
          end_user_message_id: "turn",
          messages: [{ role: "user", text: "The service uses ModelClient." }],
        });
        const job = await database.enqueue({ ...source, source_id: SOURCE_ID });
        const claim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(
          await database.publishExtraction(
            claim,
            validatedExtractionResult({
              summary: "The service uses ModelClient.",
              claims: [],
            }),
          ),
        ).toBe(true);
        expect(
          await database.finishFailedAttempt(claim, "resolution failed", {
            retryAfterSeconds: null,
          }),
        ).toBe(true);

        await database.pool.query(`
          ALTER TABLE segment_targets
              DROP CONSTRAINT segment_targets_extraction_validation_check,
              DROP COLUMN extraction_validation_version,
              DROP COLUMN extraction_validation_fingerprint;
          DELETE FROM reflection_schema_migrations
          WHERE name = '008_extraction_validation.sql';
        `);
        await database.applyMigrations(MIGRATIONS_DIR);

        const target = required(
          (
            await database.pool.query<
              QueryResultRow & {
                extraction_result: unknown | null;
                summary_commit_fingerprint: string | null;
                extraction_validation_version: number | null;
                extraction_validation_fingerprint: string | null;
              }
            >(
              `SELECT extraction_result, summary_commit_fingerprint,
                      extraction_validation_version,
                      extraction_validation_fingerprint
               FROM segment_targets
               WHERE segment_id = $1`,
              [job.segment_id],
            )
          ).rows[0],
        );
        expect(target).toEqual({
          extraction_result: null,
          summary_commit_fingerprint: null,
          extraction_validation_version: null,
          extraction_validation_fingerprint: null,
        });
        const requeued = required(
          (
            await database.pool.query<
              QueryResultRow & {
                status: string;
                attempts: number;
                error: string | null;
              }
            >(
              `SELECT status, attempts, error
               FROM extraction_jobs
               WHERE id = $1`,
              [job.id],
            )
          ).rows[0],
        );
        expect(requeued).toEqual({
          status: "pending",
          attempts: 0,
          error: null,
        });
        const freshClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(freshClaim.id).toBe(job.id);
        expect(freshClaim.extractionResult).toBeNull();
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
      await openDatabase(database);
      try {
        await truncate(database);
        const firstRequest = request({
          session_id: "concurrent-session",
          start_user_message_id: "start",
          end_user_message_id: "A",
          projection_version: 1,
          messages: [{ role: "user", text: "A" }],
        });
        await database.enqueue({ ...firstRequest, source_id: SOURCE_ID });
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
              database.enqueue({ ...changedRequest, source_id: SOURCE_ID }),
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
            database.enqueue({ ...nextRequest, source_id: SOURCE_ID }),
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
            database.enqueue({ ...finalRequest, source_id: SOURCE_ID }),
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
              claims, entity_aliases, entities, segments, extraction_jobs, reflection_sources CASCADE;
          DROP FUNCTION IF EXISTS reflection_immutable_source();
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
      await openDatabase(database);
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
          await database.getJob(SOURCE_ID, Number(unchangedFailedJobId)),
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
              claims, entity_aliases, entities, segments, extraction_jobs, reflection_sources CASCADE;
          DROP FUNCTION IF EXISTS reflection_immutable_source();
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
      await openDatabase(database);
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
        const invalidPayloadJob = required(await database.getJob(SOURCE_ID, 1));
        expect(invalidPayloadJob.status).toBe("failed");
        expect(invalidPayloadJob.error).toBe(
          "invalid persisted payload: payload is null",
        );
        const [, legacyBoundaries] = await database.sessionSegmentListing(
          SOURCE_ID,
          "legacy",
        );
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
              '006_canonical_source_spans.sql',
              '010_native_source_spans.sql'
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

        const replayedV0Target = await database.enqueue({
          ...v0TargetRequest,
          source_id: SOURCE_ID,
        });
        expect(replayedV0Target.status).toBe("failed");
        expect(replayedV0Target.attempts).toBe(3);
        const retriedFailed = required(
          await database.retryFailedJob(SOURCE_ID, Number(failedTarget.job_id)),
        );
        expect(retriedFailed.status).toBe("pending");
        expect(retriedFailed.attempts).toBe(0);
      } finally {
        await database.close();
      }
    },
    30_000,
  );

  test.skipIf(!DATABASE_URL)(
    "preserves staged extraction on ordinary retry and clears staged fields on restart extraction",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      try {
        await truncate(database);
        const req = request({
          session_id: "repair-session",
          start_user_message_id: "u1",
          end_user_message_id: "u1",
          source_boundary_version: 2,
          start_source_message_id: "s1",
          end_source_message_id: "s2",
          projection_version: 1,
          processing_priority: 75,
          messages: [{ role: "user", text: "test source content" }],
        });
        const job = await database.enqueue({ ...req, source_id: SOURCE_ID });

        const claim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(claim.id).toBe(job.id);
        expect(claim.extractionResult).toBeNull();

        const staged = validatedExtractionResult({
          summary: "Staged summary for repair",
          claims: [
            {
              subject: "Reflection",
              predicate: "supports",
              confidence: 1,
              object_entity: null,
              object_value: "repair endpoints",
            },
          ],
        });
        expect(await database.publishExtraction(claim, staged)).toBe(true);

        const targetBeforeFail = required(
          (
            await database.pool.query<
              {
                extraction_result: unknown;
                extraction_validation_version: number;
                extraction_validation_fingerprint: string;
                summary_commit_fingerprint: string;
                processing_priority: number;
              } & QueryResultRow
            >(
              "SELECT extraction_result, extraction_validation_version, " +
                "extraction_validation_fingerprint, summary_commit_fingerprint, " +
                "processing_priority FROM segment_targets WHERE segment_id = $1",
              [job.segment_id],
            )
          ).rows[0],
        );
        expect(targetBeforeFail.extraction_result).toEqual(staged);
        expect(targetBeforeFail.extraction_validation_version).toBe(
          EXTRACTION_VALIDATION_VERSION,
        );
        expect(targetBeforeFail.extraction_validation_fingerprint).toMatch(
          /^[0-9a-f]{64}$/,
        );
        expect(targetBeforeFail.summary_commit_fingerprint).toMatch(
          /^[0-9a-f]{64}$/,
        );
        expect(targetBeforeFail.processing_priority).toBe(75);

        expect(
          await database.finishFailedAttempt(
            claim,
            "resolution exhausted attempts",
            { retryAfterSeconds: null },
          ),
        ).toBe(true);
        const failedJob = required(await database.getJob(SOURCE_ID, job.id));
        expect(failedJob.status).toBe("failed");
        expect(failedJob.attempts).toBe(1);

        // Ordinary retry preserves staged extraction
        const retried = required(
          await database.retryFailedJob(SOURCE_ID, job.id),
        );
        expect(retried.status).toBe("pending");
        expect(retried.attempts).toBe(0);
        expect(retried.error).toBeNull();

        const targetAfterRetry = required(
          (
            await database.pool.query<
              {
                extraction_result: unknown;
                extraction_validation_version: number;
                extraction_validation_fingerprint: string;
                summary_commit_fingerprint: string;
                processing_priority: number;
              } & QueryResultRow
            >(
              "SELECT extraction_result, extraction_validation_version, " +
                "extraction_validation_fingerprint, summary_commit_fingerprint, " +
                "processing_priority FROM segment_targets WHERE segment_id = $1",
              [job.segment_id],
            )
          ).rows[0],
        );
        expect(targetAfterRetry.extraction_result).toEqual(staged);
        expect(targetAfterRetry.extraction_validation_version).toBe(
          EXTRACTION_VALIDATION_VERSION,
        );
        expect(targetAfterRetry.extraction_validation_fingerprint).toBe(
          targetBeforeFail.extraction_validation_fingerprint,
        );
        expect(targetAfterRetry.summary_commit_fingerprint).toBe(
          targetBeforeFail.summary_commit_fingerprint,
        );
        expect(targetAfterRetry.processing_priority).toBe(75);

        const retriedClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(retriedClaim.id).toBe(job.id);
        expect(retriedClaim.extractionResult).toEqual(staged);
        expect(retriedClaim.request.processing_priority).toBe(75);
        expect(retriedClaim.sourceFingerprint).toBe(sourceFingerprint(req));

        expect(
          await database.finishFailedAttempt(
            retriedClaim,
            "resolution exhausted attempts again",
            { retryAfterSeconds: null },
          ),
        ).toBe(true);

        // Restart extraction clears all four stage fields and resets job to pending
        const restarted = required(
          await database.retryFailedJob(SOURCE_ID, job.id, {
            restartExtraction: true,
          }),
        );
        expect(restarted.status).toBe("pending");
        expect(restarted.attempts).toBe(0);
        expect(restarted.error).toBeNull();

        const targetAfterRestart = required(
          (
            await database.pool.query<
              {
                extraction_result: unknown | null;
                extraction_validation_version: number | null;
                extraction_validation_fingerprint: string | null;
                summary_commit_fingerprint: string | null;
                processing_priority: number;
                source_generation: string;
                source_fingerprint: string;
              } & QueryResultRow
            >(
              "SELECT extraction_result, extraction_validation_version, " +
                "extraction_validation_fingerprint, summary_commit_fingerprint, " +
                "processing_priority, source_generation, source_fingerprint " +
                "FROM segment_targets WHERE segment_id = $1",
              [job.segment_id],
            )
          ).rows[0],
        );
        expect(targetAfterRestart.extraction_result).toBeNull();
        expect(targetAfterRestart.extraction_validation_version).toBeNull();
        expect(targetAfterRestart.extraction_validation_fingerprint).toBeNull();
        expect(targetAfterRestart.summary_commit_fingerprint).toBeNull();
        expect(targetAfterRestart.processing_priority).toBe(75);
        expect(targetAfterRestart.source_fingerprint).toBe(
          sourceFingerprint(req),
        );
        expect(BigInt(targetAfterRestart.source_generation)).toBe(1n);

        const restartedClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(restartedClaim.id).toBe(job.id);
        expect(restartedClaim.segmentId).toBe(job.segment_id);
        expect(restartedClaim.extractionResult).toBeNull();
        expect(restartedClaim.request.processing_priority).toBe(75);
        expect(restartedClaim.sourceGeneration).toBe(1n);
        expect(restartedClaim.sourceFingerprint).toBe(sourceFingerprint(req));
        expect(restartedClaim.request).toEqual(req);
      } finally {
        await database.close();
      }
    },
    30_000,
  );

  test.skipIf(!DATABASE_URL)(
    "supersedes failed jobs, removes targets from manifest, preserves committed segments, and rejects unretryable jobs",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      try {
        await truncate(database);

        // Missing job returns null
        expect(
          await database.supersedeFailedJob(SOURCE_ID, 999_999),
        ).toBeNull();

        // 1. Terminal failed job supersede
        const seg1Req = request({
          session_id: "supersede-session",
          start_user_message_id: "turn1",
          end_user_message_id: "turn1",
          source_boundary_version: 1,
          projection_version: 1,
          messages: [{ role: "user", text: "obsolete segment content" }],
        });
        const job1 = await database.enqueue({
          ...seg1Req,
          source_id: SOURCE_ID,
        });
        const claim1 = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(
          await database.finishFailedAttempt(claim1, "unsupported format", {
            retryAfterSeconds: null,
          }),
        ).toBe(true);

        const [, , targets1] = await database.sessionSegmentListing(
          SOURCE_ID,
          "supersede-session",
        );
        expect(targets1).toHaveLength(1);
        expect(required(targets1[0]).id).toBe(job1.segment_id);
        expect(required(targets1[0]).status).toBe("failed");

        const superseded1 = required(
          await database.supersedeFailedJob(SOURCE_ID, job1.id),
        );
        expect(superseded1.id).toBe(job1.id);
        expect(superseded1.status).toBe("superseded");
        expect(superseded1.error).toBe("snapshot was superseded");
        expect(superseded1.finished_at).not.toBeNull();

        const rawJob1 = required(
          (
            await database.pool.query<
              {
                id: string;
                status: string;
                payload: unknown | null;
                error: string | null;
                lease_id: string | null;
                started_at: string | null;
              } & QueryResultRow
            >(
              "SELECT id, status, payload, error, lease_id, started_at FROM extraction_jobs WHERE id = $1",
              [job1.id],
            )
          ).rows[0],
        );
        expect(rawJob1.status).toBe("superseded");
        expect(rawJob1.payload).toBeNull();
        expect(rawJob1.error).toBe("snapshot was superseded");
        expect(rawJob1.lease_id).toBeNull();
        expect(rawJob1.started_at).toBeNull();

        const targetRows1 = (
          await database.pool.query(
            "SELECT * FROM segment_targets WHERE segment_id = $1",
            [job1.segment_id],
          )
        ).rows;
        expect(targetRows1).toHaveLength(0);

        const [, , targetsAfter] = await database.sessionSegmentListing(
          SOURCE_ID,
          "supersede-session",
        );
        expect(targetsAfter).toHaveLength(0);

        // Cannot supersede already superseded job
        await expect(
          database.supersedeFailedJob(SOURCE_ID, job1.id),
        ).rejects.toThrow(JobNotRetryableError);

        // Cannot retry already superseded job
        await expect(
          database.retryFailedJob(SOURCE_ID, job1.id),
        ).rejects.toThrow(JobNotRetryableError);

        // 2. Reject pending, running, succeeded jobs
        const pendingJob = await database.enqueue({
          ...request({
            session_id: "supersede-session",
            start_user_message_id: "turn2",
            end_user_message_id: "turn2",
            source_boundary_version: 1,
            projection_version: 1,
            messages: [{ role: "user", text: "pending job content" }],
          }),
          source_id: SOURCE_ID,
        });
        await expect(
          database.supersedeFailedJob(SOURCE_ID, pendingJob.id),
        ).rejects.toThrow(/only terminal failed jobs can be retried/);

        const runningClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(runningClaim.id).toBe(pendingJob.id);
        await expect(
          database.supersedeFailedJob(SOURCE_ID, pendingJob.id),
        ).rejects.toThrow(/only terminal failed jobs can be retried/);

        const succExtraction = validatedExtractionResult({
          summary: "Succeeded summary",
          claims: [],
        });
        await database.publishExtraction(runningClaim, succExtraction);
        await database.commitResolution(
          runningClaim,
          succExtraction,
          emptyPrepared(runningClaim, succExtraction.summary),
        );
        await expect(
          database.supersedeFailedJob(SOURCE_ID, pendingJob.id),
        ).rejects.toThrow(/only terminal failed jobs can be retried/);

        // 3. Preserve committed segment when newer failed update is superseded
        const committedBefore = required(
          await database.getSegment(SOURCE_ID, pendingJob.segment_id),
        );
        expect(committedBefore.summary).toBe("Succeeded summary");

        const updateV2 = request({
          session_id: "supersede-session",
          start_user_message_id: "turn2",
          end_user_message_id: "turn2-extended",
          source_boundary_version: 1,
          projection_version: 2,
          messages: [
            { role: "user", text: "pending job content" },
            { role: "assistant", text: "v2 reply" },
          ],
        });
        const v2Job = await database.enqueue({
          ...updateV2,
          source_id: SOURCE_ID,
        });
        expect(v2Job.segment_id).toBe(pendingJob.segment_id);

        const v2Claim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(
          await database.finishFailedAttempt(v2Claim, "upstream rate limit", {
            retryAfterSeconds: null,
          }),
        ).toBe(true);

        const [, , manifestTargets] = await database.sessionSegmentListing(
          SOURCE_ID,
          "supersede-session",
        );
        expect(manifestTargets).toHaveLength(1);
        expect(required(manifestTargets[0]).id).toBe(pendingJob.segment_id);

        const supersededV2 = required(
          await database.supersedeFailedJob(SOURCE_ID, v2Job.id),
        );
        expect(supersededV2.status).toBe("superseded");

        const committedAfter = required(
          await database.getSegment(SOURCE_ID, pendingJob.segment_id),
        );
        expect(committedAfter.summary).toBe("Succeeded summary");
        expect(committedAfter.id).toBe(pendingJob.segment_id);

        const [cleanSummaries, , cleanTargets] =
          await database.sessionSegmentListing(SOURCE_ID, "supersede-session");
        expect(cleanTargets).toHaveLength(0);
        expect(cleanSummaries).toHaveLength(1);
        expect(required(cleanSummaries[0]).summary).toBe("Succeeded summary");

        // 4. Rejects supersede on stale snapshot
        const staleV1Req = request({
          session_id: "supersede-session",
          start_user_message_id: "turn3",
          end_user_message_id: "turn3-v1",
          source_boundary_version: 1,
          projection_version: 1,
          messages: [{ role: "user", text: "stale v1" }],
        });
        const staleJob = await database.enqueue({
          ...staleV1Req,
          source_id: SOURCE_ID,
        });
        const staleClaim = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        await database.finishFailedAttempt(staleClaim, "failed v1", {
          retryAfterSeconds: null,
        });

        const newerV2Req = request({
          session_id: "supersede-session",
          start_user_message_id: "turn3",
          end_user_message_id: "turn3-v2",
          source_boundary_version: 1,
          projection_version: 1,
          messages: [{ role: "user", text: "newer v2" }],
        });
        const newerJob = await database.enqueue({
          ...newerV2Req,
          source_id: SOURCE_ID,
        });
        expect(newerJob.segment_id).toBe(staleJob.segment_id);

        await expect(
          database.supersedeFailedJob(SOURCE_ID, staleJob.id),
        ).rejects.toThrow(/newer snapshot exists/);
      } finally {
        await database.close();
      }
    },
    30_000,
  );

  test.skipIf(!DATABASE_URL)(
    "excludes in-flight sessions during claiming and claims them once unblocked",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      try {
        await truncate(database);

        const sessionA1 = await database.enqueue({
          ...request({
            session_id: "session-A",
            start_user_message_id: "a1",
            end_user_message_id: "a1-end",
            projection_version: 1,
            processing_priority: 50,
            messages: [{ role: "user", text: "session A job 1" }],
          }),
          source_id: SOURCE_ID,
        });
        const sessionA2 = await database.enqueue({
          ...request({
            session_id: "session-A",
            start_user_message_id: "a2",
            end_user_message_id: "a2-end",
            projection_version: 1,
            processing_priority: 50,
            messages: [{ role: "user", text: "session A job 2" }],
          }),
          source_id: SOURCE_ID,
        });
        const sessionB1 = await database.enqueue({
          ...request({
            session_id: "session-B",
            start_user_message_id: "b1",
            end_user_message_id: "b1-end",
            projection_version: 1,
            processing_priority: 10,
            messages: [{ role: "user", text: "session B job 1" }],
          }),
          source_id: SOURCE_ID,
        });

        const claimedB = required(
          await withClient(database, (client) =>
            database.claimOldestJob(
              client,
              ["session-A"].map((sessionId) => ({
                sourceId: SOURCE_ID,
                sessionId,
              })),
            ),
          ),
        );
        expect(claimedB.id).toBe(sessionB1.id);
        expect(claimedB.request.session_id).toBe("session-B");

        const claimedNone = await withClient(database, (client) =>
          database.claimOldestJob(
            client,
            ["session-A", "session-B"].map((sessionId) => ({
              sourceId: SOURCE_ID,
              sessionId,
            })),
          ),
        );
        expect(claimedNone).toBeNull();

        const claimedA1 = required(
          await withClient(database, (client) =>
            database.claimOldestJob(
              client,
              ["session-B"].map((sessionId) => ({
                sourceId: SOURCE_ID,
                sessionId,
              })),
            ),
          ),
        );
        expect(claimedA1.id).toBe(sessionA1.id);
        expect(claimedA1.request.session_id).toBe("session-A");

        const claimedA2Blocked = await withClient(database, (client) =>
          database.claimOldestJob(
            client,
            ["session-A"].map((sessionId) => ({
              sourceId: SOURCE_ID,
              sessionId,
            })),
          ),
        );
        expect(claimedA2Blocked).toBeNull();

        await completeResolution(
          database,
          claimedA1,
          emptyPrepared(claimedA1, "Session A job 1 summary"),
        );

        const claimedA2 = required(
          await withClient(database, (client) =>
            database.claimOldestJob(
              client,
              [].map((sessionId) => ({ sourceId: SOURCE_ID, sessionId })),
            ),
          ),
        );
        expect(claimedA2.id).toBe(sessionA2.id);
        expect(claimedA2.request.session_id).toBe("session-A");
      } finally {
        await database.close();
      }
    },
    30_000,
  );

  test.skipIf(!DATABASE_URL)(
    "inherits urgency across session jobs while maintaining FIFO head selection and preserving explicit priority",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      try {
        await truncate(database);

        const backgroundJob = await database.enqueue({
          ...request({
            session_id: "session-bg",
            start_user_message_id: "bg-1",
            end_user_message_id: "bg-1-end",
            projection_version: 1,
            processing_priority: 0,
            messages: [{ role: "user", text: "background job" }],
          }),
          source_id: SOURCE_ID,
        });
        const urgentHead = await database.enqueue({
          ...request({
            session_id: "session-urgent",
            start_user_message_id: "urg-1",
            end_user_message_id: "urg-1-end",
            projection_version: 1,
            processing_priority: 0,
            messages: [{ role: "user", text: "urgent session head" }],
          }),
          source_id: SOURCE_ID,
        });
        const urgentTail = await database.enqueue({
          ...request({
            session_id: "session-urgent",
            start_user_message_id: "urg-2",
            end_user_message_id: "urg-2-end",
            projection_version: 1,
            processing_priority: 100,
            messages: [{ role: "user", text: "urgent session tail" }],
          }),
          source_id: SOURCE_ID,
        });

        const claim1 = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(claim1.id).toBe(urgentHead.id);
        expect(claim1.request.session_id).toBe("session-urgent");
        expect(claim1.request.processing_priority).toBe(0);

        const [persistedJob, persistedTarget] = await Promise.all([
          database.pool.query<{ processing_priority: number }>(
            "SELECT processing_priority FROM extraction_jobs WHERE id = $1",
            [urgentHead.id],
          ),
          database.pool.query<{ processing_priority: number }>(
            "SELECT processing_priority FROM segment_targets WHERE segment_id = $1",
            [urgentHead.segment_id],
          ),
        ]);
        expect(required(persistedJob.rows[0]).processing_priority).toBe(0);
        expect(required(persistedTarget.rows[0]).processing_priority).toBe(0);

        await completeResolution(
          database,
          claim1,
          emptyPrepared(claim1, "Urgent head summary"),
        );

        const claim2 = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(claim2.id).toBe(urgentTail.id);
        expect(claim2.request.session_id).toBe("session-urgent");
        expect(claim2.request.processing_priority).toBe(100);

        await completeResolution(
          database,
          claim2,
          emptyPrepared(claim2, "Urgent tail summary"),
        );

        const claim3 = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(claim3.id).toBe(backgroundJob.id);
        expect(claim3.request.session_id).toBe("session-bg");
        expect(claim3.request.processing_priority).toBe(0);

        await completeResolution(
          database,
          claim3,
          emptyPrepared(claim3, "Background job summary"),
        );

        const claim4 = await withClient(database, (client) =>
          database.claimOldestJob(client),
        );
        expect(claim4).toBeNull();
      } finally {
        await database.close();
      }
    },
    20_000,
  );

  test.skipIf(!DATABASE_URL)(
    "breaks ties deterministically across session heads with equal inherited urgency using FIFO ordering",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      try {
        await truncate(database);

        const sessionC1 = await database.enqueue({
          ...request({
            session_id: "session-C",
            start_user_message_id: "c1",
            end_user_message_id: "c1-end",
            projection_version: 1,
            processing_priority: 100,
            messages: [{ role: "user", text: "session C head" }],
          }),
          source_id: SOURCE_ID,
        });
        const sessionD1 = await database.enqueue({
          ...request({
            session_id: "session-D",
            start_user_message_id: "d1",
            end_user_message_id: "d1-end",
            projection_version: 1,
            processing_priority: 0,
            messages: [{ role: "user", text: "session D head" }],
          }),
          source_id: SOURCE_ID,
        });
        const sessionD2 = await database.enqueue({
          ...request({
            session_id: "session-D",
            start_user_message_id: "d2",
            end_user_message_id: "d2-end",
            projection_version: 1,
            processing_priority: 100,
            messages: [{ role: "user", text: "session D tail" }],
          }),
          source_id: SOURCE_ID,
        });
        const sessionE1 = await database.enqueue({
          ...request({
            session_id: "session-E",
            start_user_message_id: "e1",
            end_user_message_id: "e1-end",
            projection_version: 1,
            processing_priority: 100,
            messages: [{ role: "user", text: "session E head" }],
          }),
          source_id: SOURCE_ID,
        });

        const claim1 = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(claim1.id).toBe(sessionC1.id);
        expect(claim1.request.session_id).toBe("session-C");

        const claim2 = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(claim2.id).toBe(sessionD1.id);
        expect(claim2.request.session_id).toBe("session-D");

        await completeResolution(
          database,
          claim2,
          emptyPrepared(claim2, "Session D1 summary"),
        );

        const claim3 = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(claim3.id).toBe(sessionD2.id);
        expect(claim3.request.session_id).toBe("session-D");

        const claim4 = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(claim4.id).toBe(sessionE1.id);
        expect(claim4.request.session_id).toBe("session-E");

        const claim5 = await withClient(database, (client) =>
          database.claimOldestJob(client),
        );
        expect(claim5).toBeNull();
      } finally {
        await database.close();
      }
    },
    20_000,
  );

  test.skipIf(!DATABASE_URL)(
    "does not transfer urgency from excluded sessions and selects head when unblocked",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      try {
        await truncate(database);

        const urgentExcludedHead = await database.enqueue({
          ...request({
            session_id: "session-excluded",
            start_user_message_id: "ex-1",
            end_user_message_id: "ex-1-end",
            projection_version: 1,
            processing_priority: 0,
            messages: [{ role: "user", text: "excluded urgent head" }],
          }),
          source_id: SOURCE_ID,
        });
        const urgentExcludedTail = await database.enqueue({
          ...request({
            session_id: "session-excluded",
            start_user_message_id: "ex-2",
            end_user_message_id: "ex-2-end",
            projection_version: 1,
            processing_priority: 100,
            messages: [{ role: "user", text: "excluded urgent tail" }],
          }),
          source_id: SOURCE_ID,
        });
        const normalJob = await database.enqueue({
          ...request({
            session_id: "session-normal",
            start_user_message_id: "norm-1",
            end_user_message_id: "norm-1-end",
            projection_version: 1,
            processing_priority: 0,
            messages: [{ role: "user", text: "normal work" }],
          }),
          source_id: SOURCE_ID,
        });

        const claimNormal = required(
          await withClient(database, (client) =>
            database.claimOldestJob(
              client,
              ["session-excluded"].map((sessionId) => ({
                sourceId: SOURCE_ID,
                sessionId,
              })),
            ),
          ),
        );
        expect(claimNormal.id).toBe(normalJob.id);
        expect(claimNormal.request.session_id).toBe("session-normal");
        expect(claimNormal.request.processing_priority).toBe(0);

        const claimBlocked = await withClient(database, (client) =>
          database.claimOldestJob(
            client,
            ["session-excluded"].map((sessionId) => ({
              sourceId: SOURCE_ID,
              sessionId,
            })),
          ),
        );
        expect(claimBlocked).toBeNull();

        const claimExcluded = required(
          await withClient(database, (client) =>
            database.claimOldestJob(
              client,
              [].map((sessionId) => ({ sourceId: SOURCE_ID, sessionId })),
            ),
          ),
        );
        expect(claimExcluded.id).toBe(urgentExcludedHead.id);
        expect(claimExcluded.request.session_id).toBe("session-excluded");
        expect(claimExcluded.request.processing_priority).toBe(0);

        const [persistedJob, persistedTarget] = await Promise.all([
          database.pool.query<{ processing_priority: number }>(
            "SELECT processing_priority FROM extraction_jobs WHERE id = $1",
            [urgentExcludedHead.id],
          ),
          database.pool.query<{ processing_priority: number }>(
            "SELECT processing_priority FROM segment_targets WHERE segment_id = $1",
            [urgentExcludedHead.segment_id],
          ),
        ]);
        expect(required(persistedJob.rows[0]).processing_priority).toBe(0);
        expect(required(persistedTarget.rows[0]).processing_priority).toBe(0);
      } finally {
        await database.close();
      }
    },
    20_000,
  );

  test.skipIf(!DATABASE_URL)(
    "does not confer urgency from delayed future jobs until they become due",
    async () => {
      const database = new Database(settings());
      await openDatabase(database);
      try {
        await truncate(database);

        const backgroundJob = await database.enqueue({
          ...request({
            session_id: "session-bg",
            start_user_message_id: "bg-1",
            end_user_message_id: "bg-1-end",
            projection_version: 1,
            processing_priority: 0,
            messages: [{ role: "user", text: "background job" }],
          }),
          source_id: SOURCE_ID,
        });
        const delayedHead = await database.enqueue({
          ...request({
            session_id: "session-delayed",
            start_user_message_id: "del-1",
            end_user_message_id: "del-1-end",
            projection_version: 1,
            processing_priority: 0,
            messages: [{ role: "user", text: "delayed session head" }],
          }),
          source_id: SOURCE_ID,
        });
        const delayedTail = await database.enqueue({
          ...request({
            session_id: "session-delayed",
            start_user_message_id: "del-2",
            end_user_message_id: "del-2-end",
            projection_version: 1,
            processing_priority: 100,
            messages: [{ role: "user", text: "delayed session tail" }],
          }),
          source_id: SOURCE_ID,
        });

        await database.pool.query(
          "UPDATE extraction_jobs SET next_attempt_at = now() + INTERVAL '1 hour' WHERE id = $1",
          [delayedTail.id],
        );

        const claim1 = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(claim1.id).toBe(backgroundJob.id);
        expect(claim1.request.session_id).toBe("session-bg");

        await completeResolution(
          database,
          claim1,
          emptyPrepared(claim1, "Background job summary"),
        );

        const claim2 = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(claim2.id).toBe(delayedHead.id);
        expect(claim2.request.session_id).toBe("session-delayed");

        await completeResolution(
          database,
          claim2,
          emptyPrepared(claim2, "Delayed head summary"),
        );

        const claim3 = await withClient(database, (client) =>
          database.claimOldestJob(client),
        );
        expect(claim3).toBeNull();

        await database.pool.query(
          "UPDATE extraction_jobs SET next_attempt_at = now() - INTERVAL '1 second' WHERE id = $1",
          [delayedTail.id],
        );

        const claim4 = required(
          await withClient(database, (client) =>
            database.claimOldestJob(client),
          ),
        );
        expect(claim4.id).toBe(delayedTail.id);
        expect(claim4.request.session_id).toBe("session-delayed");
        expect(claim4.request.processing_priority).toBe(100);

        await completeResolution(
          database,
          claim4,
          emptyPrepared(claim4, "Delayed tail summary"),
        );

        const claim5 = await withClient(database, (client) =>
          database.claimOldestJob(client),
        );
        expect(claim5).toBeNull();
      } finally {
        await database.close();
      }
    },
    20_000,
  );
});
