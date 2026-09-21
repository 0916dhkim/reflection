import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";

const REPOSITORY = process.cwd();
const TEMP_ROOT = join(tmpdir(), "opencode");
const OLD_REVISION = "8187636a68f3040982db0537cf988d442efe1034";
const HARNESS_FILES = [
  "backend.mjs",
  "plugin-child.mjs",
  "scenario.mjs",
  "build-provenance.mjs",
];
const RUNTIME_TIMEOUT_MS = 180_000;
const BUILD_TIMEOUT_MS = 600_000;
const READINESS_TIMEOUT_MS = 20_000;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  let newRevision = "HEAD";

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--new" || index + 1 >= argv.length) {
      fail("Usage: node scripts/rehearsal/run.mjs [--new <commit-ish>]");
    }

    newRevision = argv[index + 1];
    index += 1;
  }

  if (newRevision.startsWith("-")) {
    fail("--new must name a commit");
  }

  return { newRevision };
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: REPOSITORY,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
    ...options,
  }).trim();
}

function resolveCommit(reference) {
  return git(["rev-parse", "--verify", `${reference}^{commit}`]);
}

function revisionProvenance(revision) {
  return {
    commit: revision,
    tree: git(["rev-parse", `${revision}^{tree}`]),
    lockfileBlob: git(["rev-parse", `${revision}:pnpm-lock.yaml`]),
  };
}

function archiveRevision(revision, destination, label) {
  mkdirSync(destination, { recursive: true });
  const archivePath = join(destination, `${label}.tar`);
  const archive = spawnSync("git", ["archive", "--format=tar", revision], {
    cwd: REPOSITORY,
    encoding: null,
    maxBuffer: 1024 * 1024 * 1024,
  });

  if (archive.error != null || archive.status !== 0) {
    fail(
      `git archive ${revision} failed: ${archive.error?.message ?? archive.stderr?.toString() ?? "unknown error"}`,
    );
  }

  writeFileSync(archivePath, archive.stdout);
  const extracted = spawnSync("tar", ["-xf", archivePath, "-C", destination], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });

  rmSync(archivePath, { force: true });
  if (extracted.error != null || extracted.status !== 0) {
    fail(
      `tar extraction for ${revision} failed: ${extracted.error?.message ?? extracted.stderr ?? "unknown error"}`,
    );
  }
}

function copyHarnessFiles(context) {
  const sourceDirectory = join(REPOSITORY, "scripts", "rehearsal");
  const destinationDirectory = join(context, "harness");
  mkdirSync(destinationDirectory, { recursive: true });

  for (const file of HARNESS_FILES) {
    const source = join(sourceDirectory, file);
    if (!existsSync(source) || !statSync(source).isFile()) {
      fail(`Required harness file is missing: ${source}`);
    }
    copyFileSync(source, join(destinationDirectory, file));
  }
}

