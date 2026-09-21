import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const label = `cp008-${randomUUID()}`;
const image = `reflection-cp008:${label}`;
const source = `${label}-source`;
const target = `${label}-target`;
const backup = `${label}-backup`;
const reports = `${label}-reports`;
const sourceNetwork = `${label}-source-net`;
const restoreNetwork = `${label}-restore-net`;
const composeProject = `${label}-compose`;
const composeVolumes = ["backup", "reports", "restore"].map(
  (name) => `${composeProject}-${name}`,
);
const artifactSha256 = createHash("sha256")
  .update(await readFile(new URL("./backup.mjs", import.meta.url)))
  .digest("hex");
const hardening = [
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--tmpfs",
  "/tmp:rw,nosuid,nodev,mode=1777",
];
const password = "test-only-private-password";
const composeEnv = {
  ...process.env,
  CP008_OPERATOR_IMAGE: image,
  CP008_SOURCE_NETWORK: sourceNetwork,
  CP008_BACKUP_VOLUME: composeVolumes[0],
  CP008_REPORT_VOLUME: composeVolumes[1],
  CP008_RESTORE_VOLUME: composeVolumes[2],
  CP008_RESTORE_PASSWORD: password,
  SOURCE_DATABASE_URL: `postgresql://reflection:${password}@db/reflection`,
  EXPECTED_SOURCE_HOST: "db",
  EXPECTED_SOURCE_DATABASE: "reflection",
  EXPECTED_SOURCE_USER: "reflection",
  EXPECTED_ARTIFACT_SHA256: artifactSha256,
  BACKUP_RUN_ID: "compose-fixture",
  JOB_TIMEOUT_SECONDS: "60",
};
const composeArgs = [
  "compose",
  "--project-name",
  composeProject,
  "--file",
  "scripts/cp008/compose.yml",
];
const sourceEnv = [
  "-e",
  `SOURCE_DATABASE_URL=postgresql://reflection:${password}@${source}/reflection`,
  "-e",
  `EXPECTED_SOURCE_HOST=${source}`,
];
const targetEnv = [
  "-e",
  `TARGET_DATABASE_URL=postgresql://reflection_restore_test:${password}@${target}/reflection_restore_test`,
  "-e",
  `EXPECTED_TARGET_HOST=${target}`,
];
let passed = 0;
function check(name) {
  passed++;
  console.log(`PASS ${name}`);
}

