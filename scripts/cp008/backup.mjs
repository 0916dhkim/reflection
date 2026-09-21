import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  statfs,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import pg from "pg";

const { Client } = pg;
const ARTIFACT_ID = "reflection-local-backup-v1";
const RUN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CORE_TABLES = new Set([
  "reflection_schema_migrations",
  "extraction_jobs",
  "segments",
  "entities",
  "entity_aliases",
  "claims",
  "segment_targets",
  "reflection_sources",
]);
const REQUIRED_MIGRATIONS = [
  "001_init.sql",
  "002_audit_hardening.sql",
  "003_claim_confidence_and_payload_cleanup.sql",
  "004_projection_safety.sql",
  "005_mutable_source_snapshots.sql",
  "006_canonical_source_spans.sql",
  "007_superseded_job_status.sql",
  "008_extraction_validation.sql",
];
const KNOWN_MIGRATIONS = new Set([
  ...REQUIRED_MIGRATIONS,
  "009_source_ownership_expansion.sql",
  "010_native_source_spans.sql",
]);
let deadlineAt = 0;
let deadlineTimer;
let stage = "START";
let stopping = false;
let artifactSha256;
const clients = new Set();
const children = new Set();
const ASSERTIONS = ["archive", "empty-target", "schema", "tables", "sequences"];
const HEX = /^[a-f0-9]{64}$/;
process.umask(0o077);

function event(code, fields = {}) {
  process.stdout.write(
    `${JSON.stringify({ code, artifactSha256, ...fields })}\n`,
  );
}

function fail(message) {
  throw new Error(message);
}

function remaining() {
  if (stopping) fail("operation stopped");
  const ms = deadlineAt - Date.now();
  if (ms <= 0) {
    fail("operation deadline elapsed");
  }
  return ms;
}

function timeout() {
  const value = Number(process.env.JOB_TIMEOUT_SECONDS ?? "1800");
  if (!Number.isInteger(value) || value < 5 || value > 3600) {
    fail("JOB_TIMEOUT_SECONDS must be an integer from 5 through 3600");
  }
  deadlineAt = Date.now() + value * 1000;
  deadlineTimer = setTimeout(
    () => safeFailure(undefined, "DEADLINE"),
    value * 1000,
  );
}

function runId() {
  const value = process.env.BACKUP_RUN_ID;
  if (typeof value !== "string" || !RUN.test(value)) {
    fail("BACKUP_RUN_ID is invalid");
  }
  return value;
}

