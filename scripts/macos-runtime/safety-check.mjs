import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGitHubHostedMacOS,
  assertLoopbackUrl,
  assertPrivatePath,
  childEnvironment,
  safeError,
  sandboxProfile,
  sessionRoute,
} from "./guards.mjs";
import {
  completionTurn,
  completionChunks,
  SOURCE,
  SEED_TEXT,
  MARKER,
} from "./fixture.mjs";
import { readFile } from "node:fs/promises";

test("runner guard rejects local and self-hosted execution", () => {
  assert.throws(() => assertGitHubHostedMacOS({}));
  assert.throws(() =>
    assertGitHubHostedMacOS({
      GITHUB_ACTIONS: "true",
      RUNNER_OS: "macOS",
      RUNNER_ENVIRONMENT: "self-hosted",
    }),
  );
});

test("hosted guard requires an exact hosted identity, absolute job paths and matching workspace", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    RUNNER_OS: "macOS",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_TEMP: "/private/tmp/job",
    GITHUB_WORKSPACE: "/job/repo",
    GITHUB_RUN_ID: "123",
    GITHUB_JOB: "native-web",
    EXPECTED_MACOS_MAJOR: "26",
  };
  const runtime = { platform: "darwin", arch: "arm64" };
  assert.doesNotThrow(() => assertGitHubHostedMacOS(env, runtime, "/job/repo"));
  for (const key of Object.keys(env))
    assert.throws(
      () =>
        assertGitHubHostedMacOS({ ...env, [key]: "" }, runtime, "/job/repo"),
      key,
    );
  for (const value of [undefined, "self-hosted", "unknown"])
    assert.throws(() =>
      assertGitHubHostedMacOS(
        { ...env, RUNNER_ENVIRONMENT: value },
        runtime,
        "/job/repo",
      ),
    );
  assert.throws(() =>
    assertGitHubHostedMacOS(
      { ...env, RUNNER_TEMP: "relative" },
      runtime,
      "/job/repo",
    ),
  );
  assert.throws(() => assertGitHubHostedMacOS(env, runtime, "/job/other"));
  assert.throws(() =>
    assertGitHubHostedMacOS(env, { ...runtime, arch: "x64" }, "/job/repo"),
  );
  assert.throws(() =>
    assertGitHubHostedMacOS(
      env,
      { ...runtime, platform: "linux" },
      "/job/repo",
    ),
  );
});

test("entrypoint refuses before any writes, report catch, or native launch", async () => {
  const source = await readFile(new URL("./run.mjs", import.meta.url), "utf8");
  const guard = source.indexOf("assertGitHubHostedMacOS(process.env");
  for (const operation of [
    "await mkdtemp(",
    "await writeFile(",
    "const deadline =",
    "const child = spawn(",
  ])
    assert.ok(guard < source.indexOf(operation));
  assert.doesNotMatch(source.slice(0, guard), /try\s*\{/);
  assert.doesNotMatch(source, /spawnSync|tmpdir\(/);
});

test("sandbox denies writes and external networking with exact fixture ports", () => {
  const profile = sandboxProfile("/private/tmp/fixture", [4097, 4200]);
  assert.match(profile, /\(allow default\)/);
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /remote ip "localhost:4200"/);
  assert.match(profile, /network-bind \(local ip "localhost:4097"/);
  assert.doesNotMatch(profile, /4096|localhost:\*|allow network\*/);
  for (const ports of [[], [0], [65536], [4097.5], ["4097"]])
    assert.throws(() => sandboxProfile("/private/tmp/root", ports));
  assert.throws(() => sandboxProfile('/tmp/"escape', [4097]));
});

test("source-confirmed SPA route encodes the server origin, not the directory", () => {
  const origin = "http://127.0.0.1:4097";
  const route = sessionRoute(origin, "session-123");
  assert.equal(
    route,
    `/server/${Buffer.from(origin).toString("base64url")}/session/session-123`,
  );
});

test("fixture uses actual tool responses for citation and exact-read final output", () => {
  const body = {
    model: "fixture-model",
    stream: true,
    tools: ["memory_search", "memory_read_segment"].map((name) => ({
      type: "function",
      function: { name },
    })),
    messages: [],
  };
  assert.equal(completionTurn(body).name, "memory_search");
  const citation = {
    source_id: "actual-response-source",
    segment_id: "actual-response-segment",
  };
  body.messages.push({
    role: "tool",
    content: JSON.stringify({ claims: [{ segments: [citation] }] }),
  });
  assert.deepEqual(completionTurn(body), {
    name: "memory_read_segment",
    arguments: citation,
  });
  body.messages.push({
    role: "tool",
    content: JSON.stringify({
      source_id: SOURCE.id,
      messages: [{ text: SEED_TEXT }],
      verification: "deterministic segment ID",
    }),
  });
  assert.deepEqual(completionTurn(body), { text: MARKER });
  body.messages[1].content = JSON.stringify({
    source_id: SOURCE.id,
    messages: [{ text: SEED_TEXT }],
  });
  assert.throws(() => completionTurn(body), /not verified/);
  assert.throws(() => completionTurn({ ...body, tools: [] }), /registry/);
});

test("OpenAI-compatible chunks have indexes and a separate terminal finish reason", () => {
  const chunks = completionChunks(
    { name: "memory_search", arguments: { query: "fixture" } },
    1,
  );
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].choices[0].index, 0);
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].index, 0);
  assert.equal(chunks[0].choices[0].finish_reason, null);
  assert.equal(chunks[1].choices[0].finish_reason, "tool_calls");
  assert.deepEqual(chunks[1].choices[0].delta, {});
  assert.equal(
    completionChunks({ text: MARKER }, 3)[1].choices[0].finish_reason,
    "stop",
  );
});

test("fixture roots and URLs cannot escape the disposable loopback boundary", () => {
  assert.equal(
    assertPrivatePath("/tmp/root", "/tmp/root/db/file"),
    "/tmp/root/db/file",
  );
  assert.throws(() => assertPrivatePath("/tmp/root", "/tmp/other"));
  assert.equal(
    assertLoopbackUrl("http://127.0.0.1:4097").hostname,
    "127.0.0.1",
  );
  assert.throws(() => assertLoopbackUrl("https://example.com"));
});

test("child environment is allowlisted and errors redact fixture credentials", () => {
  const environment = childEnvironment({
    root: "/tmp/root",
    password: "secret",
  });
  assert.equal(environment.HOME, "/tmp/root/home");
  assert.equal("GITHUB_TOKEN" in environment, false);
  assert.equal("SSH_AUTH_SOCK" in environment, false);
  assert.match(
    safeError("password=secret Basic abc https://example.test/token"),
    /redacted/,
  );
  assert.doesNotMatch(safeError("password=secret Basic abc"), /secret|abc/);
});