function command(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.stdout.on("data", (part) => {
      output += part;
    });
    child.stderr.on("data", (part) => {
      output += part;
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}
async function docker(...args) {
  const result = await command("docker", args);
  assert.equal(result.code, 0, result.output);
  return result.output;
}
async function compose(...args) {
  const result = await command("docker", [...composeArgs, ...args], {
    env: composeEnv,
  });
  // Config includes fixture credentials: never include its output in assertions/logs.
  assert.equal(result.code, 0, `Compose ${args[0]} failed`);
  if (!args.includes("config")) {
    assert(!result.output.includes(password), "Compose credential leaked");
    assert(
      !result.output.includes("fixture-secret"),
      "Compose raw data leaked",
    );
  }
  return result.output;
}
async function psql(container, sql, expect = 0) {
  const user = container === source ? "reflection" : "reflection_restore_test";
  const result = await command(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      user,
      "-d",
      user,
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      "-",
    ],
    { input: sql },
  );
  assert.equal(result.code, expect, result.output);
  return result.output.trim();
}
async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("timed out waiting for fixture condition");
}
async function volume(code) {
  return docker(
    "run",
    "--rm",
    "--network",
    "none",
    ...hardening,
    "--mount",
    `type=volume,src=${backup},dst=/backup`,
    "--mount",
    `type=volume,src=${reports},dst=/reports`,
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "-e",
    `import fs from 'node:fs'; import assert from 'node:assert/strict'; import {createHash} from 'node:crypto'; function stable(v) { return Array.isArray(v) ? '['+v.map(stable).join(',')+']' : v && typeof v==='object' ? '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}' : JSON.stringify(v); } function digest(v) { const b=Buffer.from(stable(v)); return createHash('sha256').update(b.length+':').update(b).digest('hex'); } ${code}`,
  );
}
async function operator(mode, id = "positive", extra = [], expect = 0) {
  const result = await command("docker", [
    "run",
    "--rm",
    "--network",
    mode === "backup"
      ? sourceNetwork
      : mode === "verify"
        ? restoreNetwork
        : "none",
    ...hardening,
    "--mount",
    `type=volume,src=${backup},dst=/backup${mode === "backup" ? "" : ",readonly"}`,
    "--mount",
    `type=volume,src=${reports},dst=/reports${mode === "report-check" ? ",readonly" : ""}`,
    "-e",
    `BACKUP_RUN_ID=${id}`,
    "-e",
    "JOB_TIMEOUT_SECONDS=60",
    "-e",
    `EXPECTED_ARTIFACT_SHA256=${artifactSha256}`,
    ...(mode === "backup" ? sourceEnv : mode === "verify" ? targetEnv : []),
    ...extra,
    image,
    mode,
  ]);
  assert.equal(result.code, expect, result.output);
  assert(!result.output.includes(password), "credential leaked");
  assert(!result.output.includes("fixture-secret"), "raw data leaked");
  return result.output;
}
async function clone(id, mutation = "") {
  await volume(
    `fs.cpSync('/backup/positive','/backup/${id}',{recursive:true}); const p='/backup/${id}/manifest.json'; const m=JSON.parse(fs.readFileSync(p)); m.runId='${id}'; ${mutation} fs.writeFileSync(p,JSON.stringify(m));`,
  );
}
async function resetTarget() {
  await psql(
    target,
    "DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP EXTENSION IF EXISTS vector; DROP EXTENSION IF EXISTS pg_trgm; DROP EXTENSION IF EXISTS pgcrypto;",
  );
}
async function unpublished(id) {
  await volume(
    `assert(!fs.existsSync('/backup/${id}')); assert(!fs.existsSync('/reports/${id}.verified.json'));`,
  );
}

