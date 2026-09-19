import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

// This standalone operator script is intentionally not a scripts workspace
// dependency: only the server owns the PostgreSQL client dependency.
import pg from "../server/node_modules/pg/esm/index.mjs";

const { Client } = pg;

function usage() {
  return `Usage:
  DATABASE_URL=... node scripts/source-ownership.mjs expand
  DATABASE_URL=... node scripts/source-ownership.mjs register --id ID --kind opencode-v1|opencode-v2 --identity-scheme legacy|source-v1
  DATABASE_URL=... node scripts/source-ownership.mjs backfill --legacy-source ID [--batch-size N]
  DATABASE_URL=... node scripts/source-ownership.mjs install-indexes
  DATABASE_URL=... node scripts/source-ownership.mjs cutover --old-writers-stopped
  DATABASE_URL=... node scripts/source-ownership.mjs enforce --old-writers-stopped

All actions require DATABASE_URL. register is the only registry write path.
backfill is resumable and only assigns NULL ownership to the registered legacy
source. enforce is destructive to old global uniqueness and must run only after
old writers are quiescent.
expand applies only checksummed transactional migrations (MIGRATIONS_DIR defaults
to this repository's migrations directory). It starts no server or worker and
does not register sources or install source-aware boundary indexes.
Order: expand; register explicit sources; install-indexes; stop old
writers; cutover; start source-aware backend; backfill; enforce. cutover drops
only boundary uniqueness, never global UUID primary keys or claims foreign keys.
All commands take the app migration advisory lock (MIGRATION_LOCK_ID, default
7320260818002), with a 5s lock wait and 5s connection timeout. Statements have a
30 minute timeout, including concurrent index builds. On timeout, retry the
command: install-indexes validates definitions and rebuilds invalid indexes.
Backfill uses the repository's canonical TypeScript validation via Node 24.`;
}

function argument(name, required = true) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (required && (value === undefined || value.startsWith("--"))) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function sourceId(value) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 500
  ) {
    throw new Error("source ID must be a nonblank string up to 500 characters");
  }
  return value.trim();
}

async function legacySource(client, id) {
  const result = await client.query(
    "SELECT source_id FROM reflection_sources WHERE source_id = $1 AND identity_scheme = 'legacy'",
    [id],
  );
  if (result.rowCount !== 1) {
    throw new Error("--legacy-source must name a registered legacy source");
  }
}

async function register(client) {
  const id = sourceId(argument("--id"));
  const kind = argument("--kind");
  const identityScheme = argument("--identity-scheme");
  if (!["opencode-v1", "opencode-v2"].includes(kind)) {
    throw new Error("--kind must be opencode-v1 or opencode-v2");
  }
  if (!["legacy", "source-v1"].includes(identityScheme)) {
    throw new Error("--identity-scheme must be legacy or source-v1");
  }
  await client.query(
    "INSERT INTO reflection_sources (source_id, kind, identity_scheme) VALUES ($1, $2, $3)",
    [id, kind, identityScheme],
  );
  console.log(`registered ${id}`);
}

async function backfill(client) {
  const owner = sourceId(argument("--legacy-source"));
  const batchText = argument("--batch-size", false) ?? "100";
  const batchSize = Number(batchText);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error("--batch-size must be an integer between 1 and 1000");
  }
  await legacySource(client, owner);
  // Shared sources are TypeScript with emitted-.js relative imports. Scope the
  // Node 24 resolver to that package; never rewrite or duplicate its algorithms.
  const sharedRoot = new URL("../packages/shared/src/", import.meta.url).href;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        context.parentURL?.startsWith(sharedRoot) &&
        specifier.startsWith("./") &&
        specifier.endsWith(".js")
      ) {
        return nextResolve(specifier.slice(0, -3) + ".ts", context);
      }
      return nextResolve(specifier, context);
    },
  });
  let validateSegmentOwnership, registeredSource, sourceSegmentIdForRequest;
  try {
    ({ validateSegmentOwnership, registeredSource } = await import(
      "../server/src/source-ownership.ts"
    ));
    ({ sourceSegmentIdForRequest } = await import(
      "../packages/shared/src/sources.ts"
    ));
  } finally {
    hooks.deregister();
  }
  const source = await registeredSource(client, owner);
  let changed = 0;
  while (true) {
    const candidates = await client.query(
      `
      SELECT segment_id FROM (
        SELECT id AS segment_id FROM segments WHERE source_id IS NULL
        UNION
        SELECT segment_id FROM extraction_jobs WHERE source_id IS NULL
        UNION
        SELECT segment_id FROM segment_targets WHERE source_id IS NULL
      ) pending
      ORDER BY segment_id
      LIMIT $1
      `,
      [batchSize],
    );
    if (candidates.rowCount === 0) {
      break;
    }
    for (const { segment_id: segmentId } of candidates.rows) {
      await client.query("BEGIN");
      try {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [segmentId],
        );
        await validateSegmentOwnership(client, segmentId, source);
        const identities = await client.query(
          `
          SELECT id AS segment_id, session_id, start_user_message_id,
                 source_boundary_version, start_source_message_id FROM segments WHERE id = $1
          UNION ALL
          SELECT segment_id, session_id, start_user_message_id,
                 source_boundary_version, start_source_message_id FROM extraction_jobs WHERE segment_id = $1`,
          [segmentId],
        );
        for (const row of identities.rows) {
          if (
            sourceSegmentIdForRequest({ ...row, source_id: owner }, source) !==
            segmentId
          ) {
            throw new Error("backfill rejected noncanonical segment identity");
          }
        }
        await client.query(
          "UPDATE segments SET source_id = $1 WHERE id = $2 AND source_id IS NULL",
          [owner, segmentId],
        );
        await client.query(
          "UPDATE extraction_jobs SET source_id = $1 WHERE segment_id = $2 AND source_id IS NULL",
          [owner, segmentId],
        );
        await client.query(
          "UPDATE segment_targets SET source_id = $1 WHERE segment_id = $2 AND source_id IS NULL",
          [owner, segmentId],
        );
        await client.query("COMMIT");
        changed += 1;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  }
  console.log(`backfilled ${changed} segment ownership groups`);
}