function version(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function cleanDockerEnvironment(tempDirectory) {
  const dockerConfig = join(tempDirectory, "docker-config");
  const dockerHome = join(tempDirectory, "docker-home");
  const dockerTemporaryDirectory = join(tempDirectory, "docker-tmp");
  mkdirSync(dockerConfig, { recursive: true });
  mkdirSync(dockerHome, { recursive: true });
  mkdirSync(dockerTemporaryDirectory, { recursive: true });
  // Keep host registry credentials/proxies out, but retain discovery of the
  // Docker Desktop build plugin that otherwise lives outside the clean HOME.
  const cliPluginsExtraDirs = [
    "/Applications/Docker.app/Contents/Resources/cli-plugins",
  ].filter(existsSync);
  writeFileSync(
    join(dockerConfig, "config.json"),
    `${JSON.stringify({ cliPluginsExtraDirs })}\n`,
  );
  return {
    DOCKER_CONFIG: dockerConfig,
    HOME: dockerHome,
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: dockerTemporaryDirectory,
  };
}

function runDocker(args, environment, options = {}) {
  const result = spawnSync("docker", args, {
    cwd: REPOSITORY,
    encoding: "utf8",
    env: environment,
    timeout: options.timeout ?? 30_000,
    maxBuffer: 1024 * 1024 * 32,
  });

  if (options.logPath != null) {
    writeFileSync(
      options.logPath,
      `docker ${args.join(" ")}\n\nstdout:\n${result.stdout ?? ""}\n\nstderr:\n${result.stderr ?? ""}\n`,
    );
  }

  if (result.error != null) {
    fail(`docker ${args[0]} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `docker ${args[0]} exited with ${result.status}; see ${options.logPath ?? "Docker output"}`,
    );
  }

  return result.stdout.trim();
}

function bestEffortDocker(args, environment) {
  try {
    runDocker(args, environment);
  } catch {
    // Cleanup must continue for every resource created by this invocation.
  }
}

function imageDetails(image, environment) {
  try {
    const inspected = JSON.parse(
      runDocker(["image", "inspect", image], environment),
    );
    return {
      id: inspected[0]?.Id ?? null,
      repoDigest: inspected[0]?.RepoDigests?.[0] ?? null,
    };
  } catch {
    return { id: null, repoDigest: null };
  }
}

function waitForPostgres(container, environment) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = spawnSync(
      "docker",
      ["exec", container, "pg_isready", "-U", "rehearsal", "-d", "rehearsal"],
      {
        encoding: "utf8",
        env: environment,
        timeout: 5_000,
      },
    );
    if (result.status === 0) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
  }
  fail(
    `PostgreSQL fixture did not become ready within ${READINESS_TIMEOUT_MS / 1_000} seconds`,
  );
}

function main() {
  const { newRevision: requestedNewRevision } = parseArguments(
    process.argv.slice(2),
  );
  const oldRevision = resolveCommit(OLD_REVISION);
  const newRevision = resolveCommit(requestedNewRevision);
  mkdirSync(TEMP_ROOT, { recursive: true });
  const temporaryDirectory = mkdtempSync(
    join(TEMP_ROOT, "reflection-rehearsal-"),
  );
  const context = join(temporaryDirectory, "context");
  const runtimeStdoutPath = join(temporaryDirectory, "scenario.stdout.log");
  const runtimeStderrPath = join(temporaryDirectory, "scenario.stderr.log");
  const buildLogPath = join(temporaryDirectory, "docker-build.log");
  const reportPath = join(temporaryDirectory, "report.json");
  const scenarioReportPath = join(temporaryDirectory, "scenario-report.json");
  const runToken = `${Date.now()}-${process.pid}-${randomBytes(6).toString("hex")}`;
  const image = `reflection-rehearsal:${runToken}`;
  const network = `reflection-rehearsal-net-${runToken}`;
  const databaseContainer = `reflection-rehearsal-pg-${runToken}`;
  const runnerContainer = `reflection-rehearsal-run-${runToken}`;
  const dockerEnvironment = cleanDockerEnvironment(temporaryDirectory);
  const report = {
    status: "failed",
    temporaryDirectory,
    context,
    reportPath,
    logs: {
      build: buildLogPath,
      scenarioStdout: runtimeStdoutPath,
      scenarioStderr: runtimeStderrPath,
    },
    provenance: {
      old: revisionProvenance(oldRevision),
      new: revisionProvenance(newRevision),
    },
    hostCli: {
      node: process.version,
      pnpm: version("pnpm", ["--version"]),
    },
    images: {
      runner: { id: null, repoDigest: null },
      postgres: { id: null, repoDigest: null },
    },
    runtime: null,
    scenarioReportPath,
    error: null,
  };

  writeFileSync(runtimeStdoutPath, "");
  writeFileSync(runtimeStderrPath, "");

  try {
    mkdirSync(context, { recursive: true });
    archiveRevision(oldRevision, join(context, "old"), "old");
    archiveRevision(newRevision, join(context, "new"), "new");
    copyHarnessFiles(context);
    writeFileSync(
      join(context, "provenance.json"),
      `${JSON.stringify(report.provenance, null, 2)}\n`,
    );

    runDocker(
      [
        "build",
        "--progress=plain",
        "--tag",
        image,
        "--file",
        join(REPOSITORY, "scripts", "rehearsal", "Dockerfile"),
        context,
      ],
      dockerEnvironment,
      { timeout: BUILD_TIMEOUT_MS, logPath: buildLogPath },
    );
    report.images.runner = imageDetails(image, dockerEnvironment);

    runDocker(["network", "create", "--internal", network], dockerEnvironment);
    runDocker(
      [
        "run",
        "--detach",
        "--rm",
        "--name",
        databaseContainer,
        "--network",
        network,
        "--network-alias",
        "postgres",
        "--label",
        `reflection.rehearsal=${runToken}`,
        "--env",
        "POSTGRES_USER=rehearsal",
        "--env",
        "PGUSER=rehearsal",
        "--env",
        "POSTGRES_PASSWORD=fixture-only",
        "--env",
        "POSTGRES_DB=rehearsal",
        "pgvector/pgvector:pg17",
      ],
      dockerEnvironment,
    );
    waitForPostgres(databaseContainer, dockerEnvironment);
    report.images.postgres = imageDetails(
      "pgvector/pgvector:pg17",
      dockerEnvironment,
    );

    const runtimeResult = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        runnerContainer,
        "--network",
        network,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "256",
        "--memory",
        "4g",
        "--tmpfs",
        "/state:rw,mode=1777",
        "--tmpfs",
        "/tmp:rw,mode=1777",
        "--user",
        "node",
        "--label",
        `reflection.rehearsal=${runToken}`,
        image,
        "/usr/bin/env",
        "-i",
        "PATH=/usr/lib/postgresql/17/bin:/usr/local/bin:/usr/bin:/bin",
        "HOME=/state/home",
        "TMPDIR=/tmp",
        "REHEARSAL_DATABASE_URL=postgresql://rehearsal:fixture-only@postgres:5432/rehearsal",
        "REHEARSAL_PG_HOST=postgres",
        "node",
        "/harness/scenario.mjs",
      ],
      {
        cwd: REPOSITORY,
        encoding: "utf8",
        env: dockerEnvironment,
        timeout: RUNTIME_TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 32,
      },
    );
    writeFileSync(runtimeStdoutPath, runtimeResult.stdout ?? "");
    writeFileSync(runtimeStderrPath, runtimeResult.stderr ?? "");
    let scenario;
    try {
      scenario = JSON.parse(runtimeResult.stdout.trim());
      writeFileSync(
        scenarioReportPath,
        `${JSON.stringify(scenario, null, 2)}\n`,
      );
      report.scenario = {
        outcome: scenario.outcome,
        assertions: scenario.assertions?.length,
        phases: scenario.phases,
        timings: scenario.timings,
        limitations: scenario.limitations,
      };
    } catch {
      // Preserve raw output for diagnosing crashes before the scenario report.
    }
    report.runtime = {
      exitCode: runtimeResult.status,
      signal: runtimeResult.signal ?? null,
      timedOut: runtimeResult.error?.code === "ETIMEDOUT",
    };
    if (runtimeResult.error != null) {
      fail(`scenario container failed: ${runtimeResult.error.message}`);
    }
    if (runtimeResult.status !== 0) {
      fail(
        `scenario container exited with ${runtimeResult.status}; see ${runtimeStdoutPath} and ${runtimeStderrPath}`,
      );
    }
    if (
      scenario?.outcome !== "passed" ||
      !scenario.assertions?.length ||
      scenario.assertions.some((entry) => entry.passed !== true)
    ) {
      fail("Scenario did not report a fully passing assertion set");
    }

    report.status = "passed";
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    bestEffortDocker(
      ["rm", "--force", "--volumes", runnerContainer],
      dockerEnvironment,
    );
    bestEffortDocker(
      ["rm", "--force", "--volumes", databaseContainer],
      dockerEnvironment,
    );
    bestEffortDocker(["network", "rm", network], dockerEnvironment);
    bestEffortDocker(["image", "rm", "--force", image], dockerEnvironment);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
}

main();
