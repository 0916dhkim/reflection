import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  PROJECTION_SAFE_VERSION,
  parseExtractionResult,
  parseJobResponse,
  parseQueueStatusResponse,
  parseSegmentCreate,
  parseSegmentResponse,
  validateClaimObject,
  type ExtractionResult,
  type JobResponse,
  type JobStatus,
  type JobStatusCounts,
  type QueueStatusResponse,
  type SegmentBoundary,
  type SegmentCreate,
  type SegmentResponse,
  type SegmentSummary,
  type SegmentTargetBoundary,
  type SourceBoundary,
} from "@reflection/shared/contracts";
import {
  normalizeName,
  projectionFingerprintForBoundary,
  segmentIdForRequest,
  sourceFingerprint,
  unionCandidates,
  type ClaimSupport,
  type EntityCandidate,
  type PreparedSegment,
  type RecallCandidate,
} from "@reflection/shared/domain";
import {
  Client,
  Pool,
  types as pgTypes,
  type PoolClient,
  type QueryResultRow,
} from "pg";

import type { Settings } from "./config.js";
import {
  EXTRACTION_VALIDATION_VERSION,
  type ValidatedExtractionResult,
} from "./extraction-validation.js";

pgTypes.setTypeParser(1184, (value) => value);

const BLANK_SUMMARY_SQL_PATTERN =
  "U&'^[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028-\\2029\\202F\\205F\\3000\\FEFF]*$'";

function summaryHasContentSql(expression: string): string {
  return `${expression} !~ ${BLANK_SUMMARY_SQL_PATTERN}`;
}

const COMMITTED_SEGMENT_ELIGIBILITY_SQL = `
  ${summaryHasContentSql("s.summary")}
  AND s.projection_commit_fingerprint = reflection_projection_fingerprint(
      s.id,
      s.source_boundary_version,
      s.end_user_message_id,
      s.end_source_message_id,
      s.summary,
      s.projection_version
  )
  AND (
      t.segment_id IS NULL
      OR (
          t.source_generation = s.source_generation
          AND t.source_fingerprint = s.source_fingerprint
          AND t.projection_version = s.projection_version
          AND t.end_user_message_id = s.end_user_message_id
          AND t.source_boundary_version = s.source_boundary_version
          AND t.start_source_message_id IS NOT DISTINCT FROM s.start_source_message_id
          AND t.end_source_message_id IS NOT DISTINCT FROM s.end_source_message_id
          AND t.payload->>'session_id' = s.session_id
          AND t.payload->>'start_user_message_id' = s.start_user_message_id
      )
  )
`;

const STAGED_TARGET_ELIGIBILITY_SQL = `
  t.extraction_result IS NOT NULL
  AND t.extraction_validation_version = ${EXTRACTION_VALIDATION_VERSION}
  AND t.extraction_validation_fingerprint =
      reflection_extraction_validation_fingerprint(
          t.extraction_result,
          t.extraction_validation_version,
          t.source_fingerprint
      )
  AND ${summaryHasContentSql("t.extraction_result->>'summary'")}
  AND t.summary_commit_fingerprint = reflection_projection_fingerprint(
      t.segment_id,
      t.source_boundary_version,
      t.end_user_message_id,
      t.end_source_message_id,
      t.extraction_result->>'summary',
      t.projection_version
  )
`;

type PgBigInt = bigint | number | string;
type PgTimestamp = Date | string;

export interface ReservedClient {
  query: PoolClient["query"];
}

export interface ClaimedJob {
  id: number;
  segmentId: string;
  leaseId: string;
  sourceGeneration: bigint;
  sourceFingerprint: string;
  attempts: number;
  request: SegmentCreate;
  extractionResult: ValidatedExtractionResult | null;
}

export class JobNotRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobNotRetryableError";
  }
}

interface JobResponseRow extends QueryResultRow {
  id: PgBigInt;
  segment_id: string;
  start_user_message_id: string;
  end_user_message_id: string;
  source_boundary_version: number;
  start_source_message_id: string | null;
  end_source_message_id: string | null;
  source_fingerprint: string | null;
  projection_version: number;
  status: string;
  attempts: number;
  error: string | null;
  created_at: PgTimestamp;
  started_at: PgTimestamp | null;
  finished_at: PgTimestamp | null;
  next_attempt_at: PgTimestamp;
}

interface EnqueueJobRow extends QueryResultRow {
  id: PgBigInt;
  status: string;
  projection_version: number;
  source_generation: PgBigInt;
  source_fingerprint: string | null;
  source_boundary_version: number;
  start_source_message_id: string | null;
  end_source_message_id: string | null;
  end_user_message_id: string;
  processing_priority: number;
}

interface TargetRow extends QueryResultRow {
  job_id: PgBigInt;
  end_user_message_id: string;
  source_boundary_version: number;
  start_source_message_id: string | null;
  end_source_message_id: string | null;
  projection_version: number;
  payload: unknown;
  source_generation: PgBigInt;
  source_fingerprint: string | null;
  extraction_result: unknown | null;
  extraction_validation_version: number | null;
  extraction_validation_fingerprint: string | null;
  summary_commit_fingerprint: string | null;
  processing_priority: number;
  staged_eligible?: boolean;
}

interface CurrentSegmentRow extends QueryResultRow {
  start_user_message_id: string;
  end_user_message_id: string;
  source_boundary_version: number;
  start_source_message_id: string | null;
  end_source_message_id: string | null;
  projection_version: number;
  source_generation: PgBigInt;
  source_fingerprint: string | null;
  projection_safe: boolean;
  summary_nonempty: boolean;
}

interface ClaimedJobRow extends QueryResultRow {
  id: PgBigInt;
  segment_id: string;
  session_id: string;
  start_user_message_id: string;
  end_user_message_id: string;
  source_boundary_version: number;
  start_source_message_id: string | null;
  end_source_message_id: string | null;
  projection_version: number;
  payload: unknown;
  source_generation: PgBigInt;
  source_fingerprint: string | null;
  extraction_result: unknown | null;
  processing_priority: number;
}

interface RecallRow extends QueryResultRow {
  subject_text: string;
  subject_entity_id: string;
  predicate: string;
  confidence: number | string;
  object_entity_text: string | null;
  object_entity_id: string | null;
  object_value: string | null;
  equivalence_key: string;
  segment_id: string;
  similarity: number | string;
  seed_similarity?: number | string | null;
}

interface StatusCountsRow extends QueryResultRow {
  total: PgBigInt;
  pending: PgBigInt;
  running: PgBigInt;
  succeeded: PgBigInt;
  failed: PgBigInt;
  superseded: PgBigInt;
}

interface QueueAggregateRow extends StatusCountsRow {
  due: PgBigInt;
  delayed: PgBigInt;
  five_minute_succeeded: PgBigInt;
  five_minute_failed: PgBigInt;
  hour_succeeded: PgBigInt;
  hour_failed: PgBigInt;
  day_succeeded: PgBigInt;
  day_failed: PgBigInt;
}

interface DueJobRow extends QueryResultRow {
  id: PgBigInt;
  attempts: number;
  processing_priority: number;
  due_at: PgTimestamp;
  age_seconds: number | string;
}

interface RunningJobRow extends QueryResultRow {
  id: PgBigInt;
  attempts: number;
  processing_priority: number;
  started_at: PgTimestamp | null;
  age_seconds: number | string | null;
}

interface FailureCategoryRow extends QueryResultRow {
  category: string;
  count: PgBigInt;
  pending: PgBigInt;
  failed: PgBigInt;
  latest_finished_at: PgTimestamp | null;
}

function asBigInt(value: PgBigInt, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(
        `${label} is outside JavaScript's safe integer range`,
      );
    }
    return BigInt(value);
  }
  try {
    return BigInt(value);
  } catch {
    throw new TypeError(`invalid PostgreSQL bigint for ${label}: ${value}`);
  }
}

function checkedBigIntToNumber(value: PgBigInt, label: string): number {
  const parsed = asBigInt(value, label);
  if (
    parsed < BigInt(Number.MIN_SAFE_INTEGER) ||
    parsed > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new RangeError(`${label} is outside JavaScript's safe integer range`);
  }
  return Number(parsed);
}

function sameBigInt(left: PgBigInt, right: PgBigInt): boolean {
  return (
    asBigInt(left, "bigint comparison") === asBigInt(right, "bigint comparison")
  );
}

function asJobStatus(value: string): JobStatus {
  if (
    value === "pending" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "superseded"
  ) {
    return value;
  }
  throw new Error(`invalid job status: ${value}`);
}

function nonnegativeNumber(value: number | string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError(`invalid nonnegative number for ${label}: ${value}`);
  }
  return parsed;
}

function statusCounts(row: StatusCountsRow, label: string): JobStatusCounts {
  return {
    total: checkedBigIntToNumber(row.total, `${label} total`),
    pending: checkedBigIntToNumber(row.pending, `${label} pending`),
    running: checkedBigIntToNumber(row.running, `${label} running`),
    succeeded: checkedBigIntToNumber(row.succeeded, `${label} succeeded`),
    failed: checkedBigIntToNumber(row.failed, `${label} failed`),
    superseded: checkedBigIntToNumber(row.superseded, `${label} superseded`),
  };
}

function timestamp(value: PgTimestamp): string {
  if (value instanceof Date) return value.toISOString();
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(
      value,
    );
  if (match === null)
    throw new TypeError(`invalid PostgreSQL timestamp: ${value}`);
  const [, date, time, fraction = "", rawOffset] = match;
  if (date === undefined || time === undefined || rawOffset === undefined) {
    throw new TypeError(`invalid PostgreSQL timestamp: ${value}`);
  }
  const offset =
    rawOffset === "Z" || rawOffset.includes(":")
      ? rawOffset
      : rawOffset.length === 3
        ? `${rawOffset}:00`
        : `${rawOffset.slice(0, 3)}:${rawOffset.slice(3)}`;
  const instant = new Date(
    `${date}T${time}${fraction === "" ? "" : `.${fraction}`}${offset}`,
  );
  if (Number.isNaN(instant.getTime())) {
    throw new TypeError(`invalid PostgreSQL timestamp: ${value}`);
  }
  const base = instant.toISOString().slice(0, 19);
  const microseconds = fraction.padEnd(6, "0");
  return microseconds === "" || microseconds === "000000"
    ? `${base}Z`
    : `${base}.${microseconds}Z`;
}

function nullableTimestamp(value: PgTimestamp | null): string | null {
  return value === null ? null : timestamp(value);
}

function jsonb(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new TypeError("cannot serialize undefined as JSONB");
  return serialized;
}