function connection(name, host, database, user, restoreTarget = false) {
  const value = process.env[name];
  if (!value) {
    fail(`${name} is required`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${name} is invalid`);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== host ||
    decodeURIComponent(url.username) !== user ||
    decodeURIComponent(url.pathname.slice(1)) !== database ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    fail(`${name} does not match the designated database`);
  }
  if (restoreTarget && !database.includes("_restore_test")) {
    fail("target database is not a designated restore test database");
  }
  return { url: value, parsed: url };
}

function sourceConnection() {
  return connection(
    "SOURCE_DATABASE_URL",
    process.env.EXPECTED_SOURCE_HOST ?? "db",
    process.env.EXPECTED_SOURCE_DATABASE ?? "reflection",
    process.env.EXPECTED_SOURCE_USER ?? "reflection",
  );
}

function targetConnection() {
  if (process.env.SOURCE_DATABASE_URL) {
    fail("verify must not receive SOURCE_DATABASE_URL");
  }
  return connection(
    "TARGET_DATABASE_URL",
    process.env.EXPECTED_TARGET_HOST ?? "restore-db",
    process.env.EXPECTED_TARGET_DATABASE ?? "reflection_restore_test",
    process.env.EXPECTED_TARGET_USER ?? "reflection_restore_test",
    true,
  );
}

function q(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function stable(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(records) {
  const hash = createHash("sha256");
  for (const record of records) {
    const data = Buffer.from(stable(record), "utf8");
    hash.update(`${data.length}:`);
    hash.update(data);
  }
  return hash.digest("hex");
}

async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const part of createReadStream(path)) {
    hash.update(part);
  }
  return hash.digest("hex");
}

async function syncFile(path) {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function syncDirectory(path) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writePrivate(path, value) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(value, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

function clientConfig(url) {
  return {
    connectionString: url,
    connectionTimeoutMillis: Math.min(5000, remaining()),
    query_timeout: Math.min(remaining(), 3_600_000),
    options: `-c lock_timeout=5000 -c statement_timeout=${Math.min(remaining(), 3_600_000)} -c default_transaction_read_only=on -c TimeZone=UTC -c extra_float_digits=3`,
  };
}

async function connect(url) {
  const client = new Client(clientConfig(url));
  clients.add(client);
  try {
    await client.connect();
    await client.query("SELECT set_config('statement_timeout', $1, false)", [
      String(Math.min(remaining(), 3_600_000)),
    ]);
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET TIME ZONE 'UTC'");
    await client.query("SET extra_float_digits = 3");
    return client;
  } catch (error) {
    await client.end().catch(() => {});
    clients.delete(client);
    throw error;
  }
}

async function query(client, text, values) {
  remaining();
  return client.query({
    text,
    values,
    query_timeout: Math.min(remaining(), 3_600_000),
  });
}

async function child(command, args, env) {
  remaining();
  stage = command === "pg_dump" ? "DUMP" : "RESTORE";
  return new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, {
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    children.add(childProcess);
    childProcess.once("error", () => {
      children.delete(childProcess);
      reject(new Error("database client process could not start"));
    });
    childProcess.once("exit", (code) => {
      children.delete(childProcess);
      if (code !== 0) {
        reject(new Error("database client process failed"));
      } else {
        resolve();
      }
    });
  });
}

async function assertServer(client, database, user) {
  const result = await query(
    client,
    "SELECT current_setting('transaction_read_only') AS readonly, current_setting('server_version_num') AS version, current_database() AS database, current_user AS username",
  );
  const row = result.rows[0];
  if (
    row.readonly !== "on" ||
    Number(row.version) < 170000 ||
    Number(row.version) >= 180000 ||
    row.database !== database ||
    row.username !== user
  ) {
    fail("database server identity or major version is not accepted");
  }
}

async function schemaGuard(client, source) {
  const schemas = await query(
    client,
    "SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('information_schema', 'public')",
  );
  if (schemas.rowCount) {
    fail("database has an unexpected non-public schema");
  }
  const unsupported = await query(
    client,
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND (c.relkind NOT IN ('r','i','S') OR c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition)
    UNION ALL SELECT 1 FROM pg_largeobject_metadata
    UNION ALL SELECT 1 FROM pg_event_trigger
    UNION ALL SELECT 1 FROM pg_publication
    UNION ALL SELECT 1 FROM pg_foreign_server
    UNION ALL SELECT 1 FROM pg_policy
    UNION ALL SELECT 1 FROM pg_inherits
    UNION ALL SELECT 1 FROM pg_statistic_ext
    UNION ALL SELECT 1 FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typrelid=0 AND t.typelem=0 AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')`,
  );
  if (unsupported.rowCount) fail("unsupported schema objects");
  for (const [catalog, namespace] of [
    ["pg_operator", "oprnamespace"],
    ["pg_opclass", "opcnamespace"],
    ["pg_opfamily", "opfnamespace"],
    ["pg_collation", "collnamespace"],
    ["pg_conversion", "connamespace"],
    ["pg_ts_config", "cfgnamespace"],
    ["pg_ts_dict", "dictnamespace"],
    ["pg_ts_parser", "prsnamespace"],
    ["pg_ts_template", "tmplnamespace"],
  ]) {
    const extras = await query(
      client,
      `SELECT 1 FROM ${catalog} o JOIN pg_namespace n ON n.oid=o.${namespace} WHERE n.nspname='public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid=$1::regclass AND d.objid=o.oid AND d.deptype='e')`,
      [catalog],
    );
    if (extras.rowCount) fail("unsupported public objects");
  }
  const extensions = await query(
    client,
    "SELECT 1 FROM pg_extension WHERE extname NOT IN ('plpgsql','vector','pg_trgm','pgcrypto')",
  );
  if (extensions.rowCount) fail("unsupported extension");
  const tables = await query(
    client,
    "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname",
  );
  const names = tables.rows.map((row) => row.name);
  if (source) {
    for (const name of names) {
      if (!CORE_TABLES.has(name)) {
        fail("database has an unexpected public application table");
      }
    }
    for (const name of CORE_TABLES) {
      if (name !== "reflection_sources" && !names.includes(name)) {
        fail("database is not the expected Reflection schema");
      }
    }
    const migrations = await query(
      client,
      "SELECT name FROM reflection_schema_migrations ORDER BY name",
    );
    const applied = new Set(migrations.rows.map((row) => row.name));
    if (
      REQUIRED_MIGRATIONS.some((name) => !applied.has(name)) ||
      [...applied].some((name) => !KNOWN_MIGRATIONS.has(name))
    ) {
      fail("database migration ledger is not an accepted Reflection revision");
    }
  }
  return names;
}

async function emptyTargetGuard(client) {
  await schemaGuard(client, false);
  const relations = await query(
    client,
    "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e' WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm') AND d.objid IS NULL LIMIT 1",
  );
  const functions = await query(
    client,
    "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace LEFT JOIN pg_depend d ON d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e' WHERE n.nspname = 'public' AND d.objid IS NULL LIMIT 1",
  );
  const extras = await query(
    client,
    "SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql' UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'",
  );
  if (relations.rowCount || functions.rowCount || extras.rowCount) {
    fail("restore target is not empty");
  }
}

async function schemaRecords(client) {
  const [
    columns,
    constraints,
    indexes,
    functions,
    extensions,
    triggers,
    relations,
    sequences,
  ] = await Promise.all([
    query(
      client,
      "SELECT c.relname AS table, a.attname AS column, a.attidentity AS identity, a.attgenerated AS generated, a.attstorage AS storage, a.attcompression AS compression, a.attnum AS position, a.attcollation::regcollation::text AS collation, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null, pg_get_expr(ad.adbin, ad.adrelid) AS default FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum",
    ),
    query(
      client,
      "SELECT c.relname AS table, con.conname AS name, con.contype AS type, pg_get_constraintdef(con.oid, true) AS definition, con.convalidated AS valid FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,con.conname",
    ),
    query(
      client,
      "SELECT c.relname AS table, i.relname AS name, pg_get_indexdef(i.oid) AS definition, x.indisvalid AS valid FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_class i ON i.oid=x.indexrelid WHERE n.nspname='public' ORDER BY c.relname,i.relname",
    ),
    query(
      client,
      "SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args, pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e') ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)",
    ),
    query(
      client,
      "SELECT e.extname AS name, e.extversion AS version FROM pg_extension e ORDER BY e.extname",
    ),
    query(
      client,
      "SELECT c.relname AS table, t.tgname AS name, t.tgenabled AS enabled, pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname",
    ),
    query(
      client,
      "SELECT c.relname AS name,c.relkind AS kind,c.relpersistence AS persistence,c.relreplident AS replica_identity,c.reloptions AS options FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname",
    ),
    query(
      client,
      "SELECT sequencename AS name,data_type,start_value,min_value,max_value,increment_by,cycle,cache_size FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename",
    ),
  ]);
  return Object.fromEntries(
    Object.entries({
      columns,
      constraints,
      indexes,
      functions,
      extensions,
      triggers,
      relations,
      sequences,
    }).map(([kind, result]) => [
      kind,
      result.rows.map((row) => ({
        name: row.name ?? row.column,
        ...(row.table ? { table: row.table } : {}),
        ...(row.version ? { version: row.version } : {}),
        digest: digest([row]),
      })),
    ]),
  );
}

async function tableInfo(client) {
  const result = await query(
    client,
    "SELECT c.relname AS name, array_agg(a.attname::text ORDER BY k.ordinality) FILTER (WHERE a.attname IS NOT NULL) AS keys FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary LEFT JOIN unnest(i.indkey) WITH ORDINALITY k(attnum, ordinality) ON true LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum WHERE n.nspname='public' AND c.relkind IN ('r','p') GROUP BY c.relname ORDER BY c.relname",
  );
  for (const row of result.rows) {
    if (
      !Array.isArray(row.keys) ||
      row.keys.length === 0 ||
      row.keys.some((key) => typeof key !== "string" || !key.length)
    ) {
      fail("public table has no primary key");
    }
  }
  return result.rows;
}

async function evidence(client) {
  stage = "EVIDENCE";
  const tables = [];
  for (const table of await tableInfo(client)) {
    const name = table.name;
    const order = table.keys.map(q).join(", ");
    await query(
      client,
      `DECLARE cp008_${name} NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS row FROM public.${q(name)} t ORDER BY ${order}`,
    );
    const hash = createHash("sha256");
    let count = 0;
    while (true) {
      const rows = await query(client, `FETCH FORWARD 32 FROM cp008_${name}`);
      if (!rows.rowCount) {
        break;
      }
      for (const row of rows.rows) {
        const bytes = Buffer.from(row.row, "utf8");
        hash.update(`${bytes.length}:`);
        hash.update(bytes);
        count += 1;
      }
    }
    await query(client, `CLOSE cp008_${name}`);
    tables.push({ name, count, digest: hash.digest("hex") });
  }
  const sequences = [];
  for (const table of tables) {
    const columns = await query(
      client,
      "SELECT a.attname AS column FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped",
      [table.name],
    );
    for (const { column } of columns.rows) {
      const sequence = await query(
        client,
        "SELECT pg_get_serial_sequence(format('%I.%I','public',$1::text),$2::text) AS name",
        [table.name, column],
      );
      if (sequence.rows[0].name) {
        const maximum = await query(
          client,
          `SELECT max(${q(column)})::text AS value FROM public.${q(table.name)}`,
        );
        const resolved = await query(
          client,
          "SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=$1::regclass AND c.relkind='S'",
          [sequence.rows[0].name],
        );
        sequences.push({
          table: table.name,
          column,
          schema: resolved.rows[0].schema,
          name: resolved.rows[0].name,
          max: maximum.rows[0].value,
        });
      }
    }
  }
  const schema = await schemaRecords(client);
  return { schema, schemaDigest: digest([schema]), tables, sequences };
}

function passwordEnvironment(url, readOnly) {
  return {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    PGPASSWORD: decodeURIComponent(url.parsed.password),
    PGOPTIONS: readOnly
      ? `-c default_transaction_read_only=on -c lock_timeout=5000 -c statement_timeout=${remaining()} -c TimeZone=UTC -c extra_float_digits=3`
      : `-c lock_timeout=5000 -c statement_timeout=${remaining()} -c TimeZone=UTC -c extra_float_digits=3`,
  };
}

function pgArgs(url, archive) {
  return [
    "--host",
    url.parsed.hostname,
    "--port",
    url.parsed.port || "5432",
    "--username",
    decodeURIComponent(url.parsed.username),
    "--dbname",
    decodeURIComponent(url.parsed.pathname.slice(1)),
    "--format=custom",
    "--no-owner",
    "--no-acl",
    "--lock-wait-timeout=5s",
    "--file",
    archive,
  ];
}

async function absent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  fail("output already exists");
}

