import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CLI_ARCHIVE_SHA256,
  CLI_ARCHIVE_URL,
  CLI_BINARY_SHA256,
  assertGitHubHostedMacOS,
  childEnvironment,
  safeError,
  sandboxProfile,
  sessionRoute,
} from "./guards.mjs";
import {
  api as nativeAPI,
  createNativeSession,
  verifyBrowserContract,
} from "./browser.mjs";
import {
  createReflectionFixture,
  SOURCE,
  SEED_TEXT,
  MARKER,
  PROMPT,
} from "./fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../..");
// Intentionally outside every catch/finally which can write a report or spawn.
assertGitHubHostedMacOS(process.env, process, repository);
assert.equal(
  await realpath(process.env.GITHUB_WORKSPACE),
  await realpath(repository),
);
const runnerTemp = await realpath(process.env.RUNNER_TEMP);
assert.notEqual(runnerTemp, "/");
process.umask(0o077);

const reportPath = join(
  runnerTemp,
  `reflection-macos-v2-report-${process.pid}.json`,
);
const report = {
  outcome: "failed",
  phases: [],
  metadata: {},
  remaining: [
    "Native file watcher creation/rename/delete callbacks and PTY ticket/WebSocket handshake: not exercised by this lane. PTY contract is available in pinned protocol source.",
    "SafeShell tool subprocess execution: not exercised; toolchain gate covers actual Reflection tools only.",
    "Projection pressure, media, and broad commercial-provider quality: not asserted by this synthetic lane.",
    "OpenAI OAuth remains explicitly deferred; no credentials imported or auth initiated.",
  ],
  limitations: [
    "Disposable hosted macOS VM only. Sandbox permits public OS reads and Mach services; limits native writes and network endpoints. No unsandboxed fallback.",
    "codesign verification is not TCC, quarantine, notarization, or interactive Gatekeeper acceptance. Quarantine is not removed.",
    "Reflection HTTP backend is a deterministic mock, not PostgreSQL. Source history and tool execution are real native v2.",
    "Port 4096 is a run-owned HTTP/file sentinel, not a v1 runtime compatibility claim.",
  ],
};
const children = new Set();
const abort = new AbortController();
const api = (origin, password, path, body) =>
  nativeAPI(origin, password, path, body, { signal: abort.signal });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const goodAuth = (password) =>
  `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
let root, fixture, sentinel;

function start(command, args, options = {}) {
  abort.signal.throwIfAborted();
  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  children.add(child);
  child.output = "";
  child.spawnError = undefined;
  child.completion = new Promise((resolve) => {
    child.once("error", (error) => {
      child.spawnError = error;
      resolve({ error });
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      child.output = (child.output + chunk.toString()).slice(-64 * 1024);
    });
  return child;
}

function killGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function exited(child, ms) {
  let timer;
  try {
    return await Promise.race([
      child.completion,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function terminate(child) {
  if (!children.has(child)) return;
  // Kill only groups created by this run, including descendants of exited leaders.
  killGroup(child, "SIGTERM");
  await exited(child, 1000);
  killGroup(child, "SIGKILL");
  assert.ok(await exited(child, 2000), "Owned process failed to terminate");
  children.delete(child);
}

async function capture(command, args, options = {}) {
  const child = start(command, args, options);
  const result = await exited(child, options.timeout ?? 30_000);
  if (!result || result.error || result.code !== 0) {
    await terminate(child);
    throw Error(
      `Helper failed: ${command}: ${safeError(child.spawnError ?? child.output)}`,
    );
  }
  await terminate(child);
  return child.output.trim();
}

async function phase(name, work) {
  abort.signal.throwIfAborted();
  const started = Date.now();
  try {
    const result = await work();
    abort.signal.throwIfAborted();
    report.phases.push({
      name,
      outcome: "passed",
      durationMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    report.phases.push({
      name,
      outcome: "failed",
      durationMs: Date.now() - started,
      error: safeError(error),
    });
    throw error;
  }
}

async function request(origin, path, authorization) {
  return fetch(new URL(path, origin), {
    headers: authorization ? { authorization } : {},
    redirect: "error",
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(4000)]),
  });
}

async function ready(origin, password, child) {
  const until = Date.now() + 25_000;
  while (Date.now() < until) {
    abort.signal.throwIfAborted();
    if (child.spawnError || child.exitCode != null || child.signalCode != null)
      throw Error(
        `Native startup failed: ${safeError(child.spawnError ?? child.output)}`,
      );
    try {
      const response = await request(origin, "/api/info", goodAuth(password));
      const body = await response.json();
      if (response.ok && body) return;
    } catch {}
    await sleep(200);
  }
  throw Error(`Native startup deadline: ${safeError(child.output)}`);
}

async function layout(directory) {
  for (const name of [
    "home",
    "tmp",
    "xdg/config",
    "xdg/data",
    "xdg/state",
    "xdg/cache",
    "opencode-config",
    "db",
    "workspace",
    "plugin",
    "observer",
    "native",
  ])
    await mkdir(join(directory, name), { recursive: true, mode: 0o700 });
}

async function config(directory, fixtureOrigin, password) {
  await copyFile(
    join(repository, "packages/opencode-v2-plugin/dist/reflection-v2.js"),
    join(directory, "plugin/index.js"),
  );
  await copyFile(
    join(here, "observer.mjs"),
    join(directory, "observer/index.js"),
  );
  await writeFile(join(directory, "provider-origin"), fixtureOrigin);
  await writeFile(join(directory, "seed-session"), "not-created");
  await writeFile(
    join(directory, "opencode-config/AGENTS.md"),
    "GLOBAL_MACOS_INSTRUCTION_SENTINEL\n",
  );
  await writeFile(
    join(directory, "workspace/AGENTS.md"),
    "WORKSPACE_MACOS_INSTRUCTION_SENTINEL\n",
  );
  await writeFile(
    join(directory, "opencode-config/opencode.json"),
    JSON.stringify({
      model: "fixture/fixture-model",
      default_agent: "probe",
      update: "disable",
      share: "disabled",
      snapshots: false,
      warming: false,
      compaction: { auto: false },
      agents: {
        probe: {
          mode: "primary",
          steps: 4,
          system:
            "Use memory_search, then memory_read_segment for its citation. Return only the marker from exact source text. Never use other tools.",
        },
      },
      plugins: [
        {
          package: join(directory, "plugin"),
          options: { configPath: join(directory, "reflection.json") },
        },
        {
          package: join(directory, "observer"),
          options: { fixtureRoot: directory },
        },
      ],
      providers: {
        fixture: {
          package: "@opencode/ai/providers/openai-compatible",
          transport: "http",
          settings: { baseURL: `${fixtureOrigin}/v1`, apiKey: "fixture-only" },
          models: {
            "fixture-model": {
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 32000, input: 28000, output: 2048 },
              transport: "http",
            },
          },
        },
      },
    }),
  );
  await writeFile(
    join(directory, "reflection.json"),
    JSON.stringify({
      url: fixtureOrigin,
      apiKey: "fixture-only",
      sourceId: SOURCE.id,
      sources: {
        [SOURCE.id]: {
          kind: SOURCE.kind,
          url: fixtureOrigin,
          username: "opencode",
          password,
        },
      },
      contextProjection: { enabled: true },
    }),
  );
}

async function sse(origin, password, createSession) {
  let session;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    let reader;
    try {
      const response = await fetch(`${origin}/api/event`, {
        headers: { authorization: goodAuth(password) },
        signal: AbortSignal.any([
          abort.signal,
          controller.signal,
          AbortSignal.timeout(12_000),
        ]),
      });
      assert.ok(
        response.ok &&
          response.headers.get("content-type")?.includes("text/event-stream"),
      );
      reader = response.body.getReader();
      let text = "";
      const decoder = new TextDecoder();
      async function until(value) {
        while (!text.includes(value)) {
          const next = await reader.read();
          assert.ok(!next.done, "SSE ended early");
          text += decoder.decode(next.value, { stream: true });
          assert.ok(text.length < 1024 * 1024, "SSE budget exceeded");
        }
      }
      await until("server.connected");
      if (attempt === 0) {
        session = await createSession();
        await until("session.created");
        await until(session.id);
      }
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => {});
    }
  }
  return session;
}

async function httpContract(origin, password, sessionId) {
  for (const [path, auth] of [
    ["/", undefined],
    ["/api/session", goodAuth("wrong")],
  ]) {
    const response = await request(origin, path, auth);
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /Basic/i);
    await response.body?.cancel();
  }
  for (const path of ["/", sessionRoute(origin, sessionId)]) {
    const response = await request(origin, path, goodAuth(password));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<!doctype html|<html/i);
  }
  for (const path of ["/api/nonexistent", "/_assets/reflection-missing.js"]) {
    const response = await request(origin, path, goodAuth(password));
    assert.equal(response.status, 404);
    assert.doesNotMatch(
      response.headers.get("content-type") ?? "",
      /text\/html/i,
    );
    await response.body?.cancel();
  }
}

async function assertUnused(port) {
  const probe = createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
  } finally {
    if (probe.listening) await new Promise((resolve) => probe.close(resolve));
  }
}

const deadline = setTimeout(() => {
  abort.abort(Error("Global eight-minute deadline"));
  for (const child of children) killGroup(child, "SIGKILL");
  void fixture?.close().catch(() => {});
  sentinel?.closeAllConnections();
  sentinel?.close();
}, 8 * 60_000);
try {
  const major = (await capture("/usr/bin/sw_vers", ["-productVersion"])).split(
    ".",
  )[0];
  assert.equal(major, process.env.EXPECTED_MACOS_MAJOR);
  root = await realpath(
    await mkdtemp(join(runnerTemp, "reflection-macos-v2-")),
  );
  await chmod(root, 0o700);
  const password = randomBytes(24).toString("base64url");
  process.stdout.write(`::add-mask::${password}\n`);
  const origin = "http://127.0.0.1:4097";
  await phase("private layout and run-owned 4096 sentinel", async () => {
    await layout(root);
    for (const port of [4097, 4098]) await assertUnused(port);
    const value = randomBytes(24).toString("hex");
    await writeFile(join(root, "v1.sentinel"), value);
    report.metadata.sentinelHash = sha256(value);
    sentinel = createServer((req, res) =>
      res.writeHead(200, { "content-type": "text/plain" }).end(value),
    );
    await new Promise((resolve, reject) => {
      sentinel.once("error", reject);
      sentinel.listen(4096, "127.0.0.1", resolve);
    });
  });
  await phase(
    "build production Reflection bundle and identity oracle",
    async () => {
      await capture(
        "pnpm",
        ["--filter", "@reflection/opencode-v2-plugin", "build"],
        { cwd: repository, timeout: 90_000 },
      );
      await capture(
        "pnpm",
        [
          "exec",
          "esbuild",
          join(here, "oracle.mjs"),
          "--bundle",
          "--platform=node",
          "--format=esm",
          `--outfile=${join(root, "oracle.mjs")}`,
        ],
        { cwd: repository },
      );
      report.metadata.bundleSha256 = sha256(
        await readFile(
          join(repository, "packages/opencode-v2-plugin/dist/reflection-v2.js"),
        ),
      );
    },
  );
  fixture = createReflectionFixture();
  const fixtureOrigin = await fixture.listen();
  fixture.setNative(origin, password);
  await config(root, fixtureOrigin, password);
  const environment = {
    ...childEnvironment({ root, password }),
    OPENCODE_CONFIG_PROJECT_DISABLE: "0",
  };
  const profile = join(root, "sandbox.sb");
  await writeFile(
    profile,
    sandboxProfile(root, [4097, 4098, Number(new URL(fixtureOrigin).port)]),
  );
  await phase(
    "sandbox write/network enforcement and private instruction root",
    async () => {
      const safetyRoot = join(root, "safety");
      await layout(safetyRoot);
      const safetyProfile = join(safetyRoot, "sandbox.sb");
      await writeFile(
        safetyProfile,
        sandboxProfile(safetyRoot, [Number(new URL(fixtureOrigin).port)]),
      );
      await copyFile(
        join(here, "sandbox-probe.mjs"),
        join(safetyRoot, "probe.mjs"),
      );
      assert.equal(
        await capture(
          "/usr/bin/sandbox-exec",
          [
            "-f",
            safetyProfile,
            process.execPath,
            join(safetyRoot, "probe.mjs"),
            safetyRoot,
            join(root, "v1.sentinel"),
            fixtureOrigin,
          ],
          {
            env: childEnvironment({ root: safetyRoot, password }),
            cwd: safetyRoot,
          },
        ),
        "sandbox-boundary-ok",
      );
      assert.equal(
        sha256(await readFile(join(root, "v1.sentinel"))),
        report.metadata.sentinelHash,
      );
      await capture(
        "/usr/bin/sandbox-exec",
        [
          "-f",
          profile,
          "/usr/bin/git",
          "init",
          "--quiet",
          join(root, "workspace"),
        ],
        { env: environment, cwd: root },
      );
    },
  );
  const binary = await phase("published Darwin ARM64 provenance", async () => {
    const response = await fetch(CLI_ARCHIVE_URL, {
      redirect: "error",
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]),
    });
    assert.ok(response.ok);
    const archive = Buffer.from(await response.arrayBuffer());
    assert.equal(sha256(archive), CLI_ARCHIVE_SHA256);
    const archivePath = join(root, "native/cli.tgz");
    await writeFile(archivePath, archive);
    await capture("/usr/bin/tar", [
      "-xzf",
      archivePath,
      "-C",
      join(root, "native"),
    ]);
    const candidates = [];
    async function visit(dir) {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, item.name);
        if (item.isDirectory()) await visit(path);
        else if (item.name === "opencode") candidates.push(path);
      }
    }
    await visit(join(root, "native"));
    assert.equal(candidates.length, 1);
    const found = candidates[0];
    assert.equal(sha256(await readFile(found)), CLI_BINARY_SHA256);
    await chmod(found, 0o700);
    assert.match(await capture("/usr/bin/file", [found]), /Mach-O.*arm64/i);
    await capture("/usr/bin/codesign", ["--verify", "--verbose=2", found]);
    // Even --version gets private HOME, allowlisted env, and the sandbox.
    const version = await capture(
      "/usr/bin/sandbox-exec",
      ["-f", profile, found, "--version"],
      { env: environment, cwd: join(root, "workspace") },
    );
    assert.equal(version, "opencode v2.0.8");
    report.metadata.provenance = {
      version,
      archiveSha256: CLI_ARCHIVE_SHA256,
      binarySha256: CLI_BINARY_SHA256,
      sourceCommit: "7673ed6bd6547ee0dcb81aab55f1392fb751d652",
    };
    return found;
  });
  const native = (env, port, sandbox = profile) =>
    start(
      "/usr/bin/sandbox-exec",
      [
        "-f",
        sandbox,
        binary,
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      { env, cwd: join(dirname(env.HOME), "workspace") },
    );
  let server = native(environment, 4097);
  await phase("sandboxed native startup", () =>
    ready(origin, password, server),
  );
  const seed = await phase("native SSE event and reconnect", () =>
    sse(origin, password, () =>
      createNativeSession(origin, password, join(root, "workspace")),
    ),
  );
  await phase("HTTP authentication and SPA routing", () =>
    httpContract(origin, password, seed.id),
  );
  const session = await phase(
    "pluginInitialization and actual native memory toolchain",
    async () => {
      const location = new URLSearchParams({
        "location[directory]": join(root, "workspace"),
      });
      await api(origin, password, `/integration?${location}`);
      await writeFile(join(root, "seed-session"), seed.id);
      await api(origin, password, `/session/${seed.id}/prompt`, {
        text: SEED_TEXT,
        resume: true,
      });
      await api(origin, password, `/experimental/session/${seed.id}/wait`, {});
      assert.equal(
        fixture.provider.length,
        0,
        "Seed must not dispatch provider",
      );
      const history = (
        await api(
          origin,
          password,
          `/session/${seed.id}/message?limit=50&order=asc`,
        )
      ).data;
      const { canonicalizeNativeHistory, nativeSegmentIdForRequest } =
        await import(pathToFileURL(join(root, "oracle.mjs")));
      const record = canonicalizeNativeHistory(history).find(
        (record) => record.source.type === "user",
      );
      assert.ok(record?.complete);
      assert.equal(record.source.text, SEED_TEXT);
      const boundary = {
        source_id: SOURCE.id,
        session_id: seed.id,
        source_boundary_version: 3,
        start_source_message_id: record.source.id,
        end_source_message_id: record.source.id,
      };
      const id = nativeSegmentIdForRequest(
        {
          ...boundary,
          projection_version: 3,
          processing_priority: 0,
          messages: [record.source],
        },
        SOURCE,
      );
      const now = new Date().toISOString();
      fixture.setSegment({
        id,
        ...boundary,
        summary: "Synthetic marker",
        claims: [],
        created_at: now,
        updated_at: now,
      });
      const session = await createNativeSession(
        origin,
        password,
        join(root, "workspace"),
      );
      await api(origin, password, `/session/${session.id}/prompt`, {
        text: PROMPT,
        resume: true,
      });
      await api(
        origin,
        password,
        `/experimental/session/${session.id}/wait`,
        {},
      );
      const messages = (
        await api(
          origin,
          password,
          `/session/${session.id}/message?limit=50&order=asc`,
        )
      ).data;
      const assistant = messages
        .filter((item) => item.type === "assistant")
        .at(-1);
      assert.ok(assistant && !assistant.error);
      assert.equal(
        assistant.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
          .trim(),
        MARKER,
      );
      const observer = JSON.parse(
        await readFile(join(root, "observer.json"), "utf8"),
      );
      assert.deepEqual(observer, {
        setup: true,
        onlyMemoryTools: true,
        search: 1,
        read: 1,
        readExact: 1,
        refused: 0,
        primaryRequests: 3,
      });
      assert.deepEqual(
        fixture.provider.map((item) => item.turn),
        ["memory_search", "memory_read_segment", "final"],
      );
      assert.ok(
        fixture.sourceRPC.some(
          (item) =>
            item.path === `/api/session/${seed.id}/message` &&
            item.status === 200 &&
            item.rawNativeHistory,
        ),
        "Missing real native source history RPC",
      );
      assert.ok(
        fixture.requests.some(
          (item) => item.path === `/v1/sources/${SOURCE.id}`,
        ),
      );
      assert.deepEqual(fixture.errors, []);
      const instructions = fixture.provider[0].instructions;
      assert.ok(
        instructions.includes("GLOBAL_MACOS_INSTRUCTION_SENTINEL"),
        "Global AGENTS not loaded",
      );
      assert.ok(
        instructions.indexOf("WORKSPACE_MACOS_INSTRUCTION_SENTINEL") >
          instructions.indexOf("GLOBAL_MACOS_INSTRUCTION_SENTINEL"),
        "Global/workspace AGENTS ordering not respected",
      );
      report.metadata.toolchain = {
        observer,
        nativeSourceRPCs: fixture.sourceRPC.length,
        noSourceFallback: true,
        productionIdentity: true,
        globalInstructions: true,
      };
      return session;
    },
  );
  await phase("strict loopback native listener", async () => {
    const lines = (
      await capture("/usr/sbin/lsof", [
        "-nP",
        "-iTCP:4097",
        "-sTCP:LISTEN",
        "-Fpn",
      ])
    ).split("\n");
    assert.deepEqual(
      lines.filter((line) => line.startsWith("n")),
      ["n127.0.0.1:4097"],
    );
    assert.ok(lines.includes(`p${server.pid}`));
  });
  await phase(
    "independent baseline then port collision and invalid DB negatives",
    async () => {
      const other = join(root, "negative");
      await layout(other);
      await config(other, fixtureOrigin, password);
      const otherEnv = childEnvironment({ root: other, password });
      const otherProfile = join(other, "sandbox.sb");
      await writeFile(
        otherProfile,
        sandboxProfile(other, [
          4097,
          4098,
          Number(new URL(fixtureOrigin).port),
        ]),
      );
      const baseline = native(otherEnv, 4098, otherProfile);
      await ready("http://127.0.0.1:4098", password, baseline);
      await api(
        "http://127.0.0.1:4098",
        password,
        `/integration?${new URLSearchParams({ "location[directory]": join(other, "workspace") })}`,
      );
      assert.equal(
        JSON.parse(await readFile(join(other, "observer.json"), "utf8")).setup,
        true,
      );
      await terminate(baseline);
      const collision = native(otherEnv, 4097, otherProfile);
      const collisionExit = await exited(collision, 15_000);
      await terminate(collision);
      assert.ok(collisionExit && collisionExit.code !== 0);
      assert.match(collision.output, /EADDRINUSE|address already in use/i);
      await assertUnused(4098);
      const blocked = join(other, "db/blocked.db");
      await mkdir(blocked);
      const wrongDB = native(
        { ...otherEnv, OPENCODE_DB: blocked },
        4098,
        otherProfile,
      );
      const wrongExit = await exited(wrongDB, 15_000);
      await terminate(wrongDB);
      assert.ok(wrongExit && wrongExit.code !== 0);
      assert.match(
        wrongDB.output,
        /SQLITE_CANTOPEN|unable to open database|is a directory|EISDIR/i,
      );
      assert.doesNotMatch(
        wrongDB.output,
        /Operation not permitted|EACCES|plugin.*not found/i,
      );
      await assertUnused(4098);
    },
  );
  await phase("Darwin same-DB process lock rejects second port", async () => {
    const duplicate = native(environment, 4098);
    const result = await exited(duplicate, 15_000);
    await terminate(duplicate);
    assert.ok(result && result.code !== 0);
    assert.match(
      duplicate.output,
      /Process lock is already held|ProcessLockHeldError/,
    );
    await assertUnused(4098);
    await ready(origin, password, server);
  });
  await phase("native SQLite restart and untouched 4096 sentinel", async () => {
    assert.equal(
      (await readFile(environment.OPENCODE_DB)).subarray(0, 16).toString(),
      "SQLite format 3\0",
    );
    await terminate(server);
    server = native(environment, 4097);
    await ready(origin, password, server);
    assert.equal(
      (await api(origin, password, `/session/${session.id}`)).data.id,
      session.id,
    );
    const messages = (
      await api(
        origin,
        password,
        `/session/${session.id}/message?limit=50&order=asc`,
      )
    ).data;
    assert.ok(
      messages.some(
        (item) =>
          item.type === "assistant" &&
          item.content?.some(
            (part) => part.type === "text" && part.text.trim() === MARKER,
          ),
      ),
    );
    assert.equal(
      sha256(await readFile(join(root, "v1.sentinel"))),
      report.metadata.sentinelHash,
    );
    const response = await request("http://127.0.0.1:4096", "/");
    assert.equal(response.status, 200);
    assert.equal(sha256(await response.text()), report.metadata.sentinelHash);
  });
  report.metadata.platform = {
    macOS: major,
    arch: process.arch,
    node: process.version,
    image: process.env.ImageOS,
    imageVersion: process.env.ImageVersion,
  };
  // Mutated incrementally so a later browser failure cannot discard earlier
  // results. Native listener/DB/lock/restart evidence is collected first.
  report.metadata.browsers = {};
  await phase("Chromium and WebKit rendered history and reload", () =>
    verifyBrowserContract({
      origin,
      password,
      sessionId: session.id,
      directory: join(root, "workspace"),
      signal: abort.signal,
      results: report.metadata.browsers,
    }),
  );
  report.outcome = "passed";
} catch (error) {
  report.error = safeError(error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  const cleanup = await Promise.allSettled([...children].map(terminate));
  if (cleanup.some((item) => item.status === "rejected")) {
    report.outcome = "failed";
    report.cleanupFailed = true;
    process.exitCode = 1;
  }
  try {
    await fixture?.close();
    if (sentinel?.listening) {
      sentinel.closeAllConnections();
      await new Promise((resolve) => sentinel.close(resolve));
    }
    if (root) await rm(root, { recursive: true, force: true });
  } catch (error) {
    report.outcome = "failed";
    report.cleanupError = safeError(error);
    process.exitCode = 1;
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
}
process.stdout.write(
  JSON.stringify({
    outcome: report.outcome,
    reportPath,
    requiredGates: report.phases.length,
    remaining: report.remaining,
  }) + "\n",
);