function truncateCodePoints(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsedJson(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

function sourceBoundary(value: {
  source_boundary_version: number;
  start_source_message_id: string | null;
  end_source_message_id: string | null;
}): SourceBoundary {
  if (
    value.source_boundary_version === 1 &&
    value.start_source_message_id === null &&
    value.end_source_message_id === null
  ) {
    return {
      source_boundary_version: 1,
      start_source_message_id: null,
      end_source_message_id: null,
    };
  }
  if (
    value.source_boundary_version === 2 &&
    value.start_source_message_id !== null &&
    value.end_source_message_id !== null
  ) {
    return {
      source_boundary_version: 2,
      start_source_message_id: value.start_source_message_id,
      end_source_message_id: value.end_source_message_id,
    };
  }
  throw new Error("invalid persisted source boundary");
}

function boundaryMatchesRequest(
  value: {
    end_user_message_id: string;
    source_boundary_version: number;
    start_source_message_id: string | null;
    end_source_message_id: string | null;
  },
  request: SegmentCreate,
): boolean {
  return (
    value.end_user_message_id === request.end_user_message_id &&
    value.source_boundary_version === request.source_boundary_version &&
    value.start_source_message_id === request.start_source_message_id &&
    value.end_source_message_id === request.end_source_message_id
  );
}

function targetRequest(target: TargetRow): SegmentCreate {
  return parseSegmentCreate(parsedJson(target.payload));
}

function targetMatchesRequest(
  target: TargetRow | undefined,
  request: SegmentCreate,
  segmentId: string,
  fingerprint: string,
): boolean {
  if (
    target === undefined ||
    target.projection_version !== request.projection_version ||
    target.source_fingerprint !== fingerprint ||
    !boundaryMatchesRequest(target, request)
  ) {
    return false;
  }
  try {
    const persisted = targetRequest(target);
    return (
      persisted.session_id === request.session_id &&
      persisted.start_user_message_id === request.start_user_message_id &&
      persisted.end_user_message_id === request.end_user_message_id &&
      persisted.source_boundary_version === request.source_boundary_version &&
      persisted.start_source_message_id === request.start_source_message_id &&
      persisted.end_source_message_id === request.end_source_message_id &&
      persisted.projection_version === request.projection_version &&
      segmentIdForRequest(persisted) === segmentId &&
      sourceFingerprint(persisted) === fingerprint
    );
  } catch {
    return false;
  }
}

function targetMatchesJob(
  target: TargetRow | undefined,
  job: ClaimedJob,
): boolean {
  if (
    target === undefined ||
    !sameBigInt(target.job_id, job.id) ||
    target.projection_version !== job.request.projection_version ||
    !sameBigInt(target.source_generation, job.sourceGeneration) ||
    target.source_fingerprint !== job.sourceFingerprint ||
    !boundaryMatchesRequest(target, job.request)
  ) {
    return false;
  }
  return targetMatchesRequest(
    target,
    job.request,
    job.segmentId,
    job.sourceFingerprint,
  );
}

function persistedJobMatchesClaim(
  value: {
    session_id: string;
    start_user_message_id: string;
    end_user_message_id: string;
    source_boundary_version: number;
    start_source_message_id: string | null;
    end_source_message_id: string | null;
    projection_version: number;
    source_generation: PgBigInt;
    source_fingerprint: string | null;
  },
  job: ClaimedJob,
): boolean {
  return (
    value.session_id === job.request.session_id &&
    value.start_user_message_id === job.request.start_user_message_id &&
    boundaryMatchesRequest(value, job.request) &&
    value.projection_version === job.request.projection_version &&
    sameBigInt(value.source_generation, job.sourceGeneration) &&
    value.source_fingerprint === job.sourceFingerprint
  );
}

function projectionBoundary(value: {
  sourceBoundaryVersion: 1 | 2;
  endUserMessageId: string;
  endSourceMessageId: string | null;
}):
  | {
      sourceBoundaryVersion: 1;
      endUserMessageId: string;
      endSourceMessageId: null;
    }
  | {
      sourceBoundaryVersion: 2;
      endUserMessageId: string;
      endSourceMessageId: string;
    } {
  if (value.sourceBoundaryVersion === 1) {
    if (value.endSourceMessageId !== null) {
      throw new Error("V1 projection boundary contains a source cursor");
    }
    return {
      sourceBoundaryVersion: 1,
      endUserMessageId: value.endUserMessageId,
      endSourceMessageId: null,
    };
  }
  if (value.endSourceMessageId === null) {
    throw new Error("V2 projection boundary is missing its end source cursor");
  }
  return {
    sourceBoundaryVersion: 2,
    endUserMessageId: value.endUserMessageId,
    endSourceMessageId: value.endSourceMessageId,
  };
}

function extractionResultsEqual(
  left: ExtractionResult,
  right: ExtractionResult,
): boolean {
  return (
    left.summary === right.summary &&
    left.claims.length === right.claims.length &&
    left.claims.every((claim, index) => {
      const other = right.claims[index];
      return (
        other !== undefined &&
        claim.subject === other.subject &&
        claim.predicate === other.predicate &&
        claim.confidence === other.confidence &&
        claim.object_entity === other.object_entity &&
        claim.object_value === other.object_value
      );
    })
  );
}

function extractionResultForPersistence(
  value: ValidatedExtractionResult,
): ExtractionResult {
  const result = parseExtractionResult(value);
  if (result.summary.trim() === "") {
    throw new Error("extraction summary must contain non-whitespace text");
  }
  return result;
}

async function transaction<T>(
  client: ReservedClient,
  operation: () => Promise<T>,
  options: { readonlySnapshot?: boolean } = {},
): Promise<T> {
  await client.query(
    options.readonlySnapshot
      ? "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
      : "BEGIN",
  );
  try {
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export class Database {
  readonly pool: Pool;

  readonly #settings: Settings;
  readonly #poolMinimum: number;

  constructor(settings: Settings) {
    this.#settings = settings;
    this.#poolMinimum = settings.databasePoolMinSize;
    this.pool = new Pool({
      connectionString: settings.databaseUrl,
      min: settings.databasePoolMinSize,
      max: settings.databasePoolMaxSize,
    });
  }

  async open(): Promise<void> {
    await this.applyMigrations(this.#settings.migrationsDir);

    const clients: PoolClient[] = [];
    try {
      for (let index = 0; index < this.#poolMinimum; index += 1) {
        clients.push(await this.pool.connect());
      }
    } finally {
      for (const client of clients) client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async applyMigrations(directory: string): Promise<void> {
    const migrationNames = (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    if (migrationNames.length === 0) {
      throw new Error(`no SQL migrations found in ${directory}`);
    }

    const migrations = await Promise.all(
      migrationNames.map(async (name) => {
        const sql = await readFile(join(directory, name), "utf8");
        return {
          name,
          sql,
          checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
        };
      }),
    );
    const connection = new Client({
      connectionString: this.#settings.databaseUrl,
    });
    await connection.connect();
    try {
      await transaction(connection, async () => {
        await connection.query("SELECT pg_advisory_xact_lock($1)", [
          this.#settings.migrationLockId,
        ]);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS reflection_schema_migrations (
              name TEXT PRIMARY KEY,
              checksum CHAR(64) NOT NULL,
              applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        const recorded = new Map(
          (
            await connection.query<
              QueryResultRow & { name: string; checksum: string }
            >("SELECT name, checksum FROM reflection_schema_migrations")
          ).rows.map((row) => [row.name, row.checksum]),
        );
        for (const migration of migrations) {
          const checksum = recorded.get(migration.name);
          if (checksum !== undefined) {
            if (checksum !== migration.checksum) {
              throw new Error(
                `migration checksum mismatch for ${migration.name}`,
              );
            }
            continue;
          }
          await connection.query(migration.sql);
          await connection.query(
            `
            INSERT INTO reflection_schema_migrations (name, checksum)
            VALUES ($1, $2)
            `,
            [migration.name, migration.checksum],
          );
        }
      });
    } finally {
      await connection.end();
    }
  }

  async healthcheck(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async queueStatus(): Promise<QueueStatusResponse> {
    return this.#withTransaction(
      async (connection) => {
        const observationRow = (
          await connection.query<QueryResultRow & { observed_at: PgTimestamp }>(
            "SELECT clock_timestamp()::text AS observed_at",
          )
        ).rows[0];
        if (observationRow === undefined) {
          throw new Error("queue observation timestamp returned no row");
        }
        const observedAt = timestamp(observationRow.observed_at);
        const jobCountsRow = (
          await connection.query<QueueAggregateRow>(
            `
          SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE status = 'pending') AS pending,
                 COUNT(*) FILTER (WHERE status = 'running') AS running,
                 COUNT(*) FILTER (WHERE status = 'succeeded') AS succeeded,
                 COUNT(*) FILTER (WHERE status = 'failed') AS failed,
                 COUNT(*) FILTER (WHERE status = 'superseded') AS superseded,
                 COUNT(*) FILTER (
                      WHERE status = 'pending' AND next_attempt_at <= $1::timestamptz
                 ) AS due,
                 COUNT(*) FILTER (
                      WHERE status = 'pending' AND next_attempt_at > $1::timestamptz
                 ) AS delayed,
                 COUNT(*) FILTER (
                     WHERE status = 'succeeded'
                        AND finished_at >= $1::timestamptz - INTERVAL '5 minutes'
                 ) AS five_minute_succeeded,
                 COUNT(*) FILTER (
                     WHERE status = 'failed'
                        AND finished_at >= $1::timestamptz - INTERVAL '5 minutes'
                 ) AS five_minute_failed,
                 COUNT(*) FILTER (
                     WHERE status = 'succeeded'
                        AND finished_at >= $1::timestamptz - INTERVAL '1 hour'
                 ) AS hour_succeeded,
                 COUNT(*) FILTER (
                     WHERE status = 'failed'
                        AND finished_at >= $1::timestamptz - INTERVAL '1 hour'
                 ) AS hour_failed,
                 COUNT(*) FILTER (
                     WHERE status = 'succeeded'
                        AND finished_at >= $1::timestamptz - INTERVAL '1 day'
                 ) AS day_succeeded,
                 COUNT(*) FILTER (
                     WHERE status = 'failed'
                        AND finished_at >= $1::timestamptz - INTERVAL '1 day'
                 ) AS day_failed
          FROM extraction_jobs
          `,
            [observedAt],
          )
        ).rows[0];
        const targetCountsRow = (
          await connection.query<StatusCountsRow>(
            `
          SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE jobs.status = 'pending') AS pending,
                 COUNT(*) FILTER (WHERE jobs.status = 'running') AS running,
                 COUNT(*) FILTER (WHERE jobs.status = 'succeeded') AS succeeded,
                 COUNT(*) FILTER (WHERE jobs.status = 'failed') AS failed,
                 COUNT(*) FILTER (WHERE jobs.status = 'superseded') AS superseded
          FROM segment_targets AS targets
          JOIN extraction_jobs AS jobs ON jobs.id = targets.job_id
          `,
          )
        ).rows[0];
        const oldestDueRow = (
          await connection.query<DueJobRow>(
            `
          SELECT id, attempts, processing_priority,
                 next_attempt_at::text AS due_at,
                 EXTRACT(EPOCH FROM ($1::timestamptz - next_attempt_at))::double precision
                     AS age_seconds
          FROM extraction_jobs
          WHERE status = 'pending' AND next_attempt_at <= $1::timestamptz
          ORDER BY next_attempt_at, id
          LIMIT 1
          `,
            [observedAt],
          )
        ).rows[0];
        const runningRows = (
          await connection.query<RunningJobRow>(
            `
          SELECT id, attempts, processing_priority,
                 started_at::text AS started_at,
                 CASE WHEN started_at IS NULL THEN NULL
                       ELSE EXTRACT(EPOCH FROM ($1::timestamptz - started_at))::double precision
                 END AS age_seconds
          FROM extraction_jobs
          WHERE status = 'running'
          ORDER BY started_at NULLS FIRST, id
          LIMIT 101
          `,
            [observedAt],
          )
        ).rows;
        const failureRows = (
          await connection.query<FailureCategoryRow>(
            `
          WITH categorized AS (
              SELECT CASE
                         WHEN jobs.error IS NULL OR btrim(jobs.error) = ''
                         THEN 'UnknownError'
                         WHEN jobs.error ~ '^UpstreamRequestError: upstream request failed: [0-9]{3}( |$)'
                         THEN 'UpstreamHttp' || substring(
                             jobs.error FROM '^UpstreamRequestError: upstream request failed: ([0-9]{3})'
                         )
                         WHEN jobs.error ~ '^[A-Za-z][A-Za-z0-9]{0,63}Error(:|$)'
                         THEN substring(
                             jobs.error FROM '^([A-Za-z][A-Za-z0-9]{0,63}Error)'
                         )
                         ELSE 'UnclassifiedError'
                     END AS category,
                     jobs.status,
                     jobs.finished_at
              FROM segment_targets AS targets
              JOIN extraction_jobs AS jobs ON jobs.id = targets.job_id
              WHERE jobs.status = 'failed'
                 OR (
                     jobs.status = 'pending'
                     AND jobs.error IS NOT NULL
                     AND btrim(jobs.error) <> ''
                 )
          )
          SELECT category, COUNT(*) AS count,
                 COUNT(*) FILTER (WHERE status = 'pending') AS pending,
                 COUNT(*) FILTER (WHERE status = 'failed') AS failed,
                 MAX(finished_at)::text AS latest_finished_at
          FROM categorized
          GROUP BY category
          ORDER BY count DESC, category
          LIMIT 51
          `,
          )
        ).rows;
        if (jobCountsRow === undefined || targetCountsRow === undefined) {
          throw new Error("queue status aggregation returned no row");
        }

        const visibleRunningRows = runningRows.slice(0, 100);
        const visibleFailureRows = failureRows.slice(0, 50);
        return parseQueueStatusResponse({
          observed_at: observedAt,
          job_counts: statusCounts(jobCountsRow, "job count"),
          target_counts: statusCounts(targetCountsRow, "target count"),
          pending_due: checkedBigIntToNumber(
            jobCountsRow.due,
            "pending due count",
          ),
          pending_delayed: checkedBigIntToNumber(
            jobCountsRow.delayed,
            "pending delayed count",
          ),
          oldest_due_job:
            oldestDueRow === undefined
              ? null
              : {
                  id: checkedBigIntToNumber(
                    oldestDueRow.id,
                    "oldest due job id",
                  ),
                  attempts: oldestDueRow.attempts,
                  processing_priority: oldestDueRow.processing_priority,
                  due_at: timestamp(oldestDueRow.due_at),
                  age_seconds: nonnegativeNumber(
                    oldestDueRow.age_seconds,
                    "oldest due job age",
                  ),
                },
          running_jobs: visibleRunningRows.map((row) => ({
            id: checkedBigIntToNumber(row.id, "running job id"),
            attempts: row.attempts,
            processing_priority: row.processing_priority,
            started_at: nullableTimestamp(row.started_at),
            age_seconds:
              row.age_seconds === null
                ? null
                : nonnegativeNumber(row.age_seconds, "running job age"),
          })),
          running_jobs_truncated:
            runningRows.length > visibleRunningRows.length,
          failure_categories: visibleFailureRows.map((row) => ({
            category: row.category,
            count: checkedBigIntToNumber(row.count, "failure category count"),
            pending: checkedBigIntToNumber(
              row.pending,
              "failure category pending count",
            ),
            failed: checkedBigIntToNumber(
              row.failed,
              "failure category failed count",
            ),
            latest_finished_at: nullableTimestamp(row.latest_finished_at),
          })),
          failure_categories_truncated:
            failureRows.length > visibleFailureRows.length,
          recent_terminal_jobs: [
            {
              window_seconds: 300,
              succeeded: checkedBigIntToNumber(
                jobCountsRow.five_minute_succeeded,
                "five-minute succeeded count",
              ),
              failed: checkedBigIntToNumber(
                jobCountsRow.five_minute_failed,
                "five-minute failed count",
              ),
            },
            {
              window_seconds: 3_600,
              succeeded: checkedBigIntToNumber(
                jobCountsRow.hour_succeeded,
                "hour succeeded count",
              ),
              failed: checkedBigIntToNumber(
                jobCountsRow.hour_failed,
                "hour failed count",
              ),
            },
            {
              window_seconds: 86_400,
              succeeded: checkedBigIntToNumber(
                jobCountsRow.day_succeeded,
                "day succeeded count",
              ),
              failed: checkedBigIntToNumber(
                jobCountsRow.day_failed,
                "day failed count",
              ),
            },
          ],
        });
      },
      { readonlySnapshot: true },
    );
  }

  static async #lockSegment(
    connection: ReservedClient,
    segmentId: string,
  ): Promise<void> {
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [segmentId],
    );
  }

  async #withConnection<T>(
    operation: (connection: PoolClient) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.connect();
    try {
      return await operation(connection);
    } finally {
      connection.release();
    }
  }

  async #withTransaction<T>(
    operation: (connection: PoolClient) => Promise<T>,
    options: { readonlySnapshot?: boolean } = {},
  ): Promise<T> {
    return this.#withConnection((connection) =>
      transaction(connection, () => operation(connection), options),
    );
  }

  async enqueue(request: SegmentCreate): Promise<JobResponse> {
    const segmentId = segmentIdForRequest(request);
    const fingerprint = sourceFingerprint(request);
    const payload = jsonb(request);

    return this.#withTransaction(async (connection) => {
      await Database.#lockSegment(connection, segmentId);
      const jobs = (
        await connection.query<EnqueueJobRow>(
          `
          SELECT id, status, projection_version, source_generation,
                 source_fingerprint, end_user_message_id,
                 source_boundary_version, start_source_message_id,
                 end_source_message_id, processing_priority
          FROM extraction_jobs
          WHERE segment_id = $1
          FOR UPDATE
          `,
          [segmentId],
        )
      ).rows;
      const target = (
        await connection.query<TargetRow>(
          `
          SELECT job_id, end_user_message_id, source_boundary_version,
                 start_source_message_id, end_source_message_id,
                 projection_version, payload, source_generation,
                  source_fingerprint, extraction_result,
                   extraction_validation_version,
                   extraction_validation_fingerprint,
                   summary_commit_fingerprint, processing_priority,
                   (${STAGED_TARGET_ELIGIBILITY_SQL}) AS staged_eligible
           FROM segment_targets AS t
           WHERE t.segment_id = $1
          FOR UPDATE
          `,
          [segmentId],
        )
      ).rows[0];
      const currentSegment = (
        await connection.query<CurrentSegmentRow>(
          `
          SELECT s.start_user_message_id, s.end_user_message_id,
                 s.source_boundary_version, s.start_source_message_id,
                  s.end_source_message_id, s.projection_version,
                  s.source_generation, s.source_fingerprint,
                  ${summaryHasContentSql("s.summary")} AS summary_nonempty,
                  s.projection_commit_fingerprint = reflection_projection_fingerprint(
                     s.id,
                     s.source_boundary_version,
                     s.end_user_message_id,
                     s.end_source_message_id,
                     s.summary,
                     s.projection_version
                 ) AS projection_safe
          FROM segments s
          WHERE s.id = $1
          FOR UPDATE
          `,
          [segmentId],
        )
      ).rows[0];
      const boundaryJob = jobs.find((item) =>
        boundaryMatchesRequest(item, request),
      );

      const lowerVersion =
        (currentSegment !== undefined &&
          request.projection_version < currentSegment.projection_version) ||
        (target !== undefined &&
          request.projection_version < target.projection_version) ||
        (boundaryJob !== undefined &&
          request.projection_version < boundaryJob.projection_version);
      if (lowerVersion) {
        let jobId: PgBigInt;
        if (boundaryJob === undefined) {
          const ignored = (
            await connection.query<{ id: PgBigInt } & QueryResultRow>(
              `
               INSERT INTO extraction_jobs (
                   segment_id, session_id, start_user_message_id,
                   end_user_message_id, source_boundary_version,
                   start_source_message_id, end_source_message_id,
                   projection_version, payload, status, source_fingerprint,
                   processing_priority, finished_at, error
               )
               VALUES (
                   $1, $2, $3, $4, $5, $6, $7, $8, NULL, 'superseded', $9,
                   $10, now(), 'snapshot was superseded'
               )
               RETURNING id
              `,
              [
                segmentId,
                request.session_id,
                request.start_user_message_id,
                request.end_user_message_id,
                request.source_boundary_version,
                request.start_source_message_id,
                request.end_source_message_id,
                request.projection_version,
                fingerprint,
                request.processing_priority,
              ],
            )
          ).rows[0];
          if (ignored === undefined) {
            throw new Error("ignored job insert did not return a row");
          }
          jobId = ignored.id;
        } else {
          jobId = boundaryJob.id;
        }
        const row = await Database.#jobRow(connection, jobId);
        if (row === undefined) {
          throw new Error("ignored job disappeared during enqueue");
        }
        return Database.#jobResponse(row);
      }

      if (
        target !== undefined &&
        targetMatchesRequest(target, request, segmentId, fingerprint)
      ) {
        const targetJob = jobs.find((job) => sameBigInt(job.id, target.job_id));
        const resetStaleExtraction =
          target.extraction_result !== null &&
          target.staged_eligible !== true &&
          targetJob?.status === "failed";
        const priority = Math.max(
          target.processing_priority,
          request.processing_priority,
        );
        const exactPayload = jsonb({
          ...request,
          processing_priority: priority,
        });
        await connection.query(
          `
           UPDATE segment_targets
           SET payload = $1::jsonb,
               processing_priority = $2,
               extraction_result = CASE WHEN $3 THEN NULL ELSE extraction_result END,
               extraction_validation_version = CASE
                   WHEN $3 THEN NULL ELSE extraction_validation_version
               END,
               extraction_validation_fingerprint = CASE
                   WHEN $3 THEN NULL ELSE extraction_validation_fingerprint
               END,
               summary_commit_fingerprint = CASE
                   WHEN $3 THEN NULL ELSE summary_commit_fingerprint
               END
           WHERE segment_id = $4
           `,
          [exactPayload, priority, resetStaleExtraction, segmentId],
        );
        await connection.query(
          `
           UPDATE extraction_jobs
           SET payload = $1::jsonb,
               processing_priority = $2,
               status = CASE WHEN $3 THEN 'pending' ELSE status END,
               attempts = CASE WHEN $3 THEN 0 ELSE attempts END,
               error = CASE WHEN $3 THEN NULL ELSE error END,
               lease_id = CASE WHEN $3 THEN NULL ELSE lease_id END,
               started_at = CASE WHEN $3 THEN NULL ELSE started_at END,
               finished_at = CASE WHEN $3 THEN NULL ELSE finished_at END,
               next_attempt_at = CASE WHEN $3 THEN now() ELSE next_attempt_at END
           WHERE id = $4
           `,
          [exactPayload, priority, resetStaleExtraction, target.job_id],
        );
        const row = await Database.#jobRow(connection, target.job_id);
        if (row === undefined) {
          throw new Error("target job disappeared during enqueue");
        }
        return Database.#jobResponse(row);
      }

      if (
        currentSegment !== undefined &&
        target === undefined &&
        currentSegment.start_user_message_id ===
          request.start_user_message_id &&
        boundaryMatchesRequest(currentSegment, request) &&
        currentSegment.source_fingerprint === fingerprint &&
        currentSegment.projection_version === request.projection_version &&
        (request.projection_version < PROJECTION_SAFE_VERSION ||
          currentSegment.projection_safe) &&
        currentSegment.summary_nonempty
      ) {
        let jobId: PgBigInt;
        if (boundaryJob === undefined) {
          const settled = (
            await connection.query<{ id: PgBigInt } & QueryResultRow>(
              `
               INSERT INTO extraction_jobs (
                   segment_id, session_id, start_user_message_id,
                   end_user_message_id, source_boundary_version,
                   start_source_message_id, end_source_message_id,
                   projection_version, payload, status, source_generation,
                   source_fingerprint, processing_priority, finished_at
               )
               VALUES (
                   $1, $2, $3, $4, $5, $6, $7, $8, NULL, 'succeeded', $9,
                   $10, $11, now()
               )
               RETURNING id
              `,
              [
                segmentId,
                request.session_id,
                request.start_user_message_id,
                request.end_user_message_id,
                request.source_boundary_version,
                request.start_source_message_id,
                request.end_source_message_id,
                request.projection_version,
                currentSegment.source_generation,
                fingerprint,
                request.processing_priority,
              ],
            )
          ).rows[0];
          if (settled === undefined) {
            throw new Error("settled job insert did not return a row");
          }
          jobId = settled.id;
        } else {
          jobId = boundaryJob.id;
          await connection.query(
            `
            UPDATE extraction_jobs
            SET status = 'succeeded', lease_id = NULL, payload = NULL,
                end_user_message_id = $1, source_boundary_version = $2,
                start_source_message_id = $3, end_source_message_id = $4,
                projection_version = $5, source_generation = $6,
                source_fingerprint = $7,
                processing_priority = GREATEST(processing_priority, $8),
                error = NULL, started_at = NULL,
                finished_at = COALESCE(finished_at, now())
            WHERE id = $9 AND status <> 'running'
            `,
            [
              request.end_user_message_id,
              request.source_boundary_version,
              request.start_source_message_id,
              request.end_source_message_id,
              request.projection_version,
              currentSegment.source_generation,
              fingerprint,
              request.processing_priority,
              jobId,
            ],
          );
        }
        const row = await Database.#jobRow(connection, jobId);
        if (row === undefined) {
          throw new Error("settled job disappeared during enqueue");
        }
        return Database.#jobResponse(row);
      }

      const generation =
        [
          currentSegment?.source_generation ?? 0n,
          target?.source_generation ?? 0n,
          ...jobs.map((item) => item.source_generation),
        ].reduce<bigint>((maximum, value) => {
          const parsed = asBigInt(value, "source generation");
          return parsed > maximum ? parsed : maximum;
        }, 0n) + 1n;
      const insertedJob = (
        await connection.query<{ id: PgBigInt } & QueryResultRow>(
          `
          INSERT INTO extraction_jobs (
              segment_id, session_id, start_user_message_id, end_user_message_id,
              source_boundary_version, start_source_message_id,
              end_source_message_id, projection_version, payload,
              source_generation, source_fingerprint, processing_priority
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
          ON CONFLICT ${
            request.source_boundary_version === 1
              ? "(session_id, start_user_message_id, end_user_message_id) WHERE source_boundary_version = 1"
              : "(session_id, start_source_message_id, end_source_message_id) WHERE source_boundary_version = 2"
          }
          DO UPDATE SET
              segment_id = EXCLUDED.segment_id,
              session_id = EXCLUDED.session_id,
              start_user_message_id = EXCLUDED.start_user_message_id,
              end_user_message_id = EXCLUDED.end_user_message_id,
              source_boundary_version = EXCLUDED.source_boundary_version,
              start_source_message_id = EXCLUDED.start_source_message_id,
              end_source_message_id = EXCLUDED.end_source_message_id,
              projection_version = EXCLUDED.projection_version,
              payload = EXCLUDED.payload,
              source_generation = EXCLUDED.source_generation,
              source_fingerprint = EXCLUDED.source_fingerprint,
              processing_priority = EXCLUDED.processing_priority,
              status = 'pending', attempts = 0, lease_id = NULL, error = NULL,
              started_at = NULL, finished_at = NULL, next_attempt_at = now()
          WHERE extraction_jobs.status <> 'running'
          RETURNING id
          `,
          [
            segmentId,
            request.session_id,
            request.start_user_message_id,
            request.end_user_message_id,
            request.source_boundary_version,
            request.start_source_message_id,
            request.end_source_message_id,
            request.projection_version,
            payload,
            generation,
            fingerprint,
            request.processing_priority,
          ],
        )
      ).rows[0];
      let jobId: PgBigInt;
      if (insertedJob !== undefined) {
        jobId = insertedJob.id;
      } else if (boundaryJob !== undefined) {
        jobId = boundaryJob.id;
      } else {
        throw new Error("running boundary job disappeared during enqueue");
      }
      await connection.query(
        `
        INSERT INTO segment_targets (
            segment_id, job_id, end_user_message_id, source_boundary_version,
            start_source_message_id, end_source_message_id, projection_version,
            payload, source_generation, source_fingerprint, processing_priority
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
        ON CONFLICT (segment_id) DO UPDATE
        SET job_id = EXCLUDED.job_id,
            end_user_message_id = EXCLUDED.end_user_message_id,
            source_boundary_version = EXCLUDED.source_boundary_version,
            start_source_message_id = EXCLUDED.start_source_message_id,
            end_source_message_id = EXCLUDED.end_source_message_id,
            projection_version = EXCLUDED.projection_version,
            payload = EXCLUDED.payload,
            source_generation = EXCLUDED.source_generation,
            source_fingerprint = EXCLUDED.source_fingerprint,
            extraction_result = NULL,
            extraction_validation_version = NULL,
            extraction_validation_fingerprint = NULL,
            summary_commit_fingerprint = NULL,
            processing_priority = EXCLUDED.processing_priority,
            updated_at = now()
        `,
        [
          segmentId,
          jobId,
          request.end_user_message_id,
          request.source_boundary_version,
          request.start_source_message_id,
          request.end_source_message_id,
          request.projection_version,
          payload,
          generation,
          fingerprint,
          request.processing_priority,
        ],
      );
      const supersededIds = jobs
        .filter(
          (item) =>
            !sameBigInt(item.id, jobId) &&
            (item.status === "pending" || item.status === "failed"),
        )
        .map((item) => item.id);
      if (supersededIds.length > 0) {
        await connection.query(
          `
          UPDATE extraction_jobs
          SET status = 'superseded', payload = NULL, lease_id = NULL,
              error = 'snapshot was superseded', started_at = NULL,
              finished_at = now()
          WHERE id = ANY($1::bigint[])
          `,
          [supersededIds],
        );
      }
      const row = await Database.#jobRow(connection, jobId);
      if (row === undefined) {
        throw new Error("target job disappeared during enqueue");
      }
      return Database.#jobResponse(row);
    });
  }

  async getJob(jobId: number): Promise<JobResponse | null> {
    return this.#withConnection(async (connection) => {
      const row = await Database.#jobRow(connection, jobId);
      return row === undefined ? null : Database.#jobResponse(row);
    });
  }

  async retryFailedJob(jobId: number): Promise<JobResponse | null> {
    return this.#withTransaction(async (connection) => {
      const segment = (
        await connection.query<{ segment_id: string } & QueryResultRow>(
          "SELECT segment_id FROM extraction_jobs WHERE id = $1",
          [jobId],
        )
      ).rows[0];
      if (segment === undefined) return null;

      await Database.#lockSegment(connection, segment.segment_id);
      const job = (
        await connection.query<
          QueryResultRow & {
            id: PgBigInt;
            segment_id: string;
            session_id: string;
            start_user_message_id: string;
            status: string;
            lease_id: string | null;
            source_generation: PgBigInt;
            source_fingerprint: string | null;
            projection_version: number;
            end_user_message_id: string;
            source_boundary_version: number;
            start_source_message_id: string | null;
            end_source_message_id: string | null;
          }
        >(
          `
          SELECT id, segment_id, session_id, start_user_message_id, status,
                 lease_id, source_generation, source_fingerprint,
                 projection_version, end_user_message_id,
                 source_boundary_version, start_source_message_id,
                 end_source_message_id
          FROM extraction_jobs
          WHERE id = $1
          FOR UPDATE
          `,
          [jobId],
        )
      ).rows[0];
      if (job === undefined) return null;
      const target = (
        await connection.query<TargetRow>(
          `
          SELECT job_id, end_user_message_id, source_boundary_version,
                 start_source_message_id, end_source_message_id,
                 projection_version, payload, source_generation,
                  source_fingerprint, extraction_result,
                  extraction_validation_version,
                  extraction_validation_fingerprint,
                  summary_commit_fingerprint, processing_priority
          FROM segment_targets
          WHERE segment_id = $1
          FOR UPDATE
          `,
          [job.segment_id],
        )
      ).rows[0];
      if (job.status === "superseded") {
        throw new JobNotRetryableError(
          "job cannot be retried because a newer snapshot exists for the segment",
        );
      }
      if (job.status !== "failed" || job.lease_id !== null) {
        throw new JobNotRetryableError(
          "only terminal failed jobs can be retried",
        );
      }
      let targetSource: SegmentCreate | null = null;
      try {
        if (target !== undefined) targetSource = targetRequest(target);
      } catch {
        targetSource = null;
      }
      if (
        target === undefined ||
        targetSource === null ||
        !sameBigInt(target.job_id, job.id) ||
        !sameBigInt(target.source_generation, job.source_generation) ||
        target.source_fingerprint !== job.source_fingerprint ||
        target.projection_version !== job.projection_version ||
        !boundaryMatchesRequest(target, targetSource) ||
        !boundaryMatchesRequest(job, targetSource) ||
        targetSource.projection_version !== job.projection_version ||
        targetSource.session_id !== job.session_id ||
        targetSource.start_user_message_id !== job.start_user_message_id ||
        segmentIdForRequest(targetSource) !== job.segment_id ||
        sourceFingerprint(targetSource) !== job.source_fingerprint
      ) {
        throw new JobNotRetryableError(
          "job cannot be retried because a newer snapshot exists for the segment",
        );
      }
      const updated = await connection.query(
        `
        UPDATE extraction_jobs
        SET end_user_message_id = $1, source_boundary_version = $2,
            start_source_message_id = $3, end_source_message_id = $4,
            projection_version = $5, payload = $6::jsonb,
            source_generation = $7, source_fingerprint = $8,
            processing_priority = $9, status = 'pending', attempts = 0,
            error = NULL, lease_id = NULL, started_at = NULL,
            finished_at = NULL, next_attempt_at = now()
        WHERE id = $10 AND status = 'failed' AND lease_id IS NULL
        `,
        [
          target.end_user_message_id,
          target.source_boundary_version,
          target.start_source_message_id,
          target.end_source_message_id,
          target.projection_version,
          jsonb(target.payload),
          target.source_generation,
          target.source_fingerprint,
          target.processing_priority,
          jobId,
        ],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        throw new Error("failed job changed while retrying");
      }
      const row = await Database.#jobRow(connection, jobId);
      if (row === undefined) throw new Error("retried job disappeared");
      return Database.#jobResponse(row);
    });
  }

  async recoverRunningJobs(connection: ReservedClient): Promise<number> {
    return transaction(connection, async () => {
      const rows = (
        await connection.query<{ segment_id: string } & QueryResultRow>(`
          SELECT segment_id
          FROM extraction_jobs
          WHERE status = 'running'
          ORDER BY segment_id, id
        `)
      ).rows;
      const segmentIds = [...new Set(rows.map((row) => row.segment_id))];
      if (segmentIds.length === 0) return 0;
      for (const segmentId of segmentIds) {
        await Database.#lockSegment(connection, segmentId);
      }

      const result = await connection.query(
        `
        WITH classified AS (
            SELECT jobs.id,
                   targets.job_id = jobs.id AS is_target,
                   targets.end_user_message_id AS target_end_user_message_id,
                   targets.source_boundary_version AS target_source_boundary_version,
                   targets.start_source_message_id AS target_start_source_message_id,
                   targets.end_source_message_id AS target_end_source_message_id,
                   targets.projection_version AS target_projection_version,
                   targets.payload AS target_payload,
                   targets.source_generation AS target_generation,
                   targets.source_fingerprint AS target_fingerprint,
                   targets.processing_priority AS target_processing_priority
            FROM extraction_jobs AS jobs
            LEFT JOIN segment_targets AS targets ON targets.segment_id = jobs.segment_id
            WHERE jobs.status = 'running'
              AND jobs.segment_id = ANY($1::uuid[])
            FOR UPDATE OF jobs
        )
        UPDATE extraction_jobs AS jobs
        SET end_user_message_id = CASE
                WHEN classified.is_target
                THEN classified.target_end_user_message_id
                ELSE jobs.end_user_message_id
            END,
            source_boundary_version = CASE
                WHEN classified.is_target
                THEN classified.target_source_boundary_version
                ELSE jobs.source_boundary_version
            END,
            start_source_message_id = CASE
                WHEN classified.is_target
                THEN classified.target_start_source_message_id
                ELSE jobs.start_source_message_id
            END,
            end_source_message_id = CASE
                WHEN classified.is_target
                THEN classified.target_end_source_message_id
                ELSE jobs.end_source_message_id
            END,
            projection_version = CASE
                WHEN classified.is_target
                THEN classified.target_projection_version
                ELSE jobs.projection_version
            END,
            payload = CASE
                WHEN classified.is_target THEN classified.target_payload
                ELSE NULL
            END,
            source_generation = CASE
                WHEN classified.is_target THEN classified.target_generation
                ELSE jobs.source_generation
            END,
            source_fingerprint = CASE
                WHEN classified.is_target THEN classified.target_fingerprint
                ELSE jobs.source_fingerprint
            END,
            processing_priority = CASE
                WHEN classified.is_target THEN classified.target_processing_priority
                ELSE jobs.processing_priority
            END,
            status = CASE
                WHEN classified.is_target THEN 'pending'
                ELSE 'superseded'
            END,
            attempts = CASE
                WHEN classified.is_target
                 AND (
                     classified.target_generation <> jobs.source_generation
                     OR classified.target_fingerprint
                        IS DISTINCT FROM jobs.source_fingerprint
                      OR classified.target_projection_version <> jobs.projection_version
                      OR classified.target_end_user_message_id <> jobs.end_user_message_id
                      OR classified.target_source_boundary_version
                         <> jobs.source_boundary_version
                      OR classified.target_start_source_message_id
                         IS DISTINCT FROM jobs.start_source_message_id
                      OR classified.target_end_source_message_id
                         IS DISTINCT FROM jobs.end_source_message_id
                  )
                THEN 0
                ELSE jobs.attempts
            END,
            lease_id = NULL,
            started_at = NULL,
            finished_at = CASE WHEN classified.is_target THEN NULL ELSE now() END,
            next_attempt_at = now(),
            error = CASE
                WHEN classified.is_target
                THEN 'worker stopped before completing the job'
                ELSE 'superseded while worker was stopped'
            END
        FROM classified
        WHERE jobs.id = classified.id
        `,
        [segmentIds],
      );
      return result.rowCount ?? 0;
    });
  }

  async claimOldestJob(connection: ReservedClient): Promise<ClaimedJob | null> {
    return transaction(connection, async () => {
      const pending = (
        await connection.query<ClaimedJobRow>(`
          SELECT jobs.id, jobs.segment_id, jobs.session_id,
                  jobs.start_user_message_id, jobs.end_user_message_id,
                  jobs.source_boundary_version, jobs.start_source_message_id,
                  jobs.end_source_message_id, jobs.projection_version,
                  jobs.payload, jobs.source_generation, jobs.source_fingerprint,
                  CASE
                      WHEN targets.extraction_result IS NOT NULL
                       AND ${summaryHasContentSql(
                         "targets.extraction_result->>'summary'",
                       )}
                       AND targets.extraction_validation_version =
                           ${EXTRACTION_VALIDATION_VERSION}
                       AND targets.extraction_validation_fingerprint =
                           reflection_extraction_validation_fingerprint(
                               targets.extraction_result,
                               targets.extraction_validation_version,
                               targets.source_fingerprint
                           )
                       AND targets.summary_commit_fingerprint =
                           reflection_projection_fingerprint(
                               targets.segment_id,
                               targets.source_boundary_version,
                               targets.end_user_message_id,
                               targets.end_source_message_id,
                               targets.extraction_result->>'summary',
                               targets.projection_version
                           )
                      THEN targets.extraction_result
                      ELSE NULL
                  END AS extraction_result,
                  jobs.processing_priority
          FROM extraction_jobs AS jobs
          LEFT JOIN segment_targets AS targets
            ON targets.segment_id = jobs.segment_id
           AND targets.job_id = jobs.id
           AND targets.source_generation = jobs.source_generation
           AND targets.source_fingerprint = jobs.source_fingerprint
           AND targets.projection_version = jobs.projection_version
           AND targets.end_user_message_id = jobs.end_user_message_id
           AND targets.source_boundary_version = jobs.source_boundary_version
           AND targets.start_source_message_id
               IS NOT DISTINCT FROM jobs.start_source_message_id
           AND targets.end_source_message_id
               IS NOT DISTINCT FROM jobs.end_source_message_id
          WHERE jobs.status = 'pending'
            AND jobs.next_attempt_at <= now()
            AND (targets.segment_id IS NOT NULL OR jobs.source_fingerprint IS NULL)
            AND NOT EXISTS (
                SELECT 1
                FROM extraction_jobs AS running
                WHERE running.segment_id = jobs.segment_id
                  AND running.status = 'running'
            )
          ORDER BY COALESCE(targets.processing_priority, jobs.processing_priority) DESC,
                   targets.updated_at, jobs.id
          LIMIT 1
          FOR UPDATE OF jobs
        `)
      ).rows[0];
      if (pending === undefined) return null;

      if (pending.payload === null) {
        await connection.query(
          `
          UPDATE extraction_jobs
          SET status = 'failed', attempts = attempts + 1, lease_id = NULL,
              error = 'invalid persisted payload: payload is null', finished_at = now()
          WHERE id = $1 AND status = 'pending'
          `,
          [pending.id],
        );
        return null;
      }
      const payload = parsedJson(pending.payload);

      let request: SegmentCreate;
      try {
        request = parseSegmentCreate(payload);
      } catch (error) {
        const persistedError = truncateCodePoints(
          `invalid persisted payload: ${errorMessage(error)}`,
          4000,
        );
        await connection.query(
          `
          UPDATE extraction_jobs
          SET status = 'failed', attempts = attempts + 1, lease_id = NULL,
              error = $1, finished_at = now()
          WHERE id = $2 AND status = 'pending'
          `,
          [persistedError, pending.id],
        );
        return null;
      }
      const persistedFingerprint = pending.source_fingerprint;
      if (
        request.session_id !== pending.session_id ||
        request.start_user_message_id !== pending.start_user_message_id ||
        request.end_user_message_id !== pending.end_user_message_id ||
        request.source_boundary_version !== pending.source_boundary_version ||
        request.start_source_message_id !== pending.start_source_message_id ||
        request.end_source_message_id !== pending.end_source_message_id ||
        request.projection_version !== pending.projection_version ||
        request.processing_priority !== pending.processing_priority ||
        segmentIdForRequest(request) !== pending.segment_id ||
        persistedFingerprint === null ||
        sourceFingerprint(request) !== persistedFingerprint
      ) {
        await connection.query(
          `
          UPDATE extraction_jobs
          SET status = 'failed', attempts = attempts + 1, lease_id = NULL,
              error = 'invalid persisted payload: source identity mismatch',
              finished_at = now()
          WHERE id = $1 AND status = 'pending'
          `,
          [pending.id],
        );
        return null;
      }

      let extractionResult: ValidatedExtractionResult | null = null;
      if (pending.extraction_result !== null) {
        try {
          extractionResult = parseExtractionResult(
            parsedJson(pending.extraction_result),
          ) as ValidatedExtractionResult;
        } catch (error) {
          const persistedError = truncateCodePoints(
            `invalid persisted extraction result: ${errorMessage(error)}`,
            4000,
          );
          await connection.query(
            `
            UPDATE extraction_jobs
            SET status = 'failed', attempts = attempts + 1, lease_id = NULL,
                error = $1, finished_at = now()
            WHERE id = $2 AND status = 'pending'
            `,
            [persistedError, pending.id],
          );
          return null;
        }
      }

      const leaseId = randomUUID();
      const claimed = (
        await connection.query<{ attempts: number } & QueryResultRow>(
          `
          UPDATE extraction_jobs
          SET status = 'running', attempts = attempts + 1, lease_id = $1,
              started_at = now(), finished_at = NULL, error = NULL
          WHERE id = $2 AND status = 'pending'
          RETURNING attempts
          `,
          [leaseId, pending.id],
        )
      ).rows[0];
      if (claimed === undefined) throw new Error("claimed job disappeared");
      return {
        id: checkedBigIntToNumber(pending.id, "job id"),
        segmentId: pending.segment_id,
        leaseId,
        sourceGeneration: asBigInt(
          pending.source_generation,
          "source generation",
        ),
        sourceFingerprint: persistedFingerprint,
        attempts: claimed.attempts,
        request,
        extractionResult,
      };
    });
  }

  async finishFailedAttempt(
    job: ClaimedJob,
    error: string,
    options: { retryAfterSeconds: number | null },
  ): Promise<boolean> {
    let status: "failed" | "pending";
    let nextAttemptAt: Date;
    let finishedAt: Date | null;
    if (options.retryAfterSeconds === null) {
      status = "failed";
      nextAttemptAt = new Date();
      finishedAt = new Date();
    } else {
      status = "pending";
      nextAttemptAt = new Date(Date.now() + options.retryAfterSeconds * 1000);
      finishedAt = null;
    }

    return this.#withTransaction(async (connection) => {
      await Database.#lockSegment(connection, job.segmentId);
      const current = (
        await connection.query<
          QueryResultRow & {
            status: string;
            lease_id: string | null;
            session_id: string;
            start_user_message_id: string;
            source_generation: PgBigInt;
            source_fingerprint: string | null;
            projection_version: number;
            end_user_message_id: string;
            source_boundary_version: number;
            start_source_message_id: string | null;
            end_source_message_id: string | null;
          }
        >(
          `
          SELECT status, lease_id, session_id, start_user_message_id,
                 source_generation, source_fingerprint,
                 projection_version, end_user_message_id,
                 source_boundary_version, start_source_message_id,
                 end_source_message_id
          FROM extraction_jobs
          WHERE id = $1
          FOR UPDATE
          `,
          [job.id],
        )
      ).rows[0];
      if (
        current === undefined ||
        current.status !== "running" ||
        current.lease_id !== job.leaseId ||
        !persistedJobMatchesClaim(current, job)
      ) {
        return false;
      }
      const target = (
        await connection.query<TargetRow>(
          `
          SELECT job_id, end_user_message_id, source_boundary_version,
                 start_source_message_id, end_source_message_id,
                 projection_version, payload, source_generation,
                  source_fingerprint, extraction_result,
                  extraction_validation_version,
                  extraction_validation_fingerprint,
                  summary_commit_fingerprint, processing_priority
          FROM segment_targets
          WHERE segment_id = $1
          FOR UPDATE
          `,
          [job.segmentId],
        )
      ).rows[0];
      const targetMatches = targetMatchesJob(target, job);
      if (!targetMatches) {
        await this.#requeueLatestTarget(connection, job, target);
        return true;
      }

      const result = await connection.query(
        `
        UPDATE extraction_jobs
        SET status = $1, lease_id = NULL, error = $2, started_at = NULL,
            finished_at = $3, next_attempt_at = $4
        WHERE id = $5 AND status = 'running' AND lease_id = $6
        `,
        [
          status,
          truncateCodePoints(error, 4000),
          finishedAt,
          nextAttemptAt,
          job.id,
          job.leaseId,
        ],
      );
      if ((result.rowCount ?? 0) === 1 && options.retryAfterSeconds === null) {
        await connection.query(
          `
          DELETE FROM segment_targets t
          USING segments s
          WHERE t.segment_id = $1
            AND t.extraction_result IS NULL
            AND s.id = t.segment_id
            AND s.source_generation = t.source_generation
            AND s.source_fingerprint = t.source_fingerprint
            AND s.end_user_message_id = t.end_user_message_id
            AND s.source_boundary_version = t.source_boundary_version
            AND s.start_source_message_id IS NOT DISTINCT FROM t.start_source_message_id
            AND s.end_source_message_id IS NOT DISTINCT FROM t.end_source_message_id
            AND s.projection_version >= t.projection_version
            AND s.projection_commit_fingerprint = reflection_projection_fingerprint(
                s.id,
                s.source_boundary_version,
                s.end_user_message_id,
                s.end_source_message_id,
                s.summary,
                s.projection_version
            )
          `,
          [job.segmentId],
        );
      }
      return (result.rowCount ?? 0) === 1;
    });
  }

  async #requeueLatestTarget(
    connection: ReservedClient,
    job: ClaimedJob,
    target: TargetRow | undefined,
  ): Promise<void> {
    if (target === undefined) {
      const result = await connection.query(
        `
        UPDATE extraction_jobs
        SET status = 'superseded', lease_id = NULL, payload = NULL,
            started_at = NULL, finished_at = now(),
            error = 'snapshot was superseded'
        WHERE id = $1 AND status = 'running' AND lease_id = $2
        `,
        [job.id, job.leaseId],
      );
      if ((result.rowCount ?? 0) !== 1) {
        throw new Error("job lease changed while superseding extraction");
      }
      return;
    }

    if (sameBigInt(target.job_id, job.id)) {
      const result = await connection.query(
        `
        UPDATE extraction_jobs
        SET end_user_message_id = $1, source_boundary_version = $2,
            start_source_message_id = $3, end_source_message_id = $4,
            projection_version = $5, payload = $6::jsonb,
            source_generation = $7, source_fingerprint = $8,
            processing_priority = $9, status = 'pending', attempts = 0,
            lease_id = NULL, error = NULL, started_at = NULL,
            finished_at = NULL, next_attempt_at = now()
        WHERE id = $10 AND status = 'running' AND lease_id = $11
        `,
        [
          target.end_user_message_id,
          target.source_boundary_version,
          target.start_source_message_id,
          target.end_source_message_id,
          target.projection_version,
          jsonb(target.payload),
          target.source_generation,
          target.source_fingerprint,
          target.processing_priority,
          job.id,
          job.leaseId,
        ],
      );
      if ((result.rowCount ?? 0) !== 1) {
        throw new Error("job lease changed while requeueing latest target");
      }
      return;
    }

    const superseded = await connection.query(
      `
      UPDATE extraction_jobs
      SET status = 'superseded', lease_id = NULL, payload = NULL,
          error = 'snapshot was superseded', started_at = NULL,
          finished_at = now()
      WHERE id = $1 AND status = 'running' AND lease_id = $2
      `,
      [job.id, job.leaseId],
    );
    if ((superseded.rowCount ?? 0) !== 1) {
      throw new Error("job lease changed while superseding extraction");
    }
    await connection.query(
      `
      UPDATE extraction_jobs
      SET end_user_message_id = $1, source_boundary_version = $2,
          start_source_message_id = $3, end_source_message_id = $4,
          projection_version = $5, payload = $6::jsonb,
          source_generation = $7, source_fingerprint = $8,
          processing_priority = $9, status = 'pending', attempts = 0,
          lease_id = NULL, error = NULL, started_at = NULL,
          finished_at = NULL, next_attempt_at = now()
      WHERE id = $10 AND status <> 'running'
      `,
      [
        target.end_user_message_id,
        target.source_boundary_version,
        target.start_source_message_id,
        target.end_source_message_id,
        target.projection_version,
        jsonb(target.payload),
        target.source_generation,
        target.source_fingerprint,
        target.processing_priority,
        target.job_id,
      ],
    );
  }

  async publishExtraction(
    job: ClaimedJob,
    result: ValidatedExtractionResult,
  ): Promise<boolean> {
    const extractionResult = extractionResultForPersistence(result);
    const summaryFingerprint = projectionFingerprintForBoundary(
      job.segmentId,
      projectionBoundary({
        sourceBoundaryVersion: job.request.source_boundary_version,
        endUserMessageId: job.request.end_user_message_id,
        endSourceMessageId: job.request.end_source_message_id,
      }),
      extractionResult.summary,
      job.request.projection_version,
    );

    return this.#withTransaction(async (connection) => {
      await Database.#lockSegment(connection, job.segmentId);
      const current = (
        await connection.query<
          QueryResultRow & {
            status: string;
            lease_id: string | null;
            session_id: string;
            start_user_message_id: string;
            source_generation: PgBigInt;
            source_fingerprint: string | null;
            projection_version: number;
            end_user_message_id: string;
            source_boundary_version: number;
            start_source_message_id: string | null;
            end_source_message_id: string | null;
          }
        >(
          `
          SELECT status, lease_id, session_id, start_user_message_id,
                 source_generation, source_fingerprint,
                 projection_version, end_user_message_id,
                 source_boundary_version, start_source_message_id,
                 end_source_message_id
          FROM extraction_jobs
          WHERE id = $1
          FOR UPDATE
          `,
          [job.id],
        )
      ).rows[0];
      if (
        current === undefined ||
        current.status !== "running" ||
        current.lease_id !== job.leaseId
      ) {
        return false;
      }
      const target = (
        await connection.query<TargetRow>(
          `
          SELECT job_id, end_user_message_id, source_boundary_version,
                 start_source_message_id, end_source_message_id,
                 projection_version, payload, source_generation,
                  source_fingerprint, extraction_result,
                  extraction_validation_version,
                  extraction_validation_fingerprint,
                  summary_commit_fingerprint, processing_priority
          FROM segment_targets
          WHERE segment_id = $1
          FOR UPDATE
          `,
          [job.segmentId],
        )
      ).rows[0];
      const currentMatches = persistedJobMatchesClaim(current, job);
      if (!currentMatches || !targetMatchesJob(target, job)) {
        await this.#requeueLatestTarget(connection, job, target);
        return false;
      }

      const updated = await connection.query(
        `
         UPDATE segment_targets
         SET extraction_result = $1::jsonb,
             extraction_validation_version = ${EXTRACTION_VALIDATION_VERSION},
             extraction_validation_fingerprint =
                 reflection_extraction_validation_fingerprint(
                     $1::jsonb,
                     ${EXTRACTION_VALIDATION_VERSION},
                     source_fingerprint
                 ),
             summary_commit_fingerprint = $2
        WHERE segment_id = $3 AND job_id = $4
          AND source_generation = $5 AND source_fingerprint = $6
          AND projection_version = $7
          AND end_user_message_id = $8
          AND source_boundary_version = $9
          AND start_source_message_id IS NOT DISTINCT FROM $10
          AND end_source_message_id IS NOT DISTINCT FROM $11
        `,
        [
          jsonb(extractionResult),
          summaryFingerprint,
          job.segmentId,
          job.id,
          job.sourceGeneration,
          job.sourceFingerprint,
          job.request.projection_version,
          job.request.end_user_message_id,
          job.request.source_boundary_version,
          job.request.start_source_message_id,
          job.request.end_source_message_id,
        ],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        throw new Error("latest target changed while publishing extraction");
      }
      return true;
    });
  }

  async priorSummaries(
    sessionId: string,
    currentSegmentId: string,
  ): Promise<string[]> {
    return (await this.segmentSummaries(sessionId))
      .filter((summary) => summary.id !== currentSegmentId)
      .map((summary) => summary.summary);
  }

  async entityCandidates(
    mention: string,
    embedding: readonly number[],
  ): Promise<readonly EntityCandidate[]> {
    const queryVector = Database.#vector(embedding);
    return this.#withConnection(async (connection) => {
      const trigramRows = (
        await connection.query<
          QueryResultRow & {
            id: string;
            canonical_name: string;
            description: string;
            aliases: string[];
          }
        >(
          `
          WITH matches AS (
              SELECT id AS entity_id, similarity(canonical_name, $1) AS match_score
              FROM entities
              WHERE canonical_name % $1
              UNION ALL
              SELECT entity_id, similarity(alias, $1) AS match_score
              FROM entity_aliases
              WHERE alias % $1
          ), ranked AS (
              SELECT entity_id, MAX(match_score) AS match_score
              FROM matches
              GROUP BY entity_id
              ORDER BY match_score DESC
              LIMIT 5
          )
          SELECT e.id, e.canonical_name, e.description,
                 ARRAY(
                      SELECT a.alias FROM entity_aliases a
                      WHERE a.entity_id = e.id
                      ORDER BY (a.normalized_alias = $2) DESC,
                               similarity(a.alias, $1) DESC,
                               a.normalized_alias
                      LIMIT 10
                 ) AS aliases
          FROM ranked r
          JOIN entities e ON e.id = r.entity_id
          ORDER BY r.match_score DESC
          `,
          [mention, normalizeName(mention)],
        )
      ).rows;
      const vectorRows = (
        await connection.query<
          QueryResultRow & {
            id: string;
            canonical_name: string;
            description: string;
            aliases: string[];
          }
        >(
          `
          WITH nearest AS (
              SELECT id, canonical_name, description,
                     embedding <=> $1::vector AS distance
              FROM entities
              ORDER BY embedding <=> $1::vector
              LIMIT 5
          )
          SELECT n.id, n.canonical_name, n.description,
                 ARRAY(
                      SELECT a.alias FROM entity_aliases a
                      WHERE a.entity_id = n.id
                      ORDER BY (a.normalized_alias = $3) DESC,
                               similarity(a.alias, $2) DESC,
                               a.normalized_alias
                      LIMIT 10
                 ) AS aliases
          FROM nearest n
          ORDER BY n.distance
          `,
          [queryVector, mention, normalizeName(mention)],
        )
      ).rows;

      const convert = (
        rows: ReadonlyArray<{
          id: string;
          canonical_name: string;
          description: string;
          aliases: string[];
        }>,
      ): EntityCandidate[] =>
        rows.map((row) => ({
          id: row.id,
          canonicalName: row.canonical_name,
          description: row.description,
          aliases: row.aliases,
        }));
      return unionCandidates(convert(trigramRows), convert(vectorRows));
    });
  }

  async commitResolution(
    job: ClaimedJob,
    result: ValidatedExtractionResult,
    prepared: PreparedSegment,
  ): Promise<boolean> {
    const extractionResult = extractionResultForPersistence(result);
    if (
      prepared.id !== job.segmentId ||
      prepared.sessionId !== job.request.session_id ||
      prepared.startUserMessageId !== job.request.start_user_message_id ||
      prepared.endUserMessageId !== job.request.end_user_message_id ||
      prepared.sourceBoundaryVersion !== job.request.source_boundary_version ||
      prepared.startSourceMessageId !== job.request.start_source_message_id ||
      prepared.endSourceMessageId !== job.request.end_source_message_id ||
      prepared.summary !== extractionResult.summary ||
      prepared.projectionVersion !== job.request.projection_version
    ) {
      throw new Error("prepared resolution does not match its claimed source");
    }
    const projectionCommitFingerprint = projectionFingerprintForBoundary(
      prepared.id,
      projectionBoundary(prepared),
      extractionResult.summary,
      prepared.projectionVersion,
    );

    return this.#withTransaction(async (connection) => {
      await Database.#lockSegment(connection, job.segmentId);
      const currentJob = (
        await connection.query<
          QueryResultRow & {
            status: string;
            lease_id: string | null;
            session_id: string;
            start_user_message_id: string;
            source_generation: PgBigInt;
            source_fingerprint: string | null;
            projection_version: number;
            end_user_message_id: string;
            source_boundary_version: number;
            start_source_message_id: string | null;
            end_source_message_id: string | null;
          }
        >(
          `
          SELECT status, lease_id, session_id, start_user_message_id,
                 source_generation, source_fingerprint,
                 projection_version, end_user_message_id,
                 source_boundary_version, start_source_message_id,
                 end_source_message_id
          FROM extraction_jobs
          WHERE id = $1
          FOR UPDATE
          `,
          [job.id],
        )
      ).rows[0];
      if (
        currentJob === undefined ||
        currentJob.status !== "running" ||
        currentJob.lease_id !== job.leaseId
      ) {
        throw new Error("job lease changed before resolution committed");
      }
      const target = (
        await connection.query<TargetRow>(
          `
          SELECT job_id, end_user_message_id, source_boundary_version,
                 start_source_message_id, end_source_message_id,
                  projection_version, payload, source_generation,
                  source_fingerprint, extraction_result,
                  extraction_validation_version,
                  extraction_validation_fingerprint,
                  summary_commit_fingerprint, processing_priority,
                  COALESCE((${STAGED_TARGET_ELIGIBILITY_SQL}), FALSE)
                      AS staged_eligible
           FROM segment_targets t
          WHERE segment_id = $1
          FOR UPDATE
          `,
          [job.segmentId],
        )
      ).rows[0];
      const targetMatches =
        targetMatchesJob(target, job) &&
        persistedJobMatchesClaim(currentJob, job);
      if (!targetMatches) {
        await this.#requeueLatestTarget(connection, job, target);
        return false;
      }
      if (
        target === undefined ||
        target.extraction_result === null ||
        !target.staged_eligible ||
        target.summary_commit_fingerprint !== projectionCommitFingerprint
      ) {
        throw new Error("staged extraction is missing or does not match");
      }
      const persistedExtraction = parseExtractionResult(
        parsedJson(target.extraction_result),
      );
      if (!extractionResultsEqual(persistedExtraction, extractionResult)) {
        throw new Error("staged extraction result changed before resolution");
      }

      const existing = (
        await connection.query<{ projection_version: number } & QueryResultRow>(
          "SELECT projection_version FROM segments WHERE id = $1 FOR UPDATE",
          [prepared.id],
        )
      ).rows[0];
      if (
        existing !== undefined &&
        existing.projection_version > prepared.projectionVersion
      ) {
        const succeeded = await connection.query(
          `
          UPDATE extraction_jobs
          SET status = 'succeeded', lease_id = NULL, payload = NULL,
              error = NULL, finished_at = now()
          WHERE id = $1 AND status = 'running' AND lease_id = $2
          `,
          [job.id, job.leaseId],
        );
        if ((succeeded.rowCount ?? 0) !== 1) {
          throw new Error("job lease changed before resolution committed");
        }
        await connection.query(
          `
          DELETE FROM segment_targets
          WHERE segment_id = $1 AND job_id = $2 AND source_generation = $3
            AND source_fingerprint = $4 AND projection_version = $5
            AND end_user_message_id = $6 AND source_boundary_version = $7
            AND start_source_message_id IS NOT DISTINCT FROM $8
             AND end_source_message_id IS NOT DISTINCT FROM $9
             AND extraction_result = $10::jsonb
             AND extraction_validation_version = ${EXTRACTION_VALIDATION_VERSION}
             AND extraction_validation_fingerprint =
                 reflection_extraction_validation_fingerprint(
                     extraction_result,
                     extraction_validation_version,
                     source_fingerprint
                 )
             AND summary_commit_fingerprint = $11
          `,
          [
            job.segmentId,
            job.id,
            job.sourceGeneration,
            job.sourceFingerprint,
            job.request.projection_version,
            job.request.end_user_message_id,
            job.request.source_boundary_version,
            job.request.start_source_message_id,
            job.request.end_source_message_id,
            jsonb(extractionResult),
            projectionCommitFingerprint,
          ],
        );
        return true;
      }

      const oldEntityIds = (
        await connection.query<{ id: string } & QueryResultRow>(
          `
          SELECT subject_entity_id AS id
          FROM claims
          WHERE segment_id = $1
          UNION
          SELECT object_entity_id AS id
          FROM claims
          WHERE segment_id = $1 AND object_entity_id IS NOT NULL
          `,
          [prepared.id],
        )
      ).rows.map((row) => row.id);

      for (const entity of prepared.entities.filter((item) => item.isNew)) {
        await connection.query(
          `
          INSERT INTO entities (
              id, canonical_name, normalized_name, description, embedding
          )
          VALUES ($1, $2, $3, $4, $5::vector)
          ON CONFLICT (id) DO UPDATE
          SET canonical_name = EXCLUDED.canonical_name,
              normalized_name = EXCLUDED.normalized_name,
              description = EXCLUDED.description,
              embedding = EXCLUDED.embedding,
              updated_at = now()
          `,
          [
            entity.id,
            entity.canonicalName,
            entity.normalizedName,
            entity.description,
            entity.embedding === null
              ? null
              : Database.#vector(entity.embedding),
          ],
        );
      }
      for (const entity of prepared.entities) {
        for (const alias of entity.aliases) {
          await connection.query(
            `
            INSERT INTO entity_aliases (entity_id, alias, normalized_alias)
            VALUES ($1, $2, $3)
            ON CONFLICT (entity_id, normalized_alias) DO NOTHING
            `,
            [entity.id, alias, normalizeName(alias)],
          );
        }
      }
      await connection.query(
        `
        INSERT INTO segments (
            id, session_id, start_user_message_id, end_user_message_id,
            source_boundary_version, start_source_message_id,
            end_source_message_id, summary, projection_version,
            projection_commit_fingerprint, source_generation, source_fingerprint
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (id) DO UPDATE
        SET session_id = EXCLUDED.session_id,
            start_user_message_id = EXCLUDED.start_user_message_id,
            end_user_message_id = EXCLUDED.end_user_message_id,
            source_boundary_version = EXCLUDED.source_boundary_version,
            start_source_message_id = EXCLUDED.start_source_message_id,
            end_source_message_id = EXCLUDED.end_source_message_id,
            summary = EXCLUDED.summary,
            projection_version = EXCLUDED.projection_version,
            projection_commit_fingerprint = EXCLUDED.projection_commit_fingerprint,
            source_generation = EXCLUDED.source_generation,
            source_fingerprint = EXCLUDED.source_fingerprint,
            updated_at = now()
        `,
        [
          prepared.id,
          prepared.sessionId,
          prepared.startUserMessageId,
          prepared.endUserMessageId,
          prepared.sourceBoundaryVersion,
          prepared.startSourceMessageId,
          prepared.endSourceMessageId,
          extractionResult.summary,
          prepared.projectionVersion,
          projectionCommitFingerprint,
          job.sourceGeneration,
          job.sourceFingerprint,
        ],
      );
      await connection.query("DELETE FROM claims WHERE segment_id = $1", [
        prepared.id,
      ]);
      for (const claim of prepared.claims) {
        await connection.query(
          `
          INSERT INTO claims (
              id, segment_id, subject_text, subject_entity_id, predicate,
              confidence,
              object_entity_text, object_entity_id, object_value,
              equivalence_key, embedding
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector)
          `,
          [
            claim.id,
            prepared.id,
            claim.subject,
            claim.subjectEntityId,
            claim.predicate,
            claim.confidence,
            claim.objectEntity,
            claim.objectEntityId,
            claim.objectValue,
            claim.equivalenceKey,
            Database.#vector(claim.embedding),
          ],
        );
      }
      if (oldEntityIds.length > 0) {
        await connection.query(
          `
          DELETE FROM entities e
          WHERE e.id = ANY($1::uuid[])
            AND NOT EXISTS (
                SELECT 1
                FROM claims c
                WHERE c.subject_entity_id = e.id OR c.object_entity_id = e.id
            )
          `,
          [oldEntityIds],
        );
      }
      const succeeded = await connection.query(
        `
        UPDATE extraction_jobs
        SET status = 'succeeded', lease_id = NULL, payload = NULL,
            error = NULL, finished_at = now()
        WHERE id = $1 AND status = 'running' AND lease_id = $2
          AND source_generation = $3 AND source_fingerprint = $4
          AND projection_version = $5 AND end_user_message_id = $6
          AND source_boundary_version = $7
          AND start_source_message_id IS NOT DISTINCT FROM $8
          AND end_source_message_id IS NOT DISTINCT FROM $9
        `,
        [
          job.id,
          job.leaseId,
          job.sourceGeneration,
          job.sourceFingerprint,
          job.request.projection_version,
          job.request.end_user_message_id,
          job.request.source_boundary_version,
          job.request.start_source_message_id,
          job.request.end_source_message_id,
        ],
      );
      if ((succeeded.rowCount ?? 0) !== 1) {
        throw new Error("job lease changed before resolution committed");
      }
      const deleted = await connection.query(
        `
        DELETE FROM segment_targets
        WHERE segment_id = $1 AND job_id = $2 AND source_generation = $3
          AND source_fingerprint = $4
          AND projection_version = $5 AND end_user_message_id = $6
          AND source_boundary_version = $7
          AND start_source_message_id IS NOT DISTINCT FROM $8
           AND end_source_message_id IS NOT DISTINCT FROM $9
           AND extraction_result = $10::jsonb
           AND extraction_validation_version = ${EXTRACTION_VALIDATION_VERSION}
           AND extraction_validation_fingerprint =
               reflection_extraction_validation_fingerprint(
                   extraction_result,
                   extraction_validation_version,
                   source_fingerprint
               )
           AND summary_commit_fingerprint = $11
        `,
        [
          job.segmentId,
          job.id,
          job.sourceGeneration,
          job.sourceFingerprint,
          job.request.projection_version,
          job.request.end_user_message_id,
          job.request.source_boundary_version,
          job.request.start_source_message_id,
          job.request.end_source_message_id,
          jsonb(extractionResult),
          projectionCommitFingerprint,
        ],
      );
      if ((deleted.rowCount ?? 0) !== 1) {
        throw new Error("latest target changed before resolution committed");
      }
      return true;
    });
  }

  async getSegment(segmentId: string): Promise<SegmentResponse | null> {
    return this.#withConnection(async (connection) => {
      const segment = (
        await connection.query<
          QueryResultRow & {
            id: string;
            session_id: string;
            start_user_message_id: string;
            end_user_message_id: string;
            source_boundary_version: number;
            start_source_message_id: string | null;
            end_source_message_id: string | null;
            summary: string;
            created_at: PgTimestamp;
            updated_at: PgTimestamp;
          }
        >(
          `
          SELECT id, session_id, start_user_message_id, end_user_message_id,
                 source_boundary_version, start_source_message_id,
                 end_source_message_id, summary,
                 created_at::text AS created_at, updated_at::text AS updated_at
          FROM segments
          WHERE id = $1
          `,
          [segmentId],
        )
      ).rows[0];
      if (segment === undefined) return null;
      const claims = (
        await connection.query<
          QueryResultRow & {
            subject: string;
            subject_entity_id: string;
            predicate: string;
            confidence: number | string;
            object_entity: string | null;
            object_entity_id: string | null;
            object_value: string | null;
          }
        >(
          `
          SELECT subject_text AS subject, subject_entity_id, predicate, confidence,
                 object_entity_text AS object_entity, object_entity_id, object_value
          FROM claims
          WHERE segment_id = $1
          ORDER BY id
          `,
          [segmentId],
        )
      ).rows;
      return parseSegmentResponse({
        ...sourceBoundary(segment),
        id: segment.id,
        session_id: segment.session_id,
        start_user_message_id: segment.start_user_message_id,
        end_user_message_id: segment.end_user_message_id,
        summary: segment.summary,
        claims: claims.map((claim) =>
          validateClaimObject({
            subject: claim.subject,
            subject_entity_id: claim.subject_entity_id,
            predicate: claim.predicate,
            confidence: Number(claim.confidence),
            object_entity: claim.object_entity,
            object_entity_id: claim.object_entity_id,
            object_value: claim.object_value,
          }),
        ),
        created_at: timestamp(segment.created_at),
        updated_at: timestamp(segment.updated_at),
      });
    });
  }

  async segmentSummaries(sessionId: string): Promise<SegmentSummary[]> {
    const [summaries] = await this.sessionSegmentListing(sessionId);
    return summaries;
  }

  async sessionSegmentListing(
    sessionId: string,
  ): Promise<[SegmentSummary[], SegmentBoundary[], SegmentTargetBoundary[]]> {
    const rows = await this.#withConnection(
      async (connection) =>
        (
          await connection.query<
            QueryResultRow & {
              row_kind: "committed" | "target";
              id: string;
              start_user_message_id: string | null;
              end_user_message_id: string;
              source_boundary_version: number;
              start_source_message_id: string | null;
              end_source_message_id: string | null;
              projection_version: number;
              source_eligible: boolean;
              staged_eligible: boolean;
              source_fingerprint: string | null;
              summary: string | null;
              extraction_result: unknown | null;
              payload: unknown | null;
              status: string | null;
              ordered_at: PgTimestamp;
            }
          >(
            `
          WITH committed AS (
               SELECT 'committed' AS row_kind, s.id,
                      s.start_user_message_id, s.end_user_message_id,
                      s.source_boundary_version, s.start_source_message_id,
                      s.end_source_message_id, s.projection_version,
                      COALESCE((${COMMITTED_SEGMENT_ELIGIBILITY_SQL}), FALSE)
                          AS source_eligible,
                      FALSE AS staged_eligible,
                      s.source_fingerprint,
                      s.summary,
                      NULL::jsonb AS extraction_result,
                      NULL::jsonb AS payload,
                      NULL::text AS status,
                     s.created_at AS ordered_at
              FROM segments s
              LEFT JOIN segment_targets t ON t.segment_id = s.id
              WHERE s.session_id = $1
          ), desired AS (
              SELECT 'target' AS row_kind, t.segment_id AS id,
                      t.payload->>'start_user_message_id' AS start_user_message_id,
                      t.end_user_message_id, t.source_boundary_version,
                      t.start_source_message_id, t.end_source_message_id,
                      t.projection_version,
                      FALSE AS source_eligible,
                      COALESCE((${STAGED_TARGET_ELIGIBILITY_SQL}), FALSE)
                          AS staged_eligible,
                      t.source_fingerprint,
                      NULL::text AS summary,
                      t.extraction_result,
                      t.payload,
                      j.status::text AS status,
                     t.updated_at AS ordered_at
              FROM segment_targets t
              JOIN extraction_jobs j ON j.id = t.job_id
              WHERE t.payload->>'session_id' = $1
          )
          SELECT * FROM committed
          UNION ALL
          SELECT * FROM desired
          ORDER BY ordered_at, id, row_kind
          `,
            [sessionId],
          )
        ).rows,
    );

    const effective = new Map<
      string,
      { summary: SegmentSummary; orderedAt: number }
    >();
    const boundaries: SegmentBoundary[] = [];
    const targets: SegmentTargetBoundary[] = [];
    for (const row of rows) {
      if (row.row_kind === "committed") {
        if (row.start_user_message_id === null) {
          throw new Error("committed segment is missing start_user_message_id");
        }
        const boundary = sourceBoundary(row);
        boundaries.push({
          ...boundary,
          id: row.id,
          start_user_message_id: row.start_user_message_id,
          end_user_message_id: row.end_user_message_id,
          projection_version: row.projection_version,
          source_eligible: row.source_eligible,
          source_fingerprint: row.source_fingerprint,
        });
        if (row.source_eligible) {
          if (row.summary === null) {
            throw new Error("eligible segment is missing its summary");
          }
          effective.set(row.id, {
            summary: {
              ...boundary,
              id: row.id,
              start_user_message_id: row.start_user_message_id,
              end_user_message_id: row.end_user_message_id,
              projection_version: row.projection_version,
              summary: row.summary,
            },
            orderedAt: new Date(row.ordered_at).getTime(),
          });
        }
      } else {
        if (
          row.start_user_message_id === null ||
          row.status === null ||
          row.source_fingerprint === null
        ) {
          throw new Error("target boundary has invalid persisted data");
        }
        const request = parseSegmentCreate(parsedJson(row.payload));
        if (
          request.session_id !== sessionId ||
          request.start_user_message_id !== row.start_user_message_id ||
          request.end_user_message_id !== row.end_user_message_id ||
          request.source_boundary_version !== row.source_boundary_version ||
          request.start_source_message_id !== row.start_source_message_id ||
          request.end_source_message_id !== row.end_source_message_id ||
          request.projection_version !== row.projection_version ||
          segmentIdForRequest(request) !== row.id ||
          sourceFingerprint(request) !== row.source_fingerprint
        ) {
          throw new Error("target boundary has mismatched persisted data");
        }
        const boundary = sourceBoundary(row);
        targets.push({
          ...boundary,
          id: row.id,
          start_user_message_id: row.start_user_message_id,
          end_user_message_id: row.end_user_message_id,
          projection_version: row.projection_version,
          status: asJobStatus(row.status),
          source_fingerprint: row.source_fingerprint,
        });
        if (row.staged_eligible && row.extraction_result !== null) {
          try {
            const extraction = parseExtractionResult(
              parsedJson(row.extraction_result),
            );
            effective.set(row.id, {
              summary: {
                ...boundary,
                id: row.id,
                start_user_message_id: row.start_user_message_id,
                end_user_message_id: row.end_user_message_id,
                projection_version: row.projection_version,
                summary: extraction.summary,
              },
              orderedAt: new Date(row.ordered_at).getTime(),
            });
          } catch {
            // Corrupt staged output is never projected; the target remains visible.
          }
        }
      }
    }
    const summaries = [...effective.values()]
      .sort(
        (left, right) =>
          left.orderedAt - right.orderedAt ||
          left.summary.id.localeCompare(right.summary.id),
      )
      .map((item) => item.summary);
    return [summaries, boundaries, targets];
  }

  async directClaims(
    embedding: readonly number[],
    limit = 10,
  ): Promise<RecallCandidate[]> {
    const queryVector = Database.#vector(embedding);
    return this.#withConnection(async (connection) => {
      const rows = (
        await connection.query<RecallRow>(
          `
          SELECT c.subject_text, c.subject_entity_id, c.predicate, c.confidence,
                 c.object_entity_text, c.object_entity_id, c.object_value,
                 c.equivalence_key, c.segment_id,
                 1 - (c.embedding <=> $1::vector) AS similarity
          FROM claims c
          JOIN segments s ON s.id = c.segment_id
          LEFT JOIN segment_targets t ON t.segment_id = s.id
          WHERE ${COMMITTED_SEGMENT_ELIGIBILITY_SQL}
          ORDER BY c.embedding <=> $1::vector
          LIMIT $2
          `,
          [queryVector, limit],
        )
      ).rows;
      return rows.map((row) => Database.#recallCandidate(row, true));
    });
  }

  async neighboringClaims(
    entityId: string,
    embedding: readonly number[],
    seedSimilarity: number,
    limit = 10,
  ): Promise<RecallCandidate[]> {
    const queryVector = Database.#vector(embedding);
    return this.#withConnection(async (connection) => {
      const rows = (
        await connection.query<RecallRow>(
          `
          SELECT c.subject_text, c.subject_entity_id, c.predicate, c.confidence,
                 c.object_entity_text, c.object_entity_id, c.object_value,
                 c.equivalence_key, c.segment_id,
                 1 - (c.embedding <=> $1::vector) AS similarity
          FROM claims c
          JOIN segments s ON s.id = c.segment_id
          LEFT JOIN segment_targets t ON t.segment_id = s.id
          WHERE ${COMMITTED_SEGMENT_ELIGIBILITY_SQL}
            AND (c.subject_entity_id = $2 OR c.object_entity_id = $2)
          ORDER BY c.embedding <=> $1::vector
          LIMIT $3
          `,
          [queryVector, entityId, limit],
        )
      ).rows;
      return rows.map((row) =>
        Database.#recallCandidate(
          { ...row, seed_similarity: seedSimilarity },
          false,
        ),
      );
    });
  }

  async supportForEquivalenceKeys(
    keys: readonly string[],
  ): Promise<Map<string, ClaimSupport>> {
    if (keys.length === 0) return new Map();
    return this.#withConnection(async (connection) => {
      const rows = (
        await connection.query<
          QueryResultRow & {
            equivalence_key: string;
            segment_ids: string[];
            support_count: PgBigInt;
            session_count: PgBigInt;
          }
        >(
          `
          SELECT c.equivalence_key,
                 array_agg(DISTINCT c.segment_id ORDER BY c.segment_id) AS segment_ids,
                 count(DISTINCT c.segment_id) AS support_count,
                 count(DISTINCT s.session_id) AS session_count
          FROM claims c
          JOIN segments s ON s.id = c.segment_id
          LEFT JOIN segment_targets t ON t.segment_id = s.id
          WHERE c.equivalence_key = ANY($1::bpchar[])
            AND ${COMMITTED_SEGMENT_ELIGIBILITY_SQL}
          GROUP BY c.equivalence_key
          `,
          [keys],
        )
      ).rows;
      return new Map(
        rows.map((row) => [
          row.equivalence_key,
          {
            segmentIds: row.segment_ids,
            supportCount: checkedBigIntToNumber(
              row.support_count,
              "support count",
            ),
            sessionCount: checkedBigIntToNumber(
              row.session_count,
              "session count",
            ),
          },
        ]),
      );
    });
  }

  static async #jobRow(
    connection: ReservedClient,
    jobId: PgBigInt,
  ): Promise<JobResponseRow | undefined> {
    return (
      await connection.query<JobResponseRow>(
        `
        SELECT id, segment_id, start_user_message_id, end_user_message_id,
               source_boundary_version, start_source_message_id,
               end_source_message_id, source_fingerprint, status, attempts, error,
               created_at::text AS created_at,
               started_at::text AS started_at,
               finished_at::text AS finished_at,
               next_attempt_at::text AS next_attempt_at,
               projection_version
        FROM extraction_jobs
        WHERE id = $1
        `,
        [jobId],
      )
    ).rows[0];
  }

  static #jobResponse(row: JobResponseRow): JobResponse {
    return parseJobResponse({
      ...sourceBoundary(row),
      id: checkedBigIntToNumber(row.id, "job id"),
      segment_id: row.segment_id,
      start_user_message_id: row.start_user_message_id,
      end_user_message_id: row.end_user_message_id,
      source_fingerprint: row.source_fingerprint,
      projection_version: row.projection_version,
      status: asJobStatus(row.status),
      attempts: row.attempts,
      error: row.error,
      created_at: timestamp(row.created_at),
      started_at: nullableTimestamp(row.started_at),
      finished_at: nullableTimestamp(row.finished_at),
      next_attempt_at: timestamp(row.next_attempt_at),
    });
  }

  static #recallCandidate(row: RecallRow, isDirect: boolean): RecallCandidate {
    return {
      subject: row.subject_text,
      subjectEntityId: row.subject_entity_id,
      predicate: row.predicate,
      confidence: Number(row.confidence),
      objectEntity: row.object_entity_text,
      objectEntityId: row.object_entity_id,
      objectValue: row.object_value,
      equivalenceKey: row.equivalence_key,
      segmentId: row.segment_id,
      similarity: Number(row.similarity),
      seedSimilarity:
        row.seed_similarity === undefined || row.seed_similarity === null
          ? null
          : Number(row.seed_similarity),
      isDirect,
    };
  }

  static #vector(values: readonly number[]): string {
    return `[${values.join(",")}]`;
  }
}