async function backup() {
  const started = Date.now();
  const id = runId();
  const source = sourceConnection();
  const root = "/backup";
  const final = join(root, id);
  const lock = join(root, `${id}.lock`);
  const staging = join(root, `.${id}.partial`);
  try {
    await mkdir(lock, { mode: 0o700 });
    await absent(final);
    await mkdir(staging, { mode: 0o700 });
  } catch {
    fail("backup run identifier is already reserved or artifact exists");
  }
  let client;
  try {
    client = await connect(source.url);
    await assertServer(
      client,
      decodeURIComponent(source.parsed.pathname.slice(1)),
      decodeURIComponent(source.parsed.username),
    );
    await query(client, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await schemaGuard(client, true);
    const databaseBytes = BigInt(
      (
        await query(
          client,
          "SELECT pg_database_size(current_database())::text AS bytes",
        )
      ).rows[0].bytes,
    );
    const capacity = await statfs(root, { bigint: true });
    // Reserve room for this archive and a fresh local restore, plus host headroom.
    // This is a conservative preflight, not a guarantee against concurrent disk use.
    if (capacity.bavail * capacity.bsize < databaseBytes * 3n + 1073741824n)
      fail("insufficient local backup capacity");
    const snapshot = (await query(client, "SELECT pg_export_snapshot() AS id"))
      .rows[0].id;
    const archive = join(staging, "archive.dump");
    const dumped = Date.now();
    await child(
      "pg_dump",
      [...pgArgs(source, archive), "--snapshot", snapshot],
      passwordEnvironment(source, true),
    );
    await syncFile(archive);
    const dumpDurationMs = Date.now() - dumped;
    const proof = await evidence(client);
    await query(client, "COMMIT");
    const archiveStat = await stat(archive);
    const manifest = {
      version: 1,
      artifactId: ARTIFACT_ID,
      artifactSha256,
      runId: id,
      archiveSha256: await fileDigest(archive),
      archiveBytes: archiveStat.size,
      dumpDurationMs,
      evidence: proof,
    };
    await writePrivate(join(staging, "manifest.json"), `${stable(manifest)}\n`);
    await syncDirectory(staging);
    // The permanent exclusive run lock serializes all cooperative publishers.
    await absent(final);
    remaining();
    await rename(staging, final);
    await syncDirectory(root);
    event("CP008_BACKUP_COMPLETED", {
      artifactId: ARTIFACT_ID,
      runId: id,
      archiveBytes: archiveStat.size,
      archiveSha256: manifest.archiveSha256,
      durationMs: Date.now() - started,
      dumpDurationMs,
    });
  } finally {
    if (client) {
      await client.end().catch(() => {});
    }
  }
}

async function manifestFor(id) {
  const dir = join("/backup", id);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  } catch {
    fail("backup manifest is unavailable or invalid");
  }
  if (
    manifest?.version !== 1 ||
    manifest.artifactId !== ARTIFACT_ID ||
    manifest.artifactSha256 !== artifactSha256 ||
    manifest.runId !== id ||
    !HEX.test(manifest.archiveSha256) ||
    !Number.isSafeInteger(manifest.archiveBytes) ||
    manifest.archiveBytes <= 0 ||
    !HEX.test(manifest.evidence?.schemaDigest) ||
    !Array.isArray(manifest.evidence?.tables) ||
    !Array.isArray(manifest.evidence?.sequences)
  ) {
    fail("backup manifest has an invalid shape");
  }
  const proof = manifest.evidence;
  const names = proof.tables.map((table) => table.name);
  if (
    new Set(names).size !== names.length ||
    [...CORE_TABLES].some(
      (name) => name !== "reflection_sources" && !names.includes(name),
    ) ||
    proof.tables.some(
      (table) =>
        !CORE_TABLES.has(table.name) ||
        !Number.isSafeInteger(table.count) ||
        table.count < 0 ||
        !HEX.test(table.digest),
    ) ||
    !proof.schema ||
    digest([proof.schema]) !== proof.schemaDigest ||
    proof.sequences.some(
      (item) =>
        !names.includes(item.table) ||
        typeof item.column !== "string" ||
        !item.column ||
        item.schema !== "public" ||
        typeof item.name !== "string" ||
        !item.name ||
        (item.max !== null && !/^-?\d+$/.test(item.max)),
    )
  )
    fail("invalid evidence");
  const kinds = [
    "columns",
    "constraints",
    "indexes",
    "functions",
    "extensions",
    "triggers",
    "relations",
    "sequences",
  ];
  if (
    stable(Object.keys(proof.schema).sort()) !== stable(kinds.sort()) ||
    kinds.some(
      (kind) =>
        !Array.isArray(proof.schema[kind]) ||
        proof.schema[kind].some(
          (record) =>
            typeof record.name !== "string" ||
            !record.name ||
            !HEX.test(record.digest) ||
            (record.table != null && !names.includes(record.table)),
        ),
    )
  )
    fail("invalid schema inventory");
  const archive = join(dir, "archive.dump");
  if (
    (await stat(archive)).size !== manifest.archiveBytes ||
    (await fileDigest(archive)) !== manifest.archiveSha256
  ) {
    fail("backup archive digest or size does not match manifest");
  }
  return { dir, archive, manifest };
}

