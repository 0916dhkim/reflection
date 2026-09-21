import type { PoolClient } from "pg";
import {
  ingestSourceFingerprint as sourceFingerprint,
  decodePersistedIngestSegment as decodePersistedSegment,
  ingestSegmentIdForRequest as sourceSegmentIdForRequest,
} from "@reflection/shared/ingestion";
import { persistedBoundary } from "./ingestion.js";
import { ContractValidationError } from "@reflection/shared/contracts";

import { parseSourceInfo, type SourceInfo } from "@reflection/shared/sources";

export class UnknownSourceError extends Error {
  constructor(sourceId: string) {
    super(`unknown source: ${sourceId}`);
    this.name = "UnknownSourceError";
  }
}

export class NativeSourceError extends Error {
  readonly statusCode = 422;
  constructor() {
    super("native ingestion requires an opencode-v2 source-v1 registry entry");
    this.name = "NativeSourceError";
  }
}

export class OwnershipValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnershipValidationError";
  }
}

export async function registeredSource(
  connection: Pick<PoolClient, "query">,
  sourceId: string,
): Promise<SourceInfo> {
  if (
    typeof sourceId !== "string" ||
    sourceId.trim() !== sourceId ||
    !sourceId
  ) {
    throw new UnknownSourceError(String(sourceId));
  }
  const row = (
    await connection.query<{
      source_id: string;
      kind: string;
      identity_scheme: string;
    }>(
      `
      SELECT source_id, kind, identity_scheme
      FROM reflection_sources
      WHERE source_id = $1
      `,
      [sourceId],
    )
  ).rows[0];
  if (row === undefined) {
    throw new UnknownSourceError(sourceId);
  }
  return parseSourceInfo({
    id: row.source_id,
    kind: row.kind,
    identity_scheme: row.identity_scheme,
  });
}

const LEGACY_SOURCE_SQL = `(SELECT source_id FROM reflection_sources WHERE identity_scheme = 'legacy')`;

export function effectiveOwnerSql(alias: string): string {
  return `COALESCE(${alias}.source_id, ${LEGACY_SOURCE_SQL})`;
}

export async function effectiveSource(
  connection: Pick<PoolClient, "query">,
  owner: string | null,
): Promise<SourceInfo> {
  if (owner !== null) return registeredSource(connection, owner);
  const legacy = (await listRegisteredSources(connection)).find(
    (source) => source.identity_scheme === "legacy",
  );
  if (legacy === undefined)
    throw new Error("unowned rows require a registered legacy source");
  return legacy;
}

// The caller holds the segment advisory lock. Row locks also fence backfill and
// reject contradictory persisted ownership before any payload is overwritten.
export async function validateSegmentOwnership(
  connection: Pick<PoolClient, "query">,
  segmentId: string,
  expected?: SourceInfo,
): Promise<SourceInfo | null> {
  let source = expected ?? null;
  const owners = new Map<string | null, SourceInfo>();
  for (const [table, key] of [
    ["segments", "id"],
    ["extraction_jobs", "segment_id"],
    ["segment_targets", "segment_id"],
  ] as const) {
    const rows = (
      await connection.query(
        `SELECT * FROM ${table} WHERE ${key} = $1 FOR UPDATE`,
        [segmentId],
      )
    ).rows;
    for (const row of rows) {
      const assigned = row.source_id as string | null;
      const owner =
        owners.get(assigned) ?? (await effectiveSource(connection, assigned));
      owners.set(assigned, owner);
      if (source !== null && source.id !== owner.id)
        throw new OwnershipValidationError("contradictory segment ownership");
      source = owner;
      if (
        row.payload == null &&
        row.source_boundary_version === 3 &&
        (owner.kind !== "opencode-v2" || owner.identity_scheme !== "source-v1")
      ) {
        throw new OwnershipValidationError(
          "native row has incompatible source registry entry",
        );
      }
      if (row.payload != null) {
        let request: ReturnType<typeof decodePersistedSegment>;
        try {
          request = decodePersistedSegment(row.payload, owner.id);
        } catch (error) {
          if (!(error instanceof ContractValidationError)) throw error;
          throw new OwnershipValidationError(
            "invalid persisted segment payload",
          );
        }
        if (request.source_boundary_version !== row.source_boundary_version) {
          throw new OwnershipValidationError(
            "persisted payload has mismatched source boundary version",
          );
        }
        if (
          request.source_boundary_version === 3 &&
          (owner.kind !== "opencode-v2" ||
            owner.identity_scheme !== "source-v1")
        ) {
          throw new OwnershipValidationError(
            "native payload has incompatible source registry entry",
          );
        }
        if (sourceSegmentIdForRequest(request, owner) !== segmentId) {
          throw new OwnershipValidationError(
            "persisted payload has mismatched segment identity",
          );
        }
        for (const field of [
          "session_id",
          "start_user_message_id",
          "end_user_message_id",
          "start_source_message_id",
          "end_source_message_id",
          "projection_version",
        ] as const) {
          const value =
            field === "start_user_message_id" || field === "end_user_message_id"
              ? persistedBoundary(request)[field]
              : request[field];
          if (field in row && row[field] !== value)
            throw new OwnershipValidationError(
              "persisted payload has mismatched request identity",
            );
        }
        if (
          row.source_fingerprint != null &&
          row.source_fingerprint !== sourceFingerprint(request)
        ) {
          throw new OwnershipValidationError(
            "persisted payload has mismatched fingerprint",
          );
        }
      }
      if (table === "segment_targets") {
        const job = (
          await connection.query(
            "SELECT segment_id, source_id FROM extraction_jobs WHERE id = $1 FOR UPDATE",
            [row.job_id],
          )
        ).rows[0];
        if (
          job === undefined ||
          job.segment_id !== segmentId ||
          (await effectiveSource(connection, job.source_id as string | null))
            .id !== owner.id
        ) {
          throw new OwnershipValidationError(
            "target references a job with different ownership",
          );
        }
      }
    }
  }
  return source;
}

export async function listRegisteredSources(
  connection: Pick<PoolClient, "query">,
): Promise<SourceInfo[]> {
  const result = await connection.query<{
    source_id: string;
    kind: string;
    identity_scheme: string;
  }>(`
    SELECT source_id, kind, identity_scheme
    FROM reflection_sources
    ORDER BY source_id
  `);
  return result.rows.map((row) =>
    parseSourceInfo({
      id: row.source_id,
      kind: row.kind,
      identity_scheme: row.identity_scheme,
    }),
  );
}