export const sourceIndexes = [
  [
    "segments_source_v1_start_key",
    "segments",
    "source_id, session_id, start_user_message_id",
    "source_boundary_version = 1",
  ],
  [
    "segments_source_v2_start_key",
    "segments",
    "source_id, session_id, start_source_message_id",
    "source_boundary_version = 2",
  ],
  [
    "extraction_jobs_source_v1_boundary_key",
    "extraction_jobs",
    "source_id, session_id, start_user_message_id, end_user_message_id",
    "source_boundary_version = 1",
  ],
  [
    "extraction_jobs_source_v2_boundary_key",
    "extraction_jobs",
    "source_id, session_id, start_source_message_id, end_source_message_id",
    "source_boundary_version = 2",
  ],
  [
    "extraction_jobs_source_job_segment_key",
    "extraction_jobs",
    "source_id, id, segment_id",
    null,
  ],
];

export async function checkIndexes(
  client,
  indexes = sourceIndexes,
  allowInvalid = false,
) {
  for (const [name, table, columns, predicate] of indexes) {
    const row = (
      await client.query(
        `SELECT i.indisvalid, i.indisunique,
      i.indrelid = $2::regclass AS correct_table,
      pg_get_expr(i.indpred, i.indrelid) AS predicate,
      ARRAY(SELECT pg_get_indexdef(i.indexrelid, n, true)
        FROM generate_series(1, i.indnatts) n) AS columns
      FROM pg_index i WHERE i.indexrelid = to_regclass($1)`,
        [name, table],
      )
    ).rows[0];
    if (
      !row ||
      (!allowInvalid && !row.indisvalid) ||
      !row.indisunique ||
      !row.correct_table ||
      row.predicate !== (predicate === null ? null : `(${predicate})`) ||
      row.columns.join(", ") !== columns
    ) {
      throw new Error(
        `source index missing, invalid, or has unexpected definition: ${name}`,
      );
    }
  }
}

export async function installIndexes(client) {
  for (const [name, table, columns, predicate] of sourceIndexes) {
    const row = (
      await client.query(
        "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)",
        [name],
      )
    ).rows[0];
    if (row)
      await checkIndexes(client, [[name, table, columns, predicate]], true);
    if (row && !row.indisvalid)
      await client.query(`DROP INDEX CONCURRENTLY ${name}`);
    if (!row?.indisvalid)
      await client.query(
        `CREATE UNIQUE INDEX CONCURRENTLY ${name} ON ${table} (${columns})${predicate === null ? "" : ` WHERE ${predicate}`}`,
      );
  }
  await checkIndexes(client);
}

function requireStoppedWriters() {
  if (!process.argv.includes("--old-writers-stopped"))
    throw new Error("requires --old-writers-stopped");
}

async function cutover(client) {
  requireStoppedWriters();
  await checkIndexes(client);
  for (const name of [
    "segments_v1_start_key",
    "segments_v2_start_key",
    "extraction_jobs_v1_boundary_key",
    "extraction_jobs_v2_boundary_key",
  ]) {
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
  }
}

