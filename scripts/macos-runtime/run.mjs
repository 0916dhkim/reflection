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
  POLICY_SEED_TEXT,
  toolContent,
  policyRefusalEvidence,
  policyGlobalRefusalEvidence,
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

async function config(
  directory,
  fixtureOrigin,
  password,
  policyEnabled = false,
) {
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
    join(directory, "seed-text"),
    policyEnabled ? POLICY_SEED_TEXT : SEED_TEXT,
  );
  await writeFile(join(directory, "tool-results.json"), "[]");
  if (policyEnabled) {
    // Outside the workspace and native AGENTS roots: only Reflection reads these.
    await mkdir(join(directory, "instructions"));
    await writeFile(
      join(directory, "instructions/MEMORY.md"),
      "MEMORY_MACOS_INITIAL_SENTINEL\n",
    );
    await writeFile(
      join(directory, "instructions/USER.md"),
      "USER_MACOS_INSTRUCTION_SENTINEL\n",
    );
    await writeFile(
      join(directory, "user-policy.json"),
      JSON.stringify({
        version: 1,
        instructionFiles: ["MEMORY.md", "USER.md"].map((name) =>
          join(directory, "instructions", name),
        ),
        modelAllowlists: { openrouter: ["google/fixture-model"] },
        geminiOpenRouterToolGuard: true,
      }),
    );
  }
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
      model: policyEnabled
        ? "openrouter/google/fixture-model"
        : "fixture/fixture-model",
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
          options: {
            configPath: join(directory, "reflection.json"),
            ...(policyEnabled
              ? { userPolicyPath: join(directory, "user-policy.json") }
              : {}),
          },
        },
        {
          package: join(directory, "observer"),
          options: { fixtureRoot: directory },
        },
      ],
      providers: {
        [policyEnabled ? "openrouter" : "fixture"]: {
          ...(policyEnabled
            ? {}
            : { package: "@opencode/ai/providers/openai-compatible" }),
          transport: "http",
          settings: { baseURL: `${fixtureOrigin}/v1`, apiKey: "fixture-only" },
          models: {
            [policyEnabled ? "google/fixture-model" : "fixture-model"]: {
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 32000, input: 28000, output: 2048 },
              transport: "http",
            },
            ...(policyEnabled
              ? {
                  "google/fixture-forbidden": {
                    capabilities: {
                      tools: true,
                      input: ["text"],
                      output: ["text"],
                    },
                  },
                  "google/fixture-late-override": {
                    disabled: false,
                    capabilities: {
                      tools: true,
                      input: ["text"],
                      output: ["text"],
                    },
                    limit: { context: 32000, input: 28000, output: 2048 },
                    transport: "http",
                  },
                }
              : {}),
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
  fixture = createReflectionFixture({
    readOriginals: async () =>
      JSON.parse(await readFile(join(root, "tool-results.json"), "utf8")),
  });
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
        fixture.provider.every(
          (item) => !item.policyEnabled && item.model === "fixture-model",
        ),
      );
      assert.ok(
        !instructions.includes("MEMORY_MACOS_") &&
          !instructions.includes("USER_MACOS_INSTRUCTION_SENTINEL"),
      );
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
  await phase(
    "opt-in user policy native wire, fresh instructions and hard refusal",
    async () => {
      const policyReport = (report.metadata.userPolicy = {
        policyEnabled: true,
        provider: "openrouter",
        model: "google/fixture-model",
        baselineProviderRequests: fixture.provider.length,
        providerRequests: 0,
        currentCase: "startup",
        roundtrips: [],
        refusals: [],
      });
      const policyRoot = join(root, "policy");
      const policyOrigin = "http://127.0.0.1:4098";
      await layout(policyRoot);
      const originals = async () =>
        JSON.parse(
          await readFile(join(policyRoot, "tool-results.json"), "utf8"),
        );
      const policyFixture = createReflectionFixture({
        policyEnabled: true,
        readOriginals: originals,
      });
      let policyServer;
      try {
        const policyFixtureOrigin = await policyFixture.listen();
        policyFixture.setNative(policyOrigin, password);
        await config(policyRoot, policyFixtureOrigin, password, true);
        const policyEnv = {
          ...childEnvironment({ root: policyRoot, password }),
          OPENCODE_CONFIG_PROJECT_DISABLE: "0",
        };
        const policySandbox = join(policyRoot, "sandbox.sb");
        await writeFile(
          policySandbox,
          sandboxProfile(policyRoot, [
            4098,
            Number(new URL(policyFixtureOrigin).port),
          ]),
        );
        await capture(
          "/usr/bin/sandbox-exec",
          [
            "-f",
            policySandbox,
            "/usr/bin/git",
            "init",
            "--quiet",
            join(policyRoot, "workspace"),
          ],
          {
            env: policyEnv,
            cwd: policyRoot,
          },
        );
        policyServer = native(policyEnv, 4098, policySandbox);
        await ready(policyOrigin, password, policyServer);
        const location = new URLSearchParams({
          "location[directory]": join(policyRoot, "workspace"),
        });
        await api(policyOrigin, password, `/integration?${location}`);
        await api(
          policyOrigin,
          password,
          `/integration/openrouter/connect/key?${location}`,
          { key: "fixture-only", label: "Synthetic policy fixture" },
        );
        const catalog = (
          await api(policyOrigin, password, `/model?${location}`)
        ).data;
        assert.ok(
          catalog.some(
            (model) =>
              model.providerID === "openrouter" &&
              model.id === "google/fixture-model" &&
              model.enabled,
          ),
        );
        assert.ok(
          !catalog.some(
            (model) =>
              model.providerID === "openrouter" &&
              model.id === "google/fixture-forbidden" &&
              model.enabled,
          ),
        );
        assert.ok(
          catalog.some(
            (model) =>
              model.providerID === "openrouter" &&
              model.id === "google/fixture-late-override" &&
              model.enabled,
          ),
          "Late native override must be selectable to exercise hard refusal",
        );
        policyReport.catalogFiltered = true;
        policyReport.lateOverrideSelectable = true;
        const newSession = async (id = "google/fixture-model") => {
          const result = (
            await api(policyOrigin, password, "/session", {
              title: "Policy native fixture",
              location: { directory: join(policyRoot, "workspace") },
              model: { providerID: "openrouter", id },
            })
          ).data;
          assert.equal(typeof result.id, "string");
          return result;
        };
        const messages = async (id, signal = abort.signal) =>
          (
            await nativeAPI(
              policyOrigin,
              password,
              `/session/${id}/message?limit=50&order=asc`,
              undefined,
              { signal },
            )
          ).data;
        const prompt = async (id, text = PROMPT, signal = abort.signal) => {
          await nativeAPI(
            policyOrigin,
            password,
            `/session/${id}/prompt`,
            {
              text,
              resume: true,
            },
            { signal },
          );
          await nativeAPI(
            policyOrigin,
            password,
            `/experimental/session/${id}/wait`,
            {},
            { signal },
          );
          return messages(id, signal);
        };
        const policySeed = await newSession();
        await writeFile(join(policyRoot, "seed-session"), policySeed.id);
        const seedHistory = await prompt(policySeed.id, POLICY_SEED_TEXT);
        assert.equal(policyFixture.provider.length, 0);
        const { canonicalizeNativeHistory, nativeSegmentIdForRequest } =
          await import(pathToFileURL(join(root, "oracle.mjs")));
        const seedRecord = canonicalizeNativeHistory(seedHistory).find(
          (record) => record.source.type === "user",
        );
        assert.ok(seedRecord?.complete);
        assert.equal(seedRecord.source.text, POLICY_SEED_TEXT);
        const boundary = {
          source_id: SOURCE.id,
          session_id: policySeed.id,
          source_boundary_version: 3,
          start_source_message_id: seedRecord.source.id,
          end_source_message_id: seedRecord.source.id,
        };
        const segmentID = nativeSegmentIdForRequest(
          {
            ...boundary,
            projection_version: 3,
            processing_priority: 0,
            messages: [seedRecord.source],
          },
          SOURCE,
        );
        const now = new Date().toISOString();
        policyFixture.setSegment({
          id: segmentID,
          ...boundary,
          summary: "Synthetic marker",
          claims: [],
          created_at: now,
          updated_at: now,
        });
        const roundtrip = async (name, memory) => {
          policyReport.currentCase = name;
          policyFixture.beginCase();
          const before = policyFixture.provider.length;
          const originalBefore = (await originals()).length;
          const probe = await newSession();
          const history = await prompt(probe.id);
          const assistant = history
            .filter((item) => item.type === "assistant")
            .at(-1);
          assert.ok(assistant && !assistant.error);
          assert.equal(toolContent(assistant).trim(), MARKER);
          const wire = policyFixture.provider.slice(before);
          assert.deepEqual(
            wire.map((item) => item.turn),
            ["memory_search", "memory_read_segment", "final"],
          );
          for (const item of wire) {
            const sentinels = [
              "GLOBAL_MACOS_INSTRUCTION_SENTINEL",
              "WORKSPACE_MACOS_INSTRUCTION_SENTINEL",
              memory,
              "USER_MACOS_INSTRUCTION_SENTINEL",
            ];
            let last = -1;
            for (const sentinel of sentinels) {
              assert.equal(
                item.instructions.split(sentinel).length - 1,
                1,
                "Instruction must occur exactly once",
              );
              assert.ok(
                item.instructions.indexOf(sentinel) > last,
                "Instruction order mismatch",
              );
              last = item.instructions.indexOf(sentinel);
            }
            if (memory !== "MEMORY_MACOS_INITIAL_SENTINEL")
              assert.ok(
                !item.instructions.includes("MEMORY_MACOS_INITIAL_SENTINEL"),
                "Stale instruction survived reread",
              );
          }
          const raw = (await originals()).slice(originalBefore);
          const stored = history
            .filter((item) => item.type === "assistant")
            .flatMap((item) => item.content)
            .filter(
              (part) =>
                part.type === "tool" && part.state.status === "completed",
            )
            .map((part) => toolContent(part.state));
          assert.deepEqual(
            stored,
            raw,
            "Native stored tool history must remain unencoded",
          );
          assert.deepEqual(
            wire.at(-1).toolContents,
            raw.map((text) => JSON.stringify(text)),
          );
          assert.deepEqual(
            await messages(policySeed.id),
            seedHistory,
            "Source native history changed",
          );
          assert.deepEqual(
            canonicalizeNativeHistory(await messages(policySeed.id)),
            canonicalizeNativeHistory(seedHistory),
          );
          policyReport.providerRequests = policyFixture.provider.length;
          policyReport.roundtrips.push({
            name,
            providerRequests: wire.length,
            exactOnceWireEncoding: true,
            storedHistoryUnchanged: true,
            orderedInstructions: true,
          });
        };
        await roundtrip("initial", "MEMORY_MACOS_INITIAL_SENTINEL");
        await writeFile(
          join(policyRoot, "instructions/MEMORY.md"),
          "MEMORY_MACOS_CHANGED_SENTINEL\n",
        );
        await roundtrip("fresh-instructions", "MEMORY_MACOS_CHANGED_SENTINEL");
        policyReport.freshInstructions = true;
        const refuse = async (name, id, expected) => {
          policyReport.currentCase = name;
          const evidence = { name, outcome: "running" };
          policyReport.refusals.push(evidence);
          const before = policyFixture.requests.filter(
            (item) => item.path === "/v1/chat/completions",
          ).length;
          // This owned child's buffer is diagnostic-only. Reset it so reason
          // classification cannot accidentally match a prior refusal's output.
          policyServer.output = "";
          const controller = new AbortController();
          const streamSignal = AbortSignal.any([
            abort.signal,
            controller.signal,
            AbortSignal.timeout(12_000),
          ]);
          let reader;
          let globalFailed = false;
          evidence.globalStream = policyGlobalRefusalEvidence("", id, expected);
          try {
            const live = await fetch(`${policyOrigin}/api/event`, {
              headers: { authorization: goodAuth(password) },
              redirect: "error",
              signal: streamSignal,
            });
            evidence.globalStatus = live.status;
            assert.ok(
              live.ok &&
                live.headers.get("content-type")?.includes("text/event-stream"),
              "Global SSE unavailable",
            );
            reader = live.body.getReader();
            let text = "";
            let bytes = 0;
            const decoder = new TextDecoder();
            const until = async (predicate) => {
              while (!predicate(evidence.globalStream)) {
                const next = await reader.read();
                assert.ok(!next.done, "Global SSE ended before refusal proof");
                bytes += next.value.byteLength;
                if (bytes > 256 * 1024) {
                  evidence.globalStream.overflow = true;
                  throw Error("Global SSE byte budget exceeded");
                }
                text += decoder.decode(next.value, { stream: true });
                evidence.globalStream = policyGlobalRefusalEvidence(
                  text,
                  id,
                  expected,
                );
                assert.ok(
                  !evidence.globalStream.overflow &&
                    !evidence.globalStream.malformed &&
                    !evidence.globalStream.streamFailure,
                  "Invalid global SSE evidence",
                );
              }
            };
            await until((state) => state.connected);
            assert.equal(
              evidence.globalStream.terminal.terminalCount,
              0,
              "Unexpected terminal before refusal prompt",
            );
            // Begin reading before dispatch; a fast refusal must not be missed.
            const terminal = until((state) => state.terminal.terminalCount > 0);
            await Promise.all([terminal, prompt(id, PROMPT, streamSignal)]);
            streamSignal.throwIfAborted();
            evidence.promptCompleted = true;
          } catch {
            globalFailed = true;
            evidence.globalStreamFailed = true;
            evidence.globalStreamAborted = streamSignal.aborted;
          } finally {
            controller.abort();
            await reader?.cancel().catch(() => {});
          }
          evidence.nativeOutputExpectedReason =
            policyServer.output.includes(expected);
          // Hosted run 35771642468 returned only log.synced here. Preserve this
          // diagnostic without claiming replay correctness or a vendor defect.
          try {
            const response = await request(
              policyOrigin,
              `/api/experimental/session/${id}/log?follow=false`,
              goodAuth(password),
            );
            evidence.logStatus = response.status;
            evidence.experimentalReplay = policyRefusalEvidence(
              await response.text(),
              id,
              expected,
              policyServer.output,
            );
          } catch {
            evidence.experimentalReplayUnavailable = true;
          }
          evidence.providerRequestDelta =
            policyFixture.requests.filter(
              (item) => item.path === "/v1/chat/completions",
            ).length - before;
          evidence.outcome = "failed";
          assert.equal(
            evidence.providerRequestDelta,
            0,
            "Refusal dispatched provider request",
          );
          assert.ok(
            !globalFailed &&
              evidence.promptCompleted &&
              evidence.globalStream.terminal.matched,
            `Expected explicit policy refusal: ${name}`,
          );
          await ready(policyOrigin, password, policyServer);
          evidence.outcome = "passed";
        };
        report.limitations.push(
          "Experimental session log returned only log.synced during refusal probes in hosted run 35771642468. This lane proves refusals through pre-subscribed global SSE; durable replay correctness is not asserted.",
        );
        await rm(join(policyRoot, "instructions/MEMORY.md"));
        await refuse(
          "missing-instruction",
          (await newSession()).id,
          "Reflection: user policy instructions unavailable; request blocked",
        );
        policyReport.missingFileRefused = true;
        await writeFile(
          join(policyRoot, "instructions/MEMORY.md"),
          "MEMORY_MACOS_CHANGED_SENTINEL\n",
        );
        await refuse(
          "late-model-override",
          (await newSession("google/fixture-late-override")).id,
          "user policy forbids selected model",
        );
        policyReport.lateOverrideRefused = true;
        await roundtrip("recovery", "MEMORY_MACOS_CHANGED_SENTINEL");
        assert.equal(policyFixture.provider.length, 9);
        assert.equal(
          fixture.provider.length,
          3,
          "Baseline remains raw and unchanged",
        );
        assert.deepEqual(policyFixture.errors, []);
        assert.ok(
          policyFixture.sourceRPC.some(
            (item) =>
              item.path === `/api/session/${policySeed.id}/message` &&
              item.status === 200 &&
              item.rawNativeHistory &&
              item.exactSeedText,
          ),
        );
        const observer = JSON.parse(
          await readFile(join(policyRoot, "observer.json"), "utf8"),
        );
        assert.deepEqual(observer, {
          setup: true,
          onlyMemoryTools: true,
          search: 3,
          read: 3,
          readExact: 3,
          refused: 0,
          primaryRequests: 9,
        });
        Object.assign(policyReport, {
          policyEnabled: true,
          provider: "openrouter",
          model: "google/fixture-model",
          providerRequests: 9,
          baselineProviderRequests: 3,
          observer,
          exactOnceWireEncoding: true,
          storedHistoryUnchanged: true,
          orderedInstructions: true,
          freshInstructions: true,
          missingFileRefused: true,
          catalogFiltered: true,
          lateOverrideRefused: true,
          recoveryRoundtrip: true,
          currentCase: "complete",
        });
      } finally {
        policyReport.providerRequests = policyFixture.provider.length;
        if (policyServer) await terminate(policyServer);
        await policyFixture.close();
      }
      await assertUnused(4098);
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
      assert.match(
        collision.output,
        /EADDRINUSE|address already in use|Failed to start server\. Is port 4097 in use\?/i,
      );
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
  await phase(
    "characterize foreground same-DB behavior on another port",
    async () => {
      const duplicate = native(environment, 4098);
      // The presence of an upstream ProcessLock utility is not evidence that
      // foreground serve acquires it. Verify the observed shared-state risk.
      await ready("http://127.0.0.1:4098", password, duplicate);
      assert.equal(
        (await api("http://127.0.0.1:4098", password, `/session/${session.id}`))
          .data.id,
        session.id,
      );
      report.metadata.foregroundSharedDatabasePermitted = true;
      report.remaining.push(
        "Foreground serve permits a second port on the same database. Private instance configuration/launcher must prevent shared roots; no native single-writer lock guarantee is claimed.",
      );
      await terminate(duplicate);
      await assertUnused(4098);
      await ready(origin, password, server);
    },
  );
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