try {
  await docker("build", "-f", "scripts/cp008/Dockerfile", "-t", image, ".");
  await docker("network", "create", "--internal", sourceNetwork);
  await docker("network", "create", "--internal", restoreNetwork);
  await docker("volume", "create", backup);
  await docker("volume", "create", reports);
  for (const [container, user] of [
    [source, "reflection"],
    [target, "reflection_restore_test"],
  ]) {
    await docker(
      "run",
      "-d",
      "--name",
      container,
      "--network",
      container === source ? sourceNetwork : restoreNetwork,
      "--network-alias",
      container === source ? "db" : "restore-db",
      "-e",
      `POSTGRES_USER=${user}`,
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-e",
      `POSTGRES_DB=${user}`,
      "pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f",
    );
    await eventually(
      async () =>
        (
          await command("docker", [
            "exec",
            container,
            "pg_isready",
            "-U",
            user,
            "-d",
            user,
          ])
        ).code === 0,
    );
  }
  await psql(
    source,
    "CREATE TABLE reflection_schema_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now());",
  );
  for (const name of [
    "001_init.sql",
    "002_audit_hardening.sql",
    "003_claim_confidence_and_payload_cleanup.sql",
    "004_projection_safety.sql",
    "005_mutable_source_snapshots.sql",
    "006_canonical_source_spans.sql",
    "007_superseded_job_status.sql",
    "008_extraction_validation.sql",
  ]) {
    const sql = await readFile(`migrations/${name}`, "utf8");
    await psql(source, sql);
    await psql(
      source,
      `INSERT INTO reflection_schema_migrations(name, checksum) VALUES ('${name}', '${createHash("sha256").update(sql).digest("hex")}');`,
    );
  }
  await psql(
    source,
    `
    CREATE EXTENSION pgcrypto;
    INSERT INTO segments(id,session_id,start_user_message_id,end_user_message_id,summary) VALUES ('00000000-0000-0000-0000-000000000001','fixture-secret','a','b','fixture-secret summary');
    INSERT INTO entities(id,canonical_name,normalized_name,description,embedding) VALUES ('00000000-0000-0000-0000-000000000002','fixture-secret','fixture-secret','fixture-secret',array_fill(0.25::real,ARRAY[1024])::vector);
    INSERT INTO entity_aliases VALUES ('00000000-0000-0000-0000-000000000002','fixture-secret alias','fixture-secret alias');
    INSERT INTO claims(id,segment_id,subject_text,subject_entity_id,predicate,confidence,object_value,equivalence_key,embedding) VALUES ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','fixture-secret','00000000-0000-0000-0000-000000000002','fixture-secret',0.75,'fixture-secret',repeat('a',64),array_fill(0.5::real,ARRAY[1024])::vector);
    INSERT INTO extraction_jobs(segment_id,session_id,start_user_message_id,end_user_message_id,payload,status,lease_id) SELECT gen_random_uuid(),'fixture-secret-'||s,'a','b','{"raw":"fixture-secret","nested":[1,true,null]}'::jsonb,s,CASE WHEN s='running' THEN gen_random_uuid() END FROM unnest(ARRAY['pending','running','failed','succeeded','superseded']) s;
    INSERT INTO segment_targets(segment_id,job_id,end_user_message_id,projection_version,payload,source_fingerprint,extraction_result,summary_commit_fingerprint,extraction_validation_version,extraction_validation_fingerprint) SELECT segment_id,id,'b',1,payload,repeat('b',64),'{"fixture-secret":"staged"}'::jsonb,repeat('c',64),1,reflection_extraction_validation_fingerprint('{"fixture-secret":"staged"}'::jsonb,1,repeat('b',64)::char(64)) FROM extraction_jobs WHERE status='running';
  `,
  );
  await operator(
    "backup",
    "wrong-source",
    ["-e", "EXPECTED_SOURCE_HOST=wrong"],
    1,
  );
  check("wrong source refused");
  for (const expected of ["", "invalid", "0".repeat(64)]) {
    await operator(
      "backup",
      "wrong-artifact",
      ["-e", `EXPECTED_ARTIFACT_SHA256=${expected}`],
      1,
    );
    await unpublished("wrong-artifact");
  }
  check("missing, malformed and stale script hashes refused at startup");
  await operator("backup");
  await volume(
    `const text=fs.readFileSync('/backup/positive/manifest.json','utf8'); assert(!text.includes('fixture-secret')); assert(!text.includes('${password}')); const m=JSON.parse(text); assert(m.evidence.tables.every(t=>t.count>0)); assert.equal(m.evidence.tables.find(t=>t.name==='reflection_schema_migrations').count,8); for(const file of ['archive.dump','manifest.json']) assert.equal(fs.statSync('/backup/positive/'+file).mode&0o777,0o600);`,
  );
  check("populated backup, private files and hashed-only metadata");
  await volume(
    `assert.equal(JSON.parse(fs.readFileSync('/backup/positive/manifest.json')).artifactSha256,'${artifactSha256}');`,
  );
  await clone("wrong-manifest-hash", "m.artifactSha256='0'.repeat(64);");
  await operator("verify", "wrong-manifest-hash", [], 1);
  check("manifest bound to reviewed script hash");
  await operator("backup", "positive", [], 1);
  await volume("fs.mkdirSync('/backup/empty-final');");
  await operator("backup", "empty-final", [], 1);
  await volume("assert.deepEqual(fs.readdirSync('/backup/empty-final'),[]);");
  check("duplicate and preexisting empty final refused");
  await clone("existing-report");
  await volume(
    "fs.writeFileSync('/reports/existing-report.verified.json','do-not-overwrite');",
  );
  await operator("verify", "existing-report", [], 1);
  await volume(
    "assert.equal(fs.readFileSync('/reports/existing-report.verified.json','utf8'),'do-not-overwrite');",
  );
  check("preexisting report is never overwritten");
  await clone("wrong-target");
  await operator(
    "verify",
    "wrong-target",
    ["-e", "EXPECTED_TARGET_HOST=wrong"],
    1,
  );
  check("wrong target refused");
  await operator("verify");
  await operator("report-check");
  await volume(
    `const p='/reports/positive.verified.json'; const r=JSON.parse(fs.readFileSync(p)); assert.equal(r.artifactSha256,'${artifactSha256}'); r.artifactSha256='0'.repeat(64); fs.writeFileSync(p,JSON.stringify(r));`,
  );
  await operator("report-check", "positive", [], 1);
  await volume(
    `const p='/reports/positive.verified.json'; const r=JSON.parse(fs.readFileSync(p)); r.artifactSha256='${artifactSha256}'; fs.writeFileSync(p,JSON.stringify(r));`,
  );
  check("report bound to reviewed script hash");
  assert.equal(
    await psql(
      target,
      "SELECT count(*) FROM pg_extension WHERE extname IN ('vector','pg_trgm','pgcrypto');",
    ),
    "3",
  );
  check(
    "fresh restore includes extensions, exact data/schema, sequences and report",
  );
  await clone("nonempty");
  await operator("verify", "nonempty", [], 1);
  check("nonempty target refused");
  await resetTarget();
  for (const [id, sql] of [
    ["target-type", "CREATE TYPE public.unexpected AS ENUM ('x');"],
    ["target-view", "CREATE VIEW public.unexpected AS SELECT 1;"],
    ["target-extension", "CREATE EXTENSION vector;"],
  ]) {
    await clone(id);
    await psql(target, sql);
    await operator("verify", id, [], 1);
    await resetTarget();
  }
  check("target types, views and extensions refused");
  await volume(
    "const p='/reports/positive.verified.json'; const m=JSON.parse(fs.readFileSync(p)); m.assertions=[]; fs.writeFileSync(p,JSON.stringify(m));",
  );
  await operator("report-check", "positive", [], 1);
  check("empty report assertions refused");
  for (const [id, mutation] of [
    ["corrupt", "fs.appendFileSync('/backup/corrupt/archive.dump','broken');"],
    ["data-mismatch", "m.evidence.tables[0].digest='0'.repeat(64);"],
    [
      "schema-mismatch",
      "m.evidence.schema.columns[0].digest='0'.repeat(64); m.evidence.schemaDigest=digest(m.evidence.schema);",
    ],
    [
      "sequence-injection",
      "m.evidence.sequences[0].name='extraction_jobs_id_seq; DROP TABLE entities; --';",
    ],
    ["unkeyed-manifest", "m.evidence.tables=[];"],
  ]) {
    await clone(id, mutation);
    await operator("verify", id, [], 1);
    if (["data-mismatch", "schema-mismatch", "sequence-injection"].includes(id))
      assert.equal(await psql(target, "SELECT count(*) FROM entities;"), "1");
    await volume(`assert(!fs.existsSync('/reports/${id}.verified.json'));`);
    await resetTarget();
  }
  check("corrupt archive, data/schema mismatch and sequence injection refused");
  await psql(
    source,
    "ALTER TABLE entity_aliases DROP CONSTRAINT entity_aliases_pkey;",
  );
  await operator("backup", "unkeyed", [], 1);
  await unpublished("unkeyed");
  await psql(
    source,
    "ALTER TABLE entity_aliases ADD PRIMARY KEY(entity_id,normalized_alias);",
  );
  for (const [id, setup, cleanup] of [
    [
      "source-view",
      "CREATE VIEW unexpected AS SELECT 1;",
      "DROP VIEW unexpected;",
    ],
    [
      "source-rls",
      "ALTER TABLE entities ENABLE ROW LEVEL SECURITY;",
      "ALTER TABLE entities DISABLE ROW LEVEL SECURITY;",
    ],
  ]) {
    await psql(source, setup);
    await operator("backup", id, [], 1);
    await unpublished(id);
    await psql(source, cleanup);
  }
  check("unkeyed tables and unsupported source views/RLS refused");

  // Hold a conflicting lock only in this disposable source, never in the operator.
  async function holdLock() {
    const pending = psql(
      source,
      "BEGIN; LOCK TABLE entities IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(20); ROLLBACK;",
    ).catch(() => {});
    await eventually(
      async () =>
        (await psql(
          source,
          "SELECT count(*) FROM pg_locks WHERE relation='entities'::regclass AND mode='AccessExclusiveLock' AND granted;",
        )) === "1",
    );
    return { pending };
  }
  async function releaseLock(lock) {
    await psql(
      source,
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND query LIKE '%pg_sleep(20)%';",
    );
    await lock.pending;
  }
  let lock = await holdLock();
  const start = Date.now();
  await operator("backup", "deadline", ["-e", "JOB_TIMEOUT_SECONDS=5"], 1);
  assert(Date.now() - start < 9000);
  await unpublished("deadline");
  await releaseLock(lock);
  check("whole-operation 5s deadline under held table lock");

  lock = await holdLock();
  const interrupted = operator(
    "backup",
    "interrupt",
    ["--name", `${label}-interrupt`],
    1,
  );
  await eventually(
    async () =>
      (await psql(
        source,
        "SELECT count(*) FROM pg_stat_activity WHERE application_name='pg_dump';",
      )) !== "0",
  );
  await docker("kill", "--signal=TERM", `${label}-interrupt`);
  await interrupted;
  await unpublished("interrupt");
  await volume("assert(fs.existsSync('/backup/.interrupt.partial'));");
  await releaseLock(lock);
  check("SIGTERM stops dump, leaves partial only, exits 1");

  // The dump has imported its snapshot before waiting for entities' lock.
  lock = await holdLock();
  const concurrent = operator("backup", "concurrent");
  await eventually(
    async () =>
      (await psql(
        source,
        "SELECT count(*) FROM pg_stat_activity WHERE application_name='pg_dump' AND wait_event_type='Lock';",
      )) !== "0",
  );
  await operator("backup", "concurrent", [], 1);
  await psql(
    source,
    "UPDATE segments SET summary='fixture-secret newer'; UPDATE extraction_jobs SET attempts=attempts+1; UPDATE reflection_schema_migrations SET checksum='fixture-secret newer';",
  );
  await releaseLock(lock);
  await concurrent;
  await operator("verify", "concurrent");
  await operator("report-check", "concurrent");
  assert.equal(
    await psql(target, "SELECT summary FROM segments;"),
    "fixture-secret summary",
  );
  check("concurrent writes excluded by shared dump/evidence snapshot");
  check("concurrent cooperative publisher refused by exclusive run lock");

  const script = await readFile("scripts/cp008/backup.mjs", "utf8");
  assert(
    !/query\(client,\s*["'`](?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/.test(
      script,
    ),
  );
  await psql(source, "BEGIN READ ONLY; CREATE TABLE prohibited(id int);", 3);
  check("source SQL read-only static check and PostgreSQL DDL denial");
  const dormant = JSON.parse(await compose("config", "--format", "json"));
  assert.equal(Object.keys(dormant.services ?? {}).length, 0);
  const config = JSON.parse(
    await compose("--profile", "cp008", "config", "--format", "json"),
  );
  assert.deepEqual(Object.keys(config.services).sort(), [
    "backup",
    "report-check",
    "restore-db",
    "verify",
  ]);
  assert.equal(config.networks.source.external, true);
  assert.equal(config.networks.source.name, sourceNetwork);
  assert.equal(config.networks.restore.internal, true);
  for (const [service, networks] of [
    ["backup", ["source"]],
    ["verify", ["restore"]],
    ["restore-db", ["restore"]],
    ["report-check", []],
  ]) {
    const s = config.services[service];
    assert.deepEqual(Object.keys(s.networks ?? {}), networks);
    assert(!s.ports && !s.labels && !s.env_file && !s.privileged);
    assert.equal(s.read_only, true);
    assert.equal(s.restart, "no");
    assert.equal(Number(s.mem_limit), 2 * 1024 ** 3);
    assert.equal(Number(s.cpus), 2);
    assert(s.volumes.every((v) => v.type === "volume"));
    assert(!("DATABASE_URL" in s.environment));
    assert.equal("SOURCE_DATABASE_URL" in s.environment, service === "backup");
    assert.equal("TARGET_DATABASE_URL" in s.environment, service === "verify");
    if (service !== "restore-db") {
      assert.deepEqual(s.cap_drop, ["ALL"]);
      assert.deepEqual(s.security_opt, ["no-new-privileges:true"]);
      assert.equal(s.environment.EXPECTED_ARTIFACT_SHA256, artifactSha256);
    }
  }
  assert.equal(config.services["report-check"].network_mode, "none");
  assert.deepEqual(
    config.services.backup.volumes.map((v) => [
      v.source,
      v.target,
      !!v.read_only,
    ]),
    [["backup", "/backup", false]],
  );
  assert.deepEqual(
    config.services.verify.volumes.map((v) => [
      v.source,
      v.target,
      !!v.read_only,
    ]),
    [
      ["backup", "/backup", true],
      ["reports", "/reports", false],
    ],
  );
  assert(config.services["report-check"].volumes.every((v) => v.read_only));
  assert.equal(
    config.services.verify.depends_on["restore-db"].condition,
    "service_healthy",
  );
  assert.equal(
    config.services.backup.build.dockerfile,
    "scripts/cp008/Dockerfile",
  );
  assert.deepEqual(
    Object.values(config.volumes)
      .map((v) => v.name)
      .sort(),
    [...composeVolumes].sort(),
  );
  check(
    "Compose JSON config networks, credential boundaries, mounts and hardening",
  );

  await compose("build", "backup");
  const composeBackup = await compose(
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "backup",
  );
  assert(composeBackup.includes('"code":"CP008_BACKUP_COMPLETED"'));
  assert(composeBackup.includes(artifactSha256));
  assert.equal((await compose("ps", "--all", "--quiet")).trim(), "");
  const composeVerify = await compose("run", "--rm", "-T", "verify");
  assert(composeVerify.includes('"code":"CP008_VERIFY_COMPLETED"'));
  assert(
    (await compose("run", "--rm", "--no-deps", "-T", "report-check")).includes(
      '"code":"CP008_REPORT_CHECK_COMPLETED"',
    ),
  );
  const restoreId = (await compose("ps", "--quiet", "restore-db")).trim();
  const [restored] = JSON.parse(await docker("inspect", restoreId));
  assert.deepEqual(Object.keys(restored.NetworkSettings.Networks), [
    `${composeProject}_restore`,
  ]);
  assert.equal(restored.State.Health.Status, "healthy");
  assert.equal(
    restored.Mounts.find((v) => v.Destination === "/var/lib/postgresql/data")
      .Name,
    composeVolumes[2],
  );
  const isolationProbe = `const dns=await import('node:dns/promises'); await dns.lookup(process.argv[1]); try { await dns.lookup(process.argv[2]); process.exit(1); } catch(e) { if(!['ENOTFOUND','EAI_AGAIN'].includes(e.code)) throw e; }`;
  for (const [service, reachable, isolated] of [
    ["backup", "db", "restore-db"],
    ["verify", "restore-db", "db"],
  ]) {
    await compose(
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--entrypoint",
      "node",
      service,
      "--input-type=module",
      "-e",
      isolationProbe,
      reachable,
      isolated,
    );
  }
  check(
    "Compose fresh volumes, healthy dependency, backup/verify/proof and runtime network isolation",
  );
  console.log(`${passed} cp008 Docker checks passed`);
} finally {
  // Only this randomized disposable project may delete volumes in the test harness.
  await command(
    "docker",
    [...composeArgs, "--profile", "cp008", "down", "--volumes"],
    {
      env: composeEnv,
    },
  );
  await command("docker", [
    "rm",
    "-f",
    "-v",
    source,
    target,
    `${label}-interrupt`,
  ]);
  await command("docker", ["network", "rm", sourceNetwork, restoreNetwork]);
  await command("docker", ["volume", "rm", backup, reports]);
  await command("docker", ["image", "rm", "-f", image]);
}