async function enforce(client) {
  requireStoppedWriters();
  await checkIndexes(client);
  const nulls = await client.query(`
    SELECT
      (SELECT count(*) FROM segments WHERE source_id IS NULL) AS segments,
      (SELECT count(*) FROM extraction_jobs WHERE source_id IS NULL) AS jobs,
      (SELECT count(*) FROM segment_targets WHERE source_id IS NULL) AS targets
  `);
  const counts = nulls.rows[0];
  if (Object.values(counts).some((value) => Number(value) !== 0)) {
    throw new Error(
      `cannot enforce while unowned rows remain: ${JSON.stringify(counts)}`,
    );
  }
  const contradictory = await client.query(`
    SELECT 1 FROM segment_targets t LEFT JOIN extraction_jobs j ON j.id = t.job_id
      LEFT JOIN segments s ON s.id = t.segment_id
      WHERE j.id IS NULL OR j.segment_id <> t.segment_id OR j.source_id <> t.source_id
        OR s.source_id <> t.source_id
        OR t.payload ? 'source_id' AND (t.payload->>'source_id') IS DISTINCT FROM t.source_id
    UNION ALL SELECT 1 FROM extraction_jobs j LEFT JOIN segments s ON s.id = j.segment_id
      WHERE s.source_id <> j.source_id
        OR j.payload ? 'source_id' AND (j.payload->>'source_id') IS DISTINCT FROM j.source_id
    UNION ALL SELECT 1 FROM extraction_jobs GROUP BY segment_id HAVING count(DISTINCT source_id) > 1
    LIMIT 1`);
  if (contradictory.rowCount)
    throw new Error("cannot enforce contradictory ownership");
  await client.query(
    "ALTER TABLE segments VALIDATE CONSTRAINT segments_source_id_fkey",
  );
  await client.query(
    "ALTER TABLE extraction_jobs VALIDATE CONSTRAINT extraction_jobs_source_id_fkey",
  );
  await client.query(
    "ALTER TABLE segment_targets VALIDATE CONSTRAINT segment_targets_source_id_fkey",
  );
  if (
    !(
      await client.query(
        "SELECT 1 FROM pg_constraint WHERE conrelid = 'segment_targets'::regclass AND conname = 'segment_targets_owned_job_fkey'",
      )
    ).rowCount
  ) {
    await client.query(`ALTER TABLE segment_targets ADD CONSTRAINT segment_targets_owned_job_fkey
      FOREIGN KEY (source_id, job_id, segment_id) REFERENCES extraction_jobs (source_id, id, segment_id) NOT VALID`);
  }
  await client.query(
    "ALTER TABLE segment_targets VALIDATE CONSTRAINT segment_targets_owned_job_fkey",
  );
  await cutover(client);
  for (const table of ["segments", "extraction_jobs", "segment_targets"]) {
    const constraint = `${table}_source_owned`;
    if (
      !(
        await client.query(
          "SELECT 1 FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2",
          [table, constraint],
        )
      ).rowCount
    ) {
      await client.query(
        `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (source_id IS NOT NULL) NOT VALID`,
      );
    }
    await client.query(
      `ALTER TABLE ${table} VALIDATE CONSTRAINT ${constraint}`,
    );
    await client.query(
      `ALTER TABLE ${table} ALTER COLUMN source_id SET NOT NULL`,
    );
  }
  console.log(
    "source ownership enforced; global UUID primary keys and claims foreign keys retained",
  );
}

async function main() {
  const action = process.argv[2];
  if (action === undefined || action === "--help" || action === "-h") {
    console.log(usage());
    return;
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  const lockId = (process.env.MIGRATION_LOCK_ID ?? "7320260818002").trim();
  if (
    !/^-?\d+$/.test(lockId) ||
    BigInt(lockId) < -(2n ** 63n) ||
    BigInt(lockId) >= 2n ** 63n
  ) {
    throw new Error("MIGRATION_LOCK_ID must be a PostgreSQL bigint");
  }
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    query_timeout: 1_805_000,
    options:
      "-c lock_timeout=5000 -c statement_timeout=1800000 -c idle_in_transaction_session_timeout=30000",
  });
  try {
    await client.connect();
    await client.query(
      "SET lock_timeout = '5s'; SET statement_timeout = '30min'; SET idle_in_transaction_session_timeout = '30s'",
    );
    // Session scope is required because CONCURRENTLY cannot run in a transaction.
    // Closing the connection releases this lock even after a failed operation.
    await client.query("SELECT pg_advisory_lock($1::bigint)", [lockId]);
    if (action === "expand") {
      // This module has no runtime relative-.js imports, so no resolver hook is needed.
      const { applyMigrations } = await import("../server/src/migrations.ts");
      await applyMigrations(
        client,
        process.env.MIGRATIONS_DIR ??
          fileURLToPath(new URL("../migrations", import.meta.url)),
        lockId,
      );
      console.log(
        "transactional schema expansion complete; source preparation remains explicit",
      );
    } else if (action === "register") await register(client);
    else if (action === "backfill") await backfill(client);
    else if (action === "enforce") await enforce(client);
    else if (action === "install-indexes") await installIndexes(client);
    else if (action === "cutover") await cutover(client);
    else throw new Error(`unknown action: ${action}`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    const code =
      typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)
        ? error.code
        : null;
    console.error(
      code === null
        ? "source ownership operation failed; verify arguments, connection settings, and canonical ownership data"
        : `source ownership operation failed (PostgreSQL ${code}); for lock/query timeouts, retry after the competing operation completes`,
    );
    process.exitCode = 1;
  });
