import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { snapshot as copySnapshot } from "./snapshot.mjs";

const root = process.cwd();
const token = `${process.pid}-${randomBytes(5).toString("hex")}`;
const temporary = mkdtempSync(join(tmpdir(), "reflection-dual-runtime-"));
const context = join(temporary, "context");
const image = `reflection-dual-runtime:${token}`;
const postgresImage =
  "pgvector/pgvector:pg17@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f";
const network = `reflection-dual-runtime-net-${token}`;
const database = `reflection-dual-runtime-pg-${token}`;
const volume = `reflection-dual-runtime-data-${token}`;
const runner = `reflection-dual-runtime-run-${token}`;
const reportPath = join(temporary, "report.json");
const buildLog = join(temporary, "build.log");
const runtimeLog = join(temporary, "runtime.log");
const report = {
  outcome: "failed",
  token,
  temporary,
  buildLog,
  runtimeLog,
  provenance: {},
  images: {},
  timings: {},
  runtime: null,
  error: null,
};

function git(args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: root, encoding }).toString().trim();
}
function sha(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function docker(args, timeout = 30_000) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    writeFileSync(
      join(temporary, "docker-error.log"),
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
    throw new Error(
      `docker ${args[0]} failed; see ${join(temporary, "docker-error.log")}`,
    );
  }
  return result.stdout;
}
function cleanup(args) {
  try {
    docker(args);
  } catch {}
}
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function snapshot() {
  const destination = join(context, "repo");
  const files = copySnapshot(root, destination);
  report.provenance = {
    sourceRoot: root,
    commit: git(["rev-parse", "HEAD"]),
    tree: git(["rev-parse", "HEAD^{tree}"]),
    dirty: git(["status", "--porcelain"]) !== "",
    lockfileSha256: sha(join(root, "pnpm-lock.yaml")),
    snapshotFiles: Object.keys(files).length,
    snapshotSha256: createHash("sha256")
      .update(JSON.stringify(files))
      .digest("hex"),
    files,
  };
}
function imageDetails(name) {
  const value = JSON.parse(docker(["image", "inspect", name]))[0];
  return { id: value?.Id ?? null, repoDigest: value?.RepoDigests?.[0] ?? null };
}
function waitForDatabase() {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const result = spawnSync(
      "docker",
      ["exec", database, "pg_isready", "-U", "fixture", "-d", "fixture"],
      { encoding: "utf8", timeout: 3_000 },
    );
    if (result.status === 0) return;
    sleep(200);
  }
  throw new Error("fixture PostgreSQL did not become ready");
}

