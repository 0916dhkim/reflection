import { spawn } from "node:child_process";
import { mkdir, cp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import pg from "/versions/new/server/node_modules/pg/esm/index.mjs";

const started = performance.now();
const deadline = started + 150_000;
const databaseUrl = process.env.REHEARSAL_DATABASE_URL;
const legacy = "rehearsal-legacy";
const secondary = "rehearsal-secondary";
const children = [];
const clients = [];
const report = {
  outcome: "failed",
  startedAt: new Date().toISOString(),
  assertions: [],
  phases: [],
  timings: {},
  limitations: [
    "Disposable synthetic fixture timings are not a production downtime guarantee.",
    "Native v2 ingestion/range hydration is outside CP007 scope.",
    "Restore is point-in-time recovery; writes after the baseline snapshot are not preserved.",
    "CP008 must configure a documented deployment stop timeout matching the tested 2000ms grace, or drain workers while the API remains available. The repository default 15-minute grace does not establish a few-second outage window.",
    "Index startup scope: incomplete preparation refused; invalid index repair independently proved. Startup refusal is not isolated to the invalid-index guard because other indexes are missing and old uniqueness keys remain.",
    "The five-second synthetic outage budget represents a few-second fixture window, not a production guarantee.",
    "Cutover-boundary backup protects pre-cutover accepted jobs only. No zero-data-loss rollback after new writes is demonstrated: prefer fail-forward; CP008 requires a current backup and durable preservation/replay of late writes, not automatic rollback to old state.",
  ],
  clientCompatibility: [],
};
let sequence = 0;
let reader;
let db;
const remoteHistories = new Map();
let remoteUnavailable = false;
let remoteFailures = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const environment = (extra = {}) => ({
  HOME: "/state/home",
  PATH: "/usr/lib/postgresql/17/bin:/usr/local/bin:/usr/bin:/bin",
  TMPDIR: "/tmp",
  ...extra,
});

function check(name, condition, details) {
  report.assertions.push({
    name,
    passed: Boolean(condition),
    ...(details === undefined ? {} : { details }),
  });
  if (!condition) throw new Error(name);
}

async function poll(label, callback, timeout = 12_000) {
  const until = Math.min(deadline, performance.now() + timeout);
  while (performance.now() < until) {
    const result = await callback();
    if (result) return result;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}

async function phase(name, callback) {
  const item = { name, startedAt: new Date().toISOString(), outcome: "failed" };
  report.phases.push(item);
  const start = performance.now();
  try {
    await callback();
    item.outcome = "passed";
  } finally {
    item.durationMs = Math.round(performance.now() - start);
  }
}

function child(label, command, args, env, ipc = false) {
  const proc = spawn(command, args, {
    env: environment(env),
    stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc"] : [])],
  });
  const item = {
    label,
    proc,
    events: [],
    output: "",
    exited: false,
    code: null,
    signal: null,
  };
  children.push(item);
  for (const stream of [proc.stdout, proc.stderr])
    stream.on("data", (data) => {
      item.output = (item.output + data.toString()).slice(-24_000);
    });
  proc.on("message", (message) => {
    item.events.push(message);
    if (item.autoRelease && ["extract", "resolve"].includes(message.event)) {
      proc.send({ cmd: "release", sessionId: message.sessionId });
    }
  });
  proc.on("error", (error) => {
    item.output += String(error);
    item.exited = true;
  });
  proc.on("exit", (code, signal) => {
    item.exited = true;
    item.code = code;
    item.signal = signal;
  });
  return item;
}

async function exited(item) {
  await poll(`${item.label} exit`, () => item.exited);
  return item;
}
async function event(item, name, sessionId) {
  return poll(`${item.label} ${name}`, () => {
    const found = item.events.find(
      (e) =>
        e.event === name &&
        (sessionId === undefined || e.sessionId === sessionId),
    );
    if (!found && item.exited)
      throw new Error(`${item.label} exited before ${name}: ${item.output}`);
    return found;
  });
}
async function rpc(item, cmd, fields = {}, allowFailure = false) {
  const id = ++sequence;
  item.proc.send({ id, cmd, ...fields });
  const reply = await poll(`${item.label} ${cmd}`, () => {
    const found = item.events.find((e) => e.id === id);
    if (!found && item.exited)
      throw new Error(`${item.label} exited during ${cmd}`);
    return found;
  });
  if (!reply.ok && !allowFailure)
    throw new Error(`${item.label} ${cmd}: ${reply.error}`);
  return reply;
}
async function stop(item, signal = "SIGTERM") {
  if (!item.exited) item.proc.kill(signal);
  await exited(item);
}
function backend(version, url = databaseUrl, port = 43517) {
  return child(
    `${version}-backend-${++sequence}`,
    "node",
    [`/versions/${version}/server/rehearsal.mjs`],
    {
      REHEARSAL_DATABASE_URL: url,
      REHEARSAL_MIGRATIONS_DIR: `/versions/${version}/migrations`,
      REHEARSAL_VERSION: version,
      REHEARSAL_PORT: String(port),
    },
    true,
  );
}
async function ready(item) {
  item.url = (await event(item, "ready")).url;
  await http(item, "/healthz");
  return item;
}
async function http(item, path, body, status = 200) {
  const response = await fetch(`${item.url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-api-key": "fixture-api-key",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  if (response.status !== status)
    throw new Error(
      `HTTP ${path}: expected ${status}, got ${response.status}: ${text.slice(0, 1000)}`,
    );
  return text ? JSON.parse(text) : null;
}
function request(sessionId, sourceId = legacy) {
  return {
    source_id: sourceId,
    session_id: sessionId,
    start_user_message_id: "u1",
    end_user_message_id: "u2",
    projection_version: 1,
    messages: [
      { role: "user", text: `Archive request ${sessionId}` },
      { role: "assistant", text: "Fixture service uses fixture memory." },
    ],
  };
}
async function submit(item, sessionId, sourceId = legacy) {
  return http(item, "/v1/segments", request(sessionId, sourceId), 202);
}
async function jobState(job, status, connection = db) {
  return poll(`job ${job.id} ${status}`, async () => {
    const row = (
      await connection.query("SELECT * FROM extraction_jobs WHERE id = $1", [
        job.id,
      ])
    ).rows[0];
    if (row?.status === "failed" && status !== "failed")
      throw new Error(`Job ${job.id} failed: ${row.error}`);
    return row?.status === status && row;
  });
}
async function write(item, sessionId, sourceId = legacy, connection = db) {
  const job = await submit(item, sessionId, sourceId);
  await jobState(job, "succeeded", connection);
  return job;
}
function operator(args, connectionUrl = databaseUrl) {
  return child(
    `operator-${args[0]}-${++sequence}`,
    "node",
    ["/versions/new/scripts/source-ownership.mjs", ...args],
    {
      DATABASE_URL: connectionUrl,
      MIGRATIONS_DIR: "/versions/new/migrations",
    },
  );
}
async function operate(args, success = true) {
  const start = performance.now();
  const item = await exited(operator(args));
  report.timings[`${args[0]}-${sequence}`] = Math.round(
    performance.now() - start,
  );
  check(
    `operator ${args.join(" ")} ${success ? "succeeds" : "refuses"}`,
    success ? item.code === 0 : item.code !== 0 && item.signal === null,
    item.output.trim(),
  );
}
async function connect(url = databaseUrl) {
  const connection = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    query_timeout: 7000,
  });
  clients.push(connection);
  await connection.connect();
  return connection;
}
function history(sessionId, remote = false) {
  const common = {
    sessionID: sessionId,
    agent: "build",
    model: { providerID: "fixture", modelID: "model" },
  };
  return [
    {
      info: { ...common, id: "u1", role: "user", time: { created: 1 } },
      parts: [
        {
          type: "text",
          text: `${remote ? "REMOTE" : "LOCAL"} archive request: ${"x".repeat(30_000)}`,
        },
      ],
    },
    {
      info: {
        ...common,
        id: "a1",
        role: "assistant",
        parentID: "u1",
        providerID: "fixture",
        modelID: "model",
        time: { created: 2, completed: 3 },
        finish: "stop",
        tokens: {
          input: 100_000,
          output: 1000,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
      parts: [{ type: "text", text: `Archive answer: ${"x".repeat(30_000)}` }],
    },
    {
      info: { ...common, id: "u2", role: "user", time: { created: 4 } },
      parts: [
        { type: "text", text: "LATEST REQUEST: keep this raw input intact." },
      ],
    },
  ];
}
async function plugin(
  version,
  backendItem,
  home = `/state/${version}-plugin`,
  sourceId = legacy,
) {
  const item = child(
    `${version}-plugin-${++sequence}`,
    "node",
    ["/harness/plugin-child.mjs"],
    {
      HOME: home,
      REHEARSAL_PLUGIN_BUNDLE: `/versions/${version}/plugin/dist/reflection.js`,
      REHEARSAL_REFLECTION_URL: backendItem.url,
      REHEARSAL_SOURCE_ID: sourceId,
      REHEARSAL_READER_URL: `http://127.0.0.1:${reader.address().port}`,
      REHEARSAL_PLUGIN_VERSION: version,
    },
    true,
  );
  await event(item, "ready");
  check(`${item.label} disables automatic compaction`, true);
  await rpc(item, "set-history", {
    sessionId: "plugin-history",
    messages: history("plugin-history"),
  });
  return item;
}
async function projection(item, label) {
  const result = await rpc(item, "project", {
    messages: history("plugin-history"),
  });
  const text = JSON.stringify(result.messages);
  check(
    `${label}: real summary projected`,
    text.includes("Summary plugin-history"),
  );
  check(
    `${label}: latest user retained raw`,
    result.messages.some(
      (m) =>
        m.info.role === "user" &&
        m.parts.some(
          (p) => p.text === "LATEST REQUEST: keep this raw input intact.",
        ),
    ),
  );
  check(
    `${label}: archive reduced`,
    text.length < JSON.stringify(history("plugin-history")).length / 2,
  );
}
async function pluginTools(item, segmentId, label) {
  const search = await rpc(item, "search", { query: "Fixture service" });
  check(
    `${label}: plugin search returns claims`,
    String(search.result).includes("fixture memory"),
  );
  const read = await rpc(item, "read", { sourceId: legacy, segmentId });
  check(
    `${label}: plugin hydrates local original`,
    String(read.result).includes("LOCAL archive request"),
  );
}
async function snapshot(connection = db, original, complete = false) {
  const result = {};
  const tables = [
    "segments",
    "extraction_jobs",
    "segment_targets",
    "claims",
    ...(complete ? ["entities", "entity_aliases", "reflection_sources"] : []),
  ];
  for (const table of tables) {
    result[table] = (
      await connection.query(
        `SELECT to_jsonb(t) ${complete ? "" : "- 'source_id'"} AS row FROM ${table} t ORDER BY to_jsonb(t)::text`,
      )
    ).rows.map((r) => r.row);
    if (original) {
      const key = table === "segment_targets" ? "segment_id" : "id";
      const ids = new Set(original[table].map((row) => row[key]));
      result[table] = result[table].filter((row) => ids.has(row[key]));
    }
    result[table].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  }
  return result;
}
async function refusedStartup(label) {
  const item = backend("new", databaseUrl, 0);
  await event(item, "startup-error");
  await exited(item);
  check(
    label,
    item.code !== 0 &&
      !item.events.some((e) =>
        ["ready", "extract", "resolve"].includes(e.event),
      ),
  );
}

let old,
  current,
  oldPlugin,
  newPlugin,
  baselineJob,
  failedJob,
  pluginSegment,
  baseline;
let cutoverSnapshot;
const watchdog = setTimeout(() => {
  report.error = "Scenario exceeded 150 second deadline";
  for (const item of children) if (!item.exited) item.proc.kill("SIGKILL");
}, 150_000);

try {
  const parsed = new URL(databaseUrl);
  if (
    parsed.hostname !== "postgres" ||
    parsed.pathname !== "/rehearsal" ||
    parsed.username !== "rehearsal"
  )
    throw new Error("Only disposable rehearsal database is allowed");
  await mkdir("/state/home", { recursive: true });
  report.provenance = JSON.parse(
    await readFile("/harness/runtime-provenance.json", "utf8"),
  );
  reader = createServer((req, res) => {
    const match = new URL(req.url, "http://fixture").pathname.match(
      /^\/session\/([^/]+)\/message$/,
    );
    const messages = match && remoteHistories.get(decodeURIComponent(match[1]));
    if (messages && remoteUnavailable) {
      remoteFailures += 1;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: "fixture history temporarily unavailable" }),
      );
      return;
    }
    res.writeHead(messages ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(messages ?? { error: "unknown fixture history" }));
  });
  await new Promise((resolve) => reader.listen(0, "127.0.0.1", resolve));
  db = await connect();

  await phase("old baseline and point-in-time snapshot", async () => {
    old = await ready(backend("old"));
    baselineJob = await write(old, "baseline-committed");
    failedJob = await submit(old, "fail-extract-terminal");
    await jobState(failedJob, "failed");
    oldPlugin = await plugin("old", old);
    await rpc(oldPlugin, "idle", { sessionId: "plugin-history" });
    pluginSegment = await poll(
      "old plugin idle committed",
      async () =>
        (
          await db.query(
            "SELECT id FROM segments WHERE session_id = 'plugin-history' LIMIT 1",
          )
        ).rows[0],
    );
    await projection(oldPlugin, "old baseline");
    await pluginTools(oldPlugin, pluginSegment.id, "old baseline");
    report.clientCompatibility.push({
      plugin: "old",
      backend: "old",
      behavior: "idle ingestion, projection, search and read succeed",
    });
    await rpc(oldPlugin, "dispose");
    await exited(oldPlugin);
    await rpc(old, "stop-worker");
    baseline = await snapshot();
    report.baseline = {
      digest: digest(baseline),
      segments: baseline.segments.map((s) => ({
        id: s.id,
        sessionId: s.session_id,
        sourceFingerprint: s.source_fingerprint,
        summary: s.summary,
      })),
      logicalSource: "unowned legacy (no source_id column)",
      payloadSourceIgnored: baseline.extraction_jobs.every(
        (j) => !j.payload || !("source_id" in j.payload),
      ),
    };
    check(
      "old transport source_id not persisted",
      report.baseline.payloadSourceIgnored &&
        baseline.segment_targets.every(
          (t) => !t.payload || !("source_id" in t.payload),
        ),
    );
    await writeFile("/state/baseline-logical.json", JSON.stringify(baseline));
    const dump = await exited(
      child("pg-dump", "pg_dump", [
        "-Fc",
        "--file=/state/baseline.dump",
        "--dbname",
        databaseUrl,
      ]),
    );
    check("baseline pg_dump succeeds", dump.code === 0, dump.output);
    report.snapshotAt = new Date().toISOString();
    await cp("/state/old-plugin", "/state/plugin-snapshot", {
      recursive: true,
    });
    await cp("/state/plugin-snapshot", "/state/new-plugin", {
      recursive: true,
    });
    await stop(old);
    old = await ready(backend("old"));
    oldPlugin = await plugin("old", old);
  });

  await phase("new client against old backend fails closed", async () => {
    const beforeSkew = await snapshot();
    const requests = [];
    const proxy = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, path: req.url, bytes: body.length });
      try {
        const response = await fetch(`${old.url}${req.url}`, {
          method: req.method,
          headers: {
            "x-api-key": "fixture-api-key",
            "content-type": "application/json",
          },
          body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
          signal: AbortSignal.timeout(5000),
        });
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(await response.text());
      } catch {
        res.writeHead(502);
        res.end();
      }
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const skewStart = performance.now();
    try {
      const skew = await plugin(
        "new",
        { url: `http://127.0.0.1:${proxy.address().port}` },
        "/state/skew-new-on-old",
        secondary,
      );
      const failedProjection = await rpc(
        skew,
        "project",
        { messages: history("plugin-history") },
        true,
      );
      check(
        "new client projection rejects old backend registry",
        failedProjection.ok === false &&
          /source registry/i.test(failedProjection.error),
        failedProjection.error,
      );
      const failedRead = await rpc(skew, "read", {
        sourceId: secondary,
        segmentId: pluginSegment.id,
      });
      check(
        "new client read fails registry lookup without local fallback",
        /source registry/i.test(String(failedRead.result)) &&
          !String(failedRead.result).includes("LOCAL archive request"),
        failedRead.result,
      );
      await rpc(skew, "idle", { sessionId: "plugin-history" });
      await rpc(skew, "dispose");
      await exited(skew);
      check(
        "new client sends no source data to old backend",
        requests.some((r) => r.path.startsWith("/v1/sources/")) &&
          !requests.some((r) => r.method === "POST") &&
          digest(beforeSkew) === digest(await snapshot()),
        requests,
      );
      report.timings.newClientOldBackendRefusalMs = Math.round(
        performance.now() - skewStart,
      );
      report.clientCompatibility.push({
        plugin: "new",
        backend: "old",
        behavior:
          "registry read and projection fail closed; auto compaction disabled; no ingestion POST",
        requests,
      });
    } finally {
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
    }
  });

  await phase("online expansion and explicit preparation", async () => {
    const initialLedger = (
      await db.query(
        "SELECT name FROM reflection_schema_migrations ORDER BY name",
      )
    ).rows;
    check(
      "explicit expand starts at ledger 001-008 with no source registry",
      initialLedger.length === 8 &&
        initialLedger.every((row, index) =>
          row.name.startsWith(String(index + 1).padStart(3, "0")),
        ) &&
        (await db.query("SELECT to_regclass('reflection_sources') AS registry"))
          .rows[0].registry === null,
    );
    await operate(["expand"]);
    const expectedMigrations = Object.keys(
      report.provenance.builds.new.migrations,
    ).sort();
    const expandedLedger = (
      await db.query(
        "SELECT name FROM reflection_schema_migrations ORDER BY name",
      )
    ).rows;
    check(
      "explicit expand applies exactly the new snapshot migration ledger",
      expandedLedger.length === expectedMigrations.length &&
        expandedLedger.every(
          (row, index) => row.name === expectedMigrations[index],
        ),
      {
        expected: expectedMigrations,
        actual: expandedLedger.map((row) => row.name),
      },
    );
    check(
      "expand does not register sources",
      (await db.query("SELECT count(*)::int AS n FROM reflection_sources"))
        .rows[0].n === 0,
    );
    await refusedStartup("new startup refuses expanded but unprepared schema");
    await http(old, `/v1/segments/${baselineJob.segment_id}`);
    await projection(oldPlugin, "old after expand");
    await write(old, "post-expand-write");
    await stop(old);
    old = await ready(backend("old"));
    await http(old, `/v1/segments/${baselineJob.segment_id}`);
    await write(old, "old-restart-after-expansion");
    check("old migration directory restarts after expanded ledger", true);
    for (const [id, scheme] of [
      [legacy, "legacy"],
      [secondary, "source-v1"],
    ])
      await operate([
        "register",
        "--id",
        id,
        "--kind",
        "opencode-v1",
        "--identity-scheme",
        scheme,
      ]);
    await write(old, "before-indexes");
    const interruptedIndexName = expectedMigrations.includes(
      "010_native_source_spans.sql",
    )
      ? "segments_source_v3_start_key"
      : "segments_source_v1_start_key";
    const indexBlocker = await connect();
    await indexBlocker.query("BEGIN");
    await indexBlocker.query(
      "UPDATE segments SET summary = summary WHERE id = $1",
      [baselineJob.segment_id],
    );
    const indexHoldStart = performance.now();
    // Detect the killed client while PostgreSQL is still waiting on our writer.
    const interruptibleUrl = new URL(databaseUrl);
    interruptibleUrl.searchParams.set(
      "options",
      "-c client_connection_check_interval=100ms",
    );
    const installer = operator(["install-indexes"], interruptibleUrl.href);
    const interruptedIndex = await poll(
      "concurrent index build waiting on writer with invalid index",
      async () => {
        if (installer.exited)
          throw new Error(
            `installer exited before interruption: ${installer.output}`,
          );
        return (
          await db.query(
            "SELECT p.pid, p.phase, i.indexrelid::text AS oid, i.indisvalid FROM pg_stat_progress_create_index p JOIN pg_index i ON i.indexrelid = p.index_relid WHERE p.command = 'CREATE INDEX CONCURRENTLY' AND i.indexrelid = to_regclass($1) AND NOT i.indisvalid AND p.phase LIKE 'waiting for writers%' ",
            [interruptedIndexName],
          )
        ).rows[0];
      },
      3000,
    );
    await stop(installer, "SIGKILL");
    await poll(
      "interrupted index backend releases session",
      async () =>
        (
          await db.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1",
            [interruptedIndex.pid],
          )
        ).rows[0].n === 0,
      3000,
    );
    await indexBlocker.query("ROLLBACK");
    report.timings.controlledIndexWriterHoldMs = Math.round(
      performance.now() - indexHoldStart,
    );
    const invalid = (
      await db.query(
        "SELECT indexrelid::text AS oid, indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)",
        [interruptedIndexName],
      )
    ).rows[0];
    check(
      "killed concurrent installer leaves an invalid index",
      installer.signal === "SIGKILL" &&
        invalid?.indisvalid === false &&
        invalid.oid === interruptedIndex.oid,
      interruptedIndex,
    );
    await refusedStartup(
      "new startup refuses incomplete preparation after interrupted index installation",
    );
    await operate(["install-indexes"]);
    const repaired = (
      await db.query(
        "SELECT indexrelid::text AS oid, indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)",
        [interruptedIndexName],
      )
    ).rows[0];
    check(
      "installer replaces invalid index with valid index",
      repaired?.indisvalid === true && repaired.oid !== invalid.oid,
    );
    const requiredIndexes = [
      "segments_source_v1_start_key",
      "segments_source_v2_start_key",
      "extraction_jobs_source_v1_boundary_key",
      "extraction_jobs_source_v2_boundary_key",
      "extraction_jobs_source_job_segment_key",
      ...(expectedMigrations.includes("010_native_source_spans.sql")
        ? [
            "segments_source_v3_start_key",
            "extraction_jobs_source_v3_boundary_key",
          ]
        : []),
    ].sort();
    const indexQuery = {
      text: "SELECT c.relname AS name, i.indexrelid::text AS oid, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) ORDER BY c.relname",
      values: [requiredIndexes],
    };
    const installedIndexes = (await db.query(indexQuery)).rows;
    check(
      "installer creates every required valid index",
      installedIndexes.length === requiredIndexes.length &&
        installedIndexes.every(
          (row, index) => row.name === requiredIndexes[index] && row.indisvalid,
        ),
      installedIndexes,
    );
    await operate(["install-indexes"]);
    const validIndexes = (await db.query(indexQuery)).rows;
    check(
      "installer preserves valid indexes on rerun",
      validIndexes.length === requiredIndexes.length &&
        validIndexes.every(
          (row, index) =>
            row.name === requiredIndexes[index] &&
            row.indisvalid &&
            row.oid === installedIndexes[index].oid,
        ) &&
        validIndexes.find((row) => row.name === interruptedIndexName)?.oid ===
          repaired.oid,
    );
    await http(old, `/v1/segments/${baselineJob.segment_id}`);
    await write(old, "after-indexes");
    const expanded = await snapshot();
    check(
      "online preparation preserves baseline records except ownership",
      Object.entries(baseline).every(([table, rows]) =>
        rows.every((row) =>
          expanded[table].some(
            (candidate) => digest(candidate) === digest(row),
          ),
        ),
      ),
    );
    await refusedStartup("new startup refuses indexes without cutover");
  });

  await phase("graceful drain and forced worker recovery", async () => {
    const drain = await submit(old, "hold-extract-drain");
    await event(old, "extract", "hold-extract-drain");
    const signalAt = performance.now();
    old.proc.kill("SIGTERM");
    await sleep(250);
    check("SIGTERM waits for held worker", !old.exited);
    const releaseAt = performance.now();
    old.proc.send({ cmd: "release", sessionId: "hold-extract-drain" });
    await exited(old);
    await jobState(drain, "succeeded");
    report.timings.gracefulDrainMs = Math.round(performance.now() - releaseAt);
    report.timings.excludedArtificialDrainHoldMs = Math.round(
      releaseAt - signalAt,
    );
    check("graceful drain exits cleanly", old.code === 0);
    old = await ready(backend("old"));
    const active = await submit(old, "hold-extract-recovery");
    const activeEvent = await event(old, "extract", "hold-extract-recovery");
    const staged = await submit(old, "hold-resolve-recovery");
    await event(old, "resolve", "hold-resolve-recovery");
    const pending = await submit(old, "pending-recovery");
    const activeRow = await jobState(active, "running");
    const stagedRow = await jobState(staged, "running");
    await jobState(pending, "pending");
    const target = (
      await db.query(
        "SELECT extraction_result FROM segment_targets WHERE job_id = $1",
        [staged.id],
      )
    ).rows[0];
    check(
      "active leases and staged extraction persisted before kill",
      Boolean(
        activeRow.lease_id && stagedRow.lease_id && target?.extraction_result,
      ),
    );
    await rpc(oldPlugin, "dispose");
    await exited(oldPlugin);
    await http(old, "/healthz");
    const lastOldSuccess = performance.now();
    const shutdownGraceMs = 2000;
    const termAt = performance.now();
    old.proc.kill("SIGTERM");
    await sleep(shutdownGraceMs);
    const killAt = performance.now();
    report.timings.configuredShutdownGraceMs = shutdownGraceMs;
    report.timings.actualShutdownGraceMs = Math.round(killAt - termAt);
    check(
      "bounded SIGTERM grace expires with held active and staged work still alive",
      !old.exited && killAt - termAt >= shutdownGraceMs,
    );
    await stop(old, "SIGKILL");
    check("old process killed", old.signal === "SIGKILL");
    const lock = await connect();
    await poll(
      "worker advisory lock released after kill",
      async () =>
        (
          await lock.query(
            "SELECT pg_try_advisory_lock(7320260818001) AS acquired",
          )
        ).rows[0].acquired,
    );
    await lock.query("SELECT pg_advisory_unlock(7320260818001)");
    check("worker advisory lock released", true);
    const backupStart = performance.now();
    cutoverSnapshot = await snapshot(db, undefined, true);
    const boundaryDump = await exited(
      child("pg-dump-cutover", "pg_dump", [
        "-Fc",
        "--file=/state/cutover.dump",
        "--dbname",
        databaseUrl,
      ]),
    );
    report.timings.cutoverBoundaryBackupMs = Math.round(
      performance.now() - backupStart,
    );
    check(
      "quiescent cutover-boundary dump succeeds before old keys are dropped",
      boundaryDump.code === 0 &&
        old.exited &&
        digest(cutoverSnapshot) === digest(await snapshot(db, undefined, true)),
      boundaryDump.output,
    );
    report.cutoverBackup = {
      capturedAt: new Date().toISOString(),
      digest: digest(cutoverSnapshot),
      tables: Object.keys(cutoverSnapshot),
      jobCount: cutoverSnapshot.extraction_jobs.length,
      includedInHttpOutage: true,
    };
    await writeFile(
      "/state/cutover-logical.json",
      JSON.stringify(cutoverSnapshot),
    );
    await operate(["cutover", "--old-writers-stopped"]);
    current = backend("new");
    current.autoRelease = true;
    await ready(current);
    report.timings.httpOutageUpperBoundMs = Math.round(
      performance.now() - lastOldSuccess,
    );
    check(
      "cutover outage measurement includes entire shutdown grace",
      report.timings.httpOutageUpperBoundMs >=
        report.timings.actualShutdownGraceMs,
    );
    report.timings.syntheticOutageBudgetMs = 5000;
    check(
      "synthetic cutover outage including stop grace and backup meets five-second budget",
      report.timings.httpOutageUpperBoundMs <=
        report.timings.syntheticOutageBudgetMs,
      {
        measuredMs: report.timings.httpOutageUpperBoundMs,
        budgetMs: report.timings.syntheticOutageBudgetMs,
      },
    );
    await jobState(active, "succeeded");
    await jobState(staged, "succeeded");
    await jobState(pending, "succeeded");
    const recovered = await event(current, "extract", "hold-extract-recovery");
    check(
      "active recovery replaces lease",
      recovered.leaseId !== activeEvent.leaseId && Boolean(recovered.leaseId),
    );
    check(
      "staged extraction reused without extraction call",
      current.events.some(
        (e) => e.event === "resolve" && e.sessionId === "hold-resolve-recovery",
      ) &&
        !current.events.some(
          (e) =>
            e.event === "extract" && e.sessionId === "hold-resolve-recovery",
        ),
    );
    await jobState(failedJob, "failed");
    check(
      "terminal failure not retried",
      !current.events.some((e) => e.sessionId === "fail-extract-terminal"),
    );
    const recoveredBaseline = await snapshot(db, baseline);
    check(
      "cutover recovery preserves all original committed plugin and failed-job rows except ownership",
      digest(baseline) === digest(recoveredBaseline),
    );
    report.recoveryPreservation = {
      before: digest(baseline),
      after: digest(recoveredBaseline),
      excludedColumns: ["source_id"],
      tables: Object.keys(baseline),
    };
    newPlugin = await plugin("new", current);
    await projection(newPlugin, "new before backfill");
    const previousPlugin = newPlugin;
    await rpc(previousPlugin, "dispose");
    await exited(previousPlugin);
    newPlugin = await plugin("new", current);
    check(
      "new plugin restarts in a distinct process with same HOME",
      previousPlugin.code === 0 &&
        previousPlugin.proc.pid !== newPlugin.proc.pid,
    );
    await projection(newPlugin, "new same-HOME restart");
    await pluginTools(newPlugin, pluginSegment.id, "new paired baseline");
    report.clientCompatibility.push({
      plugin: "new",
      backend: "new",
      behavior:
        "paired read/search and projection succeed, including same-HOME restart",
    });
    const oldSkewStart = performance.now();
    const oldSkew = await plugin("old", current, "/state/skew-old-on-new");
    const unscopedRead = await rpc(oldSkew, "read", {
      segmentId: pluginSegment.id,
    });
    const unscopedText = String(unscopedRead.result);
    check(
      "old client read rejects strict backend unscoped metadata without fallback",
      /memory_read_segment/i.test(unscopedText) &&
        /422/.test(unscopedText) &&
        !unscopedText.includes("LOCAL archive request") &&
        !unscopedText.includes("Summary plugin-history"),
      unscopedRead.result,
    );
    await rpc(oldSkew, "dispose");
    await exited(oldSkew);
    report.timings.oldClientNewBackendRefusalMs = Math.round(
      performance.now() - oldSkewStart,
    );
    report.clientCompatibility.push({
      plugin: "old",
      backend: "new",
      behavior:
        "unscoped metadata read fails explicitly without local fallback; search compatibility not required",
    });
    const manifest = await http(
      current,
      `/v1/sessions/plugin-history/segments?source_id=${legacy}`,
    );
    check(
      "new manifest carries source identity",
      manifest.source_id === legacy && manifest.segments.length > 0,
    );
    await http(current, `/v1/segments/${pluginSegment.id}`, undefined, 422);
    await http(
      current,
      `/v1/segments/${pluginSegment.id}?source_id=unknown`,
      undefined,
      422,
    );
    await http(
      current,
      `/v1/segments/${pluginSegment.id}?source_id=${secondary}`,
      undefined,
      404,
    );
    const missing = request("missing-source");
    delete missing.source_id;
    await http(current, "/v1/segments", missing, 422);
    await http(
      current,
      "/v1/segments",
      request("unknown-source", "unknown"),
      422,
    );
    check("missing unknown and wrong source pairs rejected", true);
    remoteHistories.set("plugin-history", history("plugin-history", true));
    const remoteRequest = request("plugin-history", secondary);
    const coordinates = [
      "session_id",
      "start_user_message_id",
      "end_user_message_id",
      "source_boundary_version",
      "start_source_message_id",
      "end_source_message_id",
    ];
    const localMetadata = await http(
      current,
      `/v1/segments/${pluginSegment.id}?source_id=${legacy}`,
    );
    for (const key of coordinates) remoteRequest[key] = localMetadata[key];
    remoteRequest.messages = history("plugin-history", true)
      .slice(0, 2)
      .map((m) => ({ role: m.info.role, text: m.parts[0].text }));
    const remoteJob = await http(current, "/v1/segments", remoteRequest, 202);
    await jobState(remoteJob, "succeeded");
    const remoteMetadata = await http(
      current,
      `/v1/segments/${remoteJob.segment_id}?source_id=${secondary}`,
    );
    check(
      "identical boundary coordinates coexist across sources with distinct UUIDs",
      coordinates.every((key) => remoteMetadata[key] === localMetadata[key]) &&
        remoteMetadata.source_id === secondary &&
        localMetadata.source_id === legacy &&
        remoteJob.segment_id !== pluginSegment.id,
    );
    const remoteRead = await rpc(newPlugin, "read", {
      sourceId: secondary,
      segmentId: remoteJob.segment_id,
    });
    check(
      "paired remote read uses remote history not local SDK",
      String(remoteRead.result).includes("REMOTE archive request") &&
        !String(remoteRead.result).includes("LOCAL archive request"),
    );
    remoteUnavailable = true;
    const failuresBefore = remoteFailures;
    let unavailableRead;
    try {
      unavailableRead = await rpc(newPlugin, "read", {
        sourceId: secondary,
        segmentId: remoteJob.segment_id,
      });
    } finally {
      remoteUnavailable = false;
    }
    const unavailableText = String(unavailableRead.result);
    check(
      "unavailable remote history reports explicit error without local fallback",
      remoteFailures > failuresBefore &&
        unavailableText.includes("memory_read_segment failed") &&
        unavailableText.includes("history source unavailable") &&
        !unavailableText.includes("LOCAL archive request") &&
        !unavailableText.includes("REMOTE archive request"),
    );
    const recoveredRead = await rpc(newPlugin, "read", {
      sourceId: secondary,
      segmentId: remoteJob.segment_id,
    });
    check(
      "remote history reads recover after availability reset",
      String(recoveredRead.result).includes("REMOTE archive request") &&
        !String(recoveredRead.result).includes("LOCAL archive request"),
    );
    const search = await http(current, "/v1/search", {
      query: "Fixture service",
    });
    const refs = search.claims.flatMap((c) => c.segments);
    check(
      "search returns paired source references",
      refs.some(
        (r) =>
          r.source_id === secondary && r.segment_id === remoteJob.segment_id,
      ) && refs.some((r) => r.source_id === legacy),
    );
  });

  await phase(
    "interrupted bounded backfill and idempotent enforcement",
    async () => {
      await operate(["enforce", "--old-writers-stopped"], false);
      await poll(
        "worker quiescent",
        async () =>
          (
            await db.query(
              "SELECT count(*)::int AS n FROM extraction_jobs WHERE status IN ('running','pending')",
            )
          ).rows[0].n === 0,
      );
      const before = await snapshot();
      const candidates = (
        await db.query(
          "SELECT segment_id FROM (SELECT id AS segment_id FROM segments WHERE source_id IS NULL UNION SELECT segment_id FROM extraction_jobs WHERE source_id IS NULL UNION SELECT segment_id FROM segment_targets WHERE source_id IS NULL) p ORDER BY segment_id",
        )
      ).rows;
      check("backfill has multiple unowned groups", candidates.length >= 3);
      const blocker = await connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [candidates[1].segment_id],
      );
      const backfillHoldStart = performance.now();
      const backfill = operator([
        "backfill",
        "--legacy-source",
        legacy,
        "--batch-size",
        "1",
      ]);
      await poll(
        "first bounded backfill group committed",
        async () =>
          (
            await db.query(
              "SELECT count(*)::int AS n FROM extraction_jobs WHERE segment_id = $1 AND source_id = $2",
              [candidates[0].segment_id, legacy],
            )
          ).rows[0].n > 0,
      );
      const blockedBackfill = await poll(
        "backfill actually blocked on advisory lock",
        async () =>
          (
            await db.query(
              "SELECT pid FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event = 'advisory' AND query LIKE '%hashtextextended%'",
            )
          ).rows[0],
        3000,
      );
      const concurrentStart = performance.now();
      current.autoRelease = false;
      const concurrentJob = await submit(
        current,
        "hold-extract-during-partial-backfill",
        secondary,
      );
      await event(current, "extract", "hold-extract-during-partial-backfill");
      const concurrentGateStart = performance.now();
      const admittedOwnership = (
        await db.query(
          "SELECT j.source_id AS job_source, t.source_id AS target_source FROM extraction_jobs j JOIN segment_targets t ON t.job_id = j.id WHERE j.id = $1",
          [concurrentJob.id],
        )
      ).rows[0];
      check(
        "concurrent new job and target owned immediately before completion",
        admittedOwnership?.job_source === secondary &&
          admittedOwnership.target_source === secondary,
        admittedOwnership,
      );
      current.autoRelease = true;
      current.proc.send({
        cmd: "release",
        sessionId: "hold-extract-during-partial-backfill",
      });
      report.timings.controlledConcurrentOwnershipInspectionMs = Math.round(
        performance.now() - concurrentGateStart,
      );
      await jobState(concurrentJob, "succeeded");
      report.timings.concurrentBackfillWriteMs = Math.round(
        performance.now() - concurrentStart,
      );
      const concurrentSegment = await http(
        current,
        `/v1/segments/${concurrentJob.segment_id}?source_id=${secondary}`,
      );
      const ownership = (
        await db.query(
          "SELECT s.source_id AS segment_source, j.source_id AS job_source FROM segments s JOIN extraction_jobs j ON j.segment_id = s.id WHERE j.id = $1",
          [concurrentJob.id],
        )
      ).rows[0];
      check(
        "write commits with immediate ownership during blocked partial backfill",
        concurrentSegment.source_id === secondary &&
          concurrentSegment.summary ===
            "Summary hold-extract-during-partial-backfill" &&
          ownership?.segment_source === secondary &&
          ownership.job_source === secondary,
        ownership,
      );
      await http(
        current,
        `/v1/segments/${pluginSegment.id}?source_id=${legacy}`,
      );
      await projection(
        newPlugin,
        "while backfill blocked with concurrent write",
      );
      check(
        "backfill remains blocked throughout concurrent worker write and projection",
        !backfill.exited &&
          (
            await db.query(
              "SELECT wait_event FROM pg_stat_activity WHERE pid = $1",
              [blockedBackfill.pid],
            )
          ).rows[0]?.wait_event === "advisory",
      );
      await stop(backfill, "SIGKILL");
      await blocker.query("ROLLBACK");
      report.timings.controlledBackfillLockHoldMs = Math.round(
        performance.now() - backfillHoldStart,
      );
      check(
        "bounded backfill interrupted after partial commit",
        backfill.signal === "SIGKILL" &&
          (
            await db.query(
              "SELECT count(*)::int AS n FROM extraction_jobs WHERE source_id IS NULL",
            )
          ).rows[0].n > 0,
      );
      check(
        "partial backfill preserves original rows despite concurrent additions",
        digest(before) === digest(await snapshot(db, before)),
      );
      await http(
        current,
        `/v1/segments/${pluginSegment.id}?source_id=${legacy}`,
      );
      await projection(newPlugin, "partial backfill");
      await operate([
        "backfill",
        "--legacy-source",
        legacy,
        "--batch-size",
        "1",
      ]);
      check(
        "resumed backfill preserves all original non-owner columns",
        digest(before) === digest(await snapshot(db, before)),
      );
      report.preservation = {
        before: digest(before),
        after: digest(await snapshot(db, before)),
        excludedColumns: ["source_id"],
        tables: Object.keys(before),
        scope:
          "original rows selected by stable primary key; additions permitted",
        concurrentSegmentId: concurrentJob.segment_id,
      };
      await poll(
        "worker quiescent before enforcement snapshot",
        async () =>
          (
            await db.query(
              "SELECT count(*)::int AS n FROM extraction_jobs WHERE status IN ('running','pending')",
            )
          ).rows[0].n === 0,
      );
      const beforeEnforce = await snapshot(db, undefined, true);
      await operate(["enforce", "--old-writers-stopped"]);
      await operate(["enforce", "--old-writers-stopped"]);
      const afterEnforce = await snapshot(db, undefined, true);
      check(
        "repeated enforcement preserves all live rows including ownership entities and aliases",
        digest(beforeEnforce) === digest(afterEnforce),
      );
      report.enforcementPreservation = {
        before: digest(beforeEnforce),
        after: digest(afterEnforce),
        excludedColumns: [],
        tables: Object.keys(beforeEnforce),
        scope:
          "all rows; quiescent immediately before and after repeated enforce",
      };
      await write(current, "post-enforce-write");
      await projection(newPlugin, "after enforcement");
      check("new write succeeds after repeated enforce", true);
    },
  );

  await phase("isolated snapshot restore to old release", async () => {
    await rpc(newPlugin, "dispose");
    await exited(newPlugin);
    await stop(current);
    await db.query("CREATE DATABASE rehearsal_restore");
    const restoreUrl = new URL(databaseUrl);
    restoreUrl.pathname = "/rehearsal_restore";
    const restore = await exited(
      child("pg-restore", "pg_restore", [
        "--exit-on-error",
        "--no-owner",
        "--dbname",
        restoreUrl.href,
        "/state/baseline.dump",
      ]),
    );
    check(
      "pg_restore into separate database succeeds",
      restore.code === 0,
      restore.output,
    );
    const restored = await connect(restoreUrl.href);
    check(
      "restored snapshot matches baseline logical data",
      digest(baseline) === digest(await snapshot(restored)),
    );
    const restoredOld = await ready(backend("old", restoreUrl.href));
    await http(restoredOld, `/v1/segments/${baselineJob.segment_id}`);
    await cp("/state/plugin-snapshot", "/state/restore-plugin", {
      recursive: true,
    });
    const restoredPlugin = await plugin(
      "old",
      restoredOld,
      "/state/restore-plugin",
    );
    await projection(restoredPlugin, "restored old");
    await pluginTools(restoredPlugin, pluginSegment.id, "restored old");
    check(
      "restore excludes writes after snapshot (RPO)",
      (
        await restored.query(
          "SELECT count(*)::int AS n FROM segments WHERE session_id IN ('post-expand-write','post-enforce-write')",
        )
      ).rows[0].n === 0,
    );
    await write(restoredOld, "restored-fresh-write", legacy, restored);
    check("old fresh write succeeds after restore", true);
    await rpc(restoredPlugin, "dispose");
    await exited(restoredPlugin);
    await stop(restoredOld);
  });
  await phase(
    "cutover-boundary restore preserves all pre-cutover accepted jobs",
    async () => {
      await db.query("CREATE DATABASE rehearsal_cutover_restore");
      const restoreUrl = new URL(databaseUrl);
      restoreUrl.pathname = "/rehearsal_cutover_restore";
      const restore = await exited(
        child("pg-restore-cutover", "pg_restore", [
          "--exit-on-error",
          "--no-owner",
          "--dbname",
          restoreUrl.href,
          "/state/cutover.dump",
        ]),
      );
      check(
        "cutover-boundary pg_restore into third database succeeds",
        restore.code === 0,
        restore.output,
      );
      const restored = await connect(restoreUrl.href);
      const restoredSnapshot = await snapshot(restored, undefined, true);
      check(
        "cutover restore exactly preserves every pre-cutover row and source value before recovery",
        digest(cutoverSnapshot) === digest(restoredSnapshot),
      );
      const active = restoredSnapshot.extraction_jobs.find(
        (j) => j.session_id === "hold-extract-recovery",
      );
      const staged = restoredSnapshot.extraction_jobs.find(
        (j) => j.session_id === "hold-resolve-recovery",
      );
      const pending = restoredSnapshot.extraction_jobs.find(
        (j) => j.session_id === "pending-recovery",
      );
      check(
        "cutover backup includes accepted active staged and pending jobs",
        active?.status === "running" &&
          staged?.status === "running" &&
          pending?.status === "pending" &&
          restoredSnapshot.segment_targets.some(
            (t) =>
              String(t.job_id) === String(staged.id) &&
              t.extraction_result != null,
          ),
      );
      const restoredOld = backend("old", restoreUrl.href);
      restoredOld.autoRelease = true;
      await ready(restoredOld);
      for (const job of cutoverSnapshot.extraction_jobs) {
        const status = ["pending", "running"].includes(job.status)
          ? "succeeded"
          : job.status;
        await jobState(job, status, restored);
        if (status === "succeeded")
          await http(restoredOld, `/v1/segments/${job.segment_id}`);
      }
      const extraction = await event(
        restoredOld,
        "extract",
        "hold-extract-recovery",
      );
      check(
        "restored old stack replaces active lease and reuses staged extraction",
        extraction.leaseId !== active.lease_id &&
          Boolean(extraction.leaseId) &&
          restoredOld.events.some(
            (e) =>
              e.event === "resolve" && e.sessionId === "hold-resolve-recovery",
          ) &&
          !restoredOld.events.some(
            (e) =>
              e.event === "extract" && e.sessionId === "hold-resolve-recovery",
          ),
      );
      check(
        "cutover restore recovery preserves original immutable baseline rows",
        digest(baseline) === digest(await snapshot(restored, baseline)),
      );
      check(
        "cutover backup does not claim protection for post-cutover new writes",
        (
          await restored.query(
            "SELECT count(*)::int AS n FROM extraction_jobs WHERE session_id IN ('hold-extract-during-partial-backfill', 'post-enforce-write')",
          )
        ).rows[0].n === 0,
      );
      report.cutoverRestore = {
        beforeRecoveryDigest: digest(restoredSnapshot),
        expectedDigest: digest(cutoverSnapshot),
        verifiedAcceptedJobCount: cutoverSnapshot.extraction_jobs.length,
        recovery:
          "all pending/running accepted jobs succeeded; terminal states retained; staged extraction reused",
        postCutoverWritesProtected: false,
      };
      await stop(restoredOld);
    },
  );
  report.outcome = "passed";
} catch (error) {
  report.error = String(error?.stack ?? error).replaceAll(
    databaseUrl ?? "<unset>",
    "<fixture-database>",
  );
} finally {
  clearTimeout(watchdog);
  for (const item of children) if (!item.exited) item.proc.kill("SIGKILL");
  await Promise.all(
    children
      .filter((item) => !item.exited)
      .map((item) =>
        Promise.race([
          new Promise((resolve) => item.proc.once("exit", resolve)),
          sleep(1000),
        ]),
      ),
  );
  await Promise.all(clients.map((client) => client.end().catch(() => {})));
  if (reader) {
    reader.closeAllConnections();
    await new Promise((resolve) => reader.close(resolve));
  }
  report.finishedAt = new Date().toISOString();
  report.durationMs = Math.round(performance.now() - started);
  report.children = children.map((item) => ({
    label: item.label,
    code: item.code,
    signal: item.signal,
    diagnostics: item.output.replaceAll(
      databaseUrl ?? "<unset>",
      "<fixture-database>",
    ),
  }));
  await mkdir("/state/logs", { recursive: true });
  for (const item of report.children)
    await writeFile(`/state/logs/${item.label}.log`, item.diagnostics);
  await writeFile("/state/report.json", `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.outcome === "passed" ? 0 : 1;
}