async function waitTarget(target) {
  const until = Math.min(deadlineAt, Date.now() + 30_000);
  while (Date.now() < until) {
    try {
      return await connect(target.url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  fail("restore target did not become ready");
}

async function assertSequences(client, sequences) {
  for (const item of sequences) {
    if (item.max === null) continue;
    const result = await query(
      client,
      `SELECT last_value::text AS value, is_called FROM ${q(item.schema)}.${q(item.name)}`,
    );
    const row = result.rows[0];
    const increment = await query(
      client,
      "SELECT increment_by::text AS value FROM pg_sequences WHERE schemaname=$1 AND sequencename=$2",
      [item.schema, item.name],
    );
    if (!increment.rowCount) fail("restored sequence is unavailable");
    const next =
      BigInt(row.value) +
      (row.is_called ? BigInt(increment.rows[0].value) : 0n);
    if (next <= BigInt(item.max))
      fail("restored sequence is not safe for referenced rows");
  }
}

async function verify() {
  const started = Date.now();
  const id = runId();
  const target = targetConnection();
  const reports = "/reports";
  await mkdir(join(reports, `${id}.lock`), { mode: 0o700 });
  await absent(join(reports, `${id}.verified.json`));
  const artifact = await manifestFor(id);
  let client;
  try {
    client = await waitTarget(target);
    await query(client, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await assertServer(
      client,
      decodeURIComponent(target.parsed.pathname.slice(1)),
      decodeURIComponent(target.parsed.username),
    );
    await emptyTargetGuard(client);
    await query(client, "COMMIT");
    await client.end();
    client = undefined;
    const args = [
      "--host",
      target.parsed.hostname,
      "--port",
      target.parsed.port || "5432",
      "--username",
      decodeURIComponent(target.parsed.username),
      "--dbname",
      decodeURIComponent(target.parsed.pathname.slice(1)),
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--no-acl",
      artifact.archive,
    ];
    await child("pg_restore", args, passwordEnvironment(target, false));
    client = await connect(target.url);
    await query(client, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = await schemaGuard(client, true);
    if (tables.length === 0) fail("restore did not create public schema");
    const proof = await evidence(client);
    if (
      proof.schemaDigest !== artifact.manifest.evidence.schemaDigest ||
      stable(proof.tables) !== stable(artifact.manifest.evidence.tables)
    ) {
      fail("restored schema or table evidence does not match backup");
    }
    if (
      stable(proof.sequences) !== stable(artifact.manifest.evidence.sequences)
    )
      fail("sequence evidence mismatch");
    await assertSequences(client, proof.sequences);
    await query(client, "COMMIT");
    await mkdir(reports, { recursive: true, mode: 0o700 });
    const report = {
      version: 1,
      status: "passed",
      artifactId: ARTIFACT_ID,
      artifactSha256,
      runId: id,
      archiveSha256: artifact.manifest.archiveSha256,
      durationMs: Date.now() - started,
      assertions: ASSERTIONS,
    };
    const temporary = join(reports, `.${id}.verified.partial`);
    const output = join(reports, `${id}.verified.json`);
    await writePrivate(temporary, `${stable(report)}\n`);
    remaining();
    await link(temporary, output);
    await unlink(temporary);
    await syncDirectory(reports);
    event("CP008_VERIFY_COMPLETED", {
      artifactId: ARTIFACT_ID,
      runId: id,
      archiveSha256: artifact.manifest.archiveSha256,
      durationMs: report.durationMs,
    });
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

async function reportCheck() {
  const id = runId();
  const artifact = await manifestFor(id);
  let report;
  try {
    report = JSON.parse(
      await readFile(join("/reports", `${id}.verified.json`), "utf8"),
    );
  } catch {
    fail("verified report is unavailable or invalid");
  }
  if (
    report?.version !== 1 ||
    report.status !== "passed" ||
    report.artifactId !== ARTIFACT_ID ||
    report.artifactSha256 !== artifactSha256 ||
    report.runId !== id ||
    report.archiveSha256 !== artifact.manifest.archiveSha256 ||
    !Array.isArray(report.assertions) ||
    stable([...report.assertions].sort()) !== stable([...ASSERTIONS].sort())
  ) {
    fail("verified report does not match backup artifact");
  }
  event("CP008_REPORT_CHECK_COMPLETED", {
    artifactId: ARTIFACT_ID,
    runId: id,
    archiveSha256: report.archiveSha256,
  });
}

async function main() {
  timeout();
  stage = "ARTIFACT";
  const expected = process.env.EXPECTED_ARTIFACT_SHA256;
  if (typeof expected !== "string" || !HEX.test(expected))
    fail("invalid artifact hash");
  artifactSha256 = await fileDigest(new URL(import.meta.url));
  if (artifactSha256 !== expected) fail("artifact hash mismatch");
  stage = "START";
  const mode = process.argv[2];
  if (mode === "backup") return backup();
  if (mode === "verify") return verify();
  if (mode === "report-check") return reportCheck();
  fail("mode must be backup, verify, or report-check");
}

function safeFailure(error, code = "FAILED") {
  if (stopping) return;
  stopping = true;
  clearTimeout(deadlineTimer);
  event("CP008_OPERATION_FAILED", {
    artifactId: ARTIFACT_ID,
    stage,
    reason: code,
    ...(typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)
      ? { sqlstate: error.code }
      : {}),
  });
  for (const child of children) child.kill("SIGTERM");
  for (const client of clients) void client.end().catch(() => {});
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(1);
  }, 500);
}

process.on("uncaughtException", (error) => safeFailure(error));
process.on("unhandledRejection", (error) => safeFailure(error));
process.on("SIGTERM", () => safeFailure(undefined, "INTERRUPTED"));
process.on("SIGINT", () => safeFailure(undefined, "INTERRUPTED"));
main()
  .then(() => {
    clearTimeout(deadlineTimer);
    if (!stopping) process.exit(0);
  })
  .catch(safeFailure);