try {
  snapshot();
  const dockerfile = join(context, "repo/scripts/dual-runtime/Dockerfile");
  const buildStarted = Date.now();
  const build = spawnSync(
    "docker",
    [
      "build",
      "--platform",
      "linux/arm64",
      "--progress=plain",
      "--label",
      `reflection.dual-runtime=${token}`,
      "--tag",
      image,
      "--file",
      dockerfile,
      join(context, "repo"),
    ],
    { encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
  );
  report.timings.buildMs = Date.now() - buildStarted;
  writeFileSync(buildLog, `${build.stdout ?? ""}\n${build.stderr ?? ""}`);
  if (build.error || build.status !== 0)
    throw new Error(`docker build failed; see ${buildLog}`);
  report.images.runner = imageDetails(image);
  docker([
    "network",
    "create",
    "--internal",
    "--label",
    `reflection.dual-runtime=${token}`,
    network,
  ]);
  docker([
    "volume",
    "create",
    "--label",
    `reflection.dual-runtime=${token}`,
    volume,
  ]);
  docker([
    "run",
    "--detach",
    "--name",
    database,
    "--network",
    network,
    "--network-alias",
    "fixture-pg",
    "--label",
    `reflection.dual-runtime=${token}`,
    "--volume",
    `${volume}:/var/lib/postgresql/data`,
    "--env",
    "POSTGRES_USER=fixture",
    "--env",
    "POSTGRES_PASSWORD=fixture-only",
    "--env",
    "POSTGRES_DB=fixture",
    postgresImage,
  ]);
  waitForDatabase();
  report.images.postgres = imageDetails(postgresImage);
  const runtimeStarted = Date.now();
  const runtime = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      runner,
      "--network",
      network,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "4g",
      "--pids-limit",
      "512",
      "--tmpfs",
      "/state:rw,nosuid,nodev,mode=1777",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,mode=1777",
      "--label",
      `reflection.dual-runtime=${token}`,
      image,
      "/usr/bin/env",
      "-i",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "HOME=/state/home",
      "TMPDIR=/tmp",
      "DATABASE_URL=postgresql://fixture:fixture-only@fixture-pg:5432/fixture",
      "REFLECTION_API_KEY=fixture-reflection",
      "OPENROUTER_API_KEY=fixture-openrouter",
      "VOYAGE_API_KEY=fixture-voyage",
      "OPENROUTER_BASE_URL=http://127.0.0.1:4101/v1",
      "VOYAGE_BASE_URL=http://127.0.0.1:4102/v1",
      "EMBEDDING_DIMENSIONS=1024",
      "WORKER_CONCURRENCY=1",
      "WORKER_POLL_SECONDS=0.05",
      "DATABASE_POOL_MIN_SIZE=1",
      "DATABASE_POOL_MAX_SIZE=2",
      "MIGRATIONS_DIR=/repo/migrations",
      "node",
      "/harness/scenario.mjs",
    ],
    { encoding: "utf8", timeout: 315_000, maxBuffer: 64 * 1024 * 1024 },
  );
  report.timings.runtimeMs = Date.now() - runtimeStarted;
  writeFileSync(runtimeLog, `${runtime.stdout ?? ""}\n${runtime.stderr ?? ""}`);
  report.runtime = {
    exitCode: runtime.status,
    signal: runtime.signal ?? null,
    timedOut: runtime.error?.code === "ETIMEDOUT",
  };
  const line = (runtime.stdout ?? "").trim().split("\n").at(-1);
  if (line) report.scenario = JSON.parse(line);
  if (
    runtime.error ||
    runtime.status !== 0 ||
    report.scenario?.outcome !== "passed"
  )
    throw new Error(`dual runtime failed; see ${runtimeLog}`);
  report.outcome = "passed";
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  cleanup(["rm", "-f", "-v", runner]);
  cleanup(["rm", "-f", "-v", database]);
  cleanup(["volume", "rm", volume]);
  cleanup(["network", "rm", network]);
  cleanup(["image", "rm", "-f", image]);
  try {
    report.cleanup = {
      containers: docker([
        "ps",
        "--all",
        "--quiet",
        "--filter",
        `label=reflection.dual-runtime=${token}`,
      ]).trim(),
      networks: docker([
        "network",
        "ls",
        "--quiet",
        "--filter",
        `label=reflection.dual-runtime=${token}`,
      ]).trim(),
      images: docker([
        "image",
        "ls",
        "--quiet",
        "--filter",
        `label=reflection.dual-runtime=${token}`,
      ]).trim(),
      volumes: docker([
        "volume",
        "ls",
        "--quiet",
        "--filter",
        `label=reflection.dual-runtime=${token}`,
      ]).trim(),
    };
    if (Object.values(report.cleanup).some(Boolean))
      throw new Error("run-owned Docker resources remain");
  } catch (error) {
    report.outcome = "failed";
    report.cleanupError = String(error);
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(
  JSON.stringify({
    outcome: report.outcome,
    reportPath,
    error:
      report.outcome === "failed"
        ? `See ${reportPath}, ${buildLog}, and ${runtimeLog}`
        : null,
    cleanup: report.cleanup,
    provenance: {
      sourceRoot: root,
      digest: report.provenance.snapshotSha256,
      commit: report.provenance.commit,
      dirty: report.provenance.dirty,
    },
    images: report.images,
    elapsedMs: report.scenario?.elapsedMs,
    passed: report.scenario?.passed,
    failed: report.scenario?.failed,
    phaseCounts: report.scenario?.phaseCounts,
    counts: report.scenario?.counts,
    remainingGates: report.scenario?.remainingGates,
    limitations: report.scenario?.limitations,
  }),
);
if (report.outcome !== "passed") process.exitCode = 1;
