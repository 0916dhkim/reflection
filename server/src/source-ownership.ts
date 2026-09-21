import type { PoolClient } from "pg";
import { sourceFingerprint } from "@reflection/shared/domain";
import { ContractValidationError } from "@reflection/shared/contracts";

import {
  decodePersistedSegment,
  sourceSegmentIdForRequest,
  parseSourceInfo,
  type SourceInfo,
} from "@reflection/shared/sources";

export class UnknownSourceError extends Error {
  constructor(sourceId: string) {
    super(`unknown source: ${sourceId}`);
    this.name = "UnknownSourceError";
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
        if (sourceSegmentIdForRequest(request, owner) !== segmentId) {
          throw new OwnershipValidationError(
            "persisted payload has mismatched segment identity",
          );
        }
        for (const field of [
          "session_id",
          "start_user_message_id",
          "end_user_message_id",
          "source_boundary_version",
          "start_source_message_id",
          "end_source_message_id",
          "projection_version",
        ] as const) {
          if (field in row && row[field] !== request[field])
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
