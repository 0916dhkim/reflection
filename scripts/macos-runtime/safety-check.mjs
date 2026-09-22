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
import { runInNewContext } from "node:vm";
import {
  browserURL,
  browserError,
  finiteAPIState,
  isReloadCancellation,
  installBrowserLifecycleObserver,
} from "./browser.mjs";

// Only a VM with fake window/console/fetch objects, never Playwright execution.
function lifecycleFixture(fetch, { logThrows = false, seed = 7 } = {}) {
  const lines = [];
  const listeners = new Map();
  let time = 0;
  const origin = "http://127.0.0.1:4097";
  const directory = "/private/fixture/workspace";
  const channel = "fixture-observer:";
  const target = {
    fetch,
    ErrorEvent: class {
      constructor(properties) {
        Object.assign(this, properties);
      }
    },
    location: { origin, href: `${origin}/session-fixture` },
    console: {
      debug(text) {
        if (logThrows) throw Error("logger unavailable");
        lines.push(text);
      },
    },
    performance: { timeOrigin: 100000, now: () => ++time },
    crypto: { getRandomValues: (values) => values.fill(seed) },
    addEventListener(type, listener, options) {
      const entries = listeners.get(type) ?? [];
      entries.push({ listener, options });
      listeners.set(type, entries);
    },
  };
  target.top = target;
  runInNewContext(`(${installBrowserLifecycleObserver.toString()})(options)`, {
    window: target,
    URL,
    Request,
    options: { origin, directory, channel },
  });
  return {
    target,
    listeners,
    origin,
    directory,
    records: () => lines.map((line) => JSON.parse(line.slice(channel.length))),
    dispatch(type, event = {}) {
      for (const { listener } of listeners.get(type) ?? []) listener(event);
    },
  };
}

test("lifecycle fetch wrapper preserves promise identity, receiver, arguments, and synchronous throws", () => {
  const promise = Promise.resolve("untouched");
  for (const name of ["then", "catch", "finally"])
    Object.defineProperty(promise, name, {
      get() {
        throw Error(`observer accessed ${name}`);
      },
    });
  let call;
  const fixture = lifecycleFixture(function (...args) {
    call = { receiver: this, args };
    return promise;
  });
  const receiver = {};
  const input = `${fixture.origin}/api/config?${new URLSearchParams({ "location[directory]": fixture.directory })}`;
  const init = new Proxy(
    {},
    {
      get() {
        throw Error("observer inspected request options");
      },
    },
  );
  assert.equal(fixture.target.fetch.call(receiver, input, init), promise);
  assert.equal(call.receiver, receiver);
  assert.deepEqual(call.args, [input, init]);
  assert.equal(fixture.records().at(-1).directoryMatches, true);
  const failure = Error("native synchronous failure");
  const throwing = lifecycleFixture(() => {
    throw failure;
  });
  assert.throws(
    () => throwing.target.fetch(input),
    (error) => error === failure,
  );
  assert.doesNotMatch(
    installBrowserLifecycleObserver.toString(),
    /\.(then|catch|finally)\s*\(|preventDefault/,
  );
});

test("capture pagehide precedes app callbacks; lifecycle records retain document tags and clocks", () => {
  const result = {};
  const fixture = lifecycleFixture(() => result);
  fixture.target.fetch("/api/config");
  fixture.target.addEventListener("pagehide", () =>
    fixture.target.fetch("/api/config"),
  );
  fixture.dispatch("pagehide", { persisted: false });
  fixture.dispatch("pageshow", { persisted: true });
  fixture.target.fetch("/api/config");
  const records = fixture.records();
  assert.deepEqual(
    records.map((record) => record.kind),
    ["installed", "fetch", "pagehide", "fetch", "pageshow", "fetch"],
  );
  assert.deepEqual(
    records
      .filter((record) => record.kind === "fetch")
      .map((record) => record.afterPagehide),
    [false, true, false],
  );
  assert.equal(fixture.listeners.get("pagehide")[0].options.capture, true);
  assert.equal(new Set(records.map((record) => record.documentTag)).size, 1);
  assert.match(records[0].documentTag, /^[a-f0-9]{32}$/);
  assert.deepEqual(
    records.map((record) => record.sequence),
    [1, 2, 3, 4, 5, 6],
  );
  assert.ok(
    records.every(
      (record, index) =>
        record.at === index + 1 && record.timeOrigin === 100000,
    ),
  );
  const next = lifecycleFixture(() => result, { seed: 8 });
  assert.notEqual(next.records()[0].documentTag, records[0].documentTag);
});

test("lifecycle observation emits no URL, query values, credentials, body, or raw error text", () => {
  const fixture = lifecycleFixture(() => ({}));
  const url = new URL(`${fixture.origin}/api/config`);
  url.username = "private-user";
  url.password = "private-password";
  url.searchParams.set("location[directory]", fixture.directory);
  url.searchParams.set("token", "private-token");
  fixture.target.fetch(url);
  const request = new Request(`${fixture.origin}/api/config`, {
    method: "POST",
    headers: { Authorization: "Basic private-header" },
    body: "private-body",
  });
  fixture.target.fetch(request);
  assert.equal(request.bodyUsed, false);
  fixture.target.fetch("data:text/plain,private-data");
  const message = `Fetch API cannot load ${url} due to access control checks. private-body`;
  const event = {
    message,
    error: Error(message),
    reason: Error(message),
    preventDefault() {
      throw Error("must not suppress events");
    },
  };
  fixture.dispatch("error", new fixture.target.ErrorEvent(event));
  fixture.dispatch("unhandledrejection", event);
  const records = fixture.records();
  const text = JSON.stringify(records);
  for (const secret of [
    fixture.origin,
    fixture.directory,
    "private-user",
    "private-password",
    "private-token",
    "private-header",
    "private-body",
    "private-data",
    "Fetch API cannot load",
  ])
    assert.ok(!text.includes(secret), secret);
  assert.equal(records[1].path, "/api/config");
  assert.deepEqual(records[1].queryKeys, ["location[directory]", "token"]);
  assert.equal(records[1].directoryMatches, true);
  assert.equal(records[3].path, "[non-http]");
  for (const record of records.slice(-2)) {
    assert.equal(record.accessControl, true);
    assert.equal(record.configMentioned, true);
    assert.equal(record.messagePresent, true);
  }
  assert.equal(records.at(-2).javascriptErrorEvent, true);
  fixture.dispatch("error", {});
  assert.equal(
    fixture.records().at(-1).javascriptErrorEvent,
    false,
    "resource errors are distinct from JavaScript ErrorEvents",
  );
});

test("observer failures and unfamiliar fetch inputs never change application behavior", () => {
  const result = {};
  let calls = 0;
  const input = {
    toString() {
      throw Error("must not coerce caller object");
    },
  };
  const fixture = lifecycleFixture(() => {
    calls++;
    return result;
  });
  assert.equal(fixture.target.fetch(input), result);
  assert.equal(calls, 1);
  assert.equal(fixture.records().at(-1).targetUnavailable, true);
  const throwingLog = lifecycleFixture(() => result, { logThrows: true });
  assert.equal(throwingLog.target.fetch("/api/config"), result);
  assert.deepEqual(throwingLog.records(), []);
  fixture.dispatch("unhandledrejection", {
    reason: new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw Error("uninspectable");
        },
      },
    ),
  });
  assert.equal(fixture.records().at(-1).kind, "unhandled-rejection");
  assert.equal(fixture.records().at(-1).summaryUnavailable, true);
});

test("observer record budget truncates explicitly without preventing later fetches", () => {
  let calls = 0;
  const fixture = lifecycleFixture(() => {
    calls++;
    return calls;
  });
  for (let i = 0; i < 300; i++)
    assert.equal(fixture.target.fetch("/api/config"), i + 1);
  const records = fixture.records();
  assert.equal(records.length, 257);
  assert.equal(records.at(-1).kind, "overflow");
  assert.equal(
    records.filter((record) => record.kind === "overflow").length,
    1,
  );
});

test("browser diagnostics omit query and credential values but correlate exact request URLs", () => {
  const origin = "http://127.0.0.1:4097";
  const directory = "/private/fixture/workspace";
  const url = `${origin}/api/config?${new URLSearchParams({ "location[directory]": directory, token: "never-artifact-this" })}`;
  const summary = browserURL(url, origin, directory);
  assert.equal(summary.path, "/api/config");
  assert.equal(summary.sameOrigin, true);
  assert.equal(summary.directoryMatches, true);
  assert.deepEqual(summary.queryKeys, ["location[directory]", "token"]);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /never-artifact-this|private\/fixture/,
  );
  assert.notEqual(browserURL(url + "2", origin, directory).key, summary.key);
  assert.equal(browserURL(url, origin, "/wrong").directoryMatches, false);
  assert.equal(
    browserURL(url, "http://127.0.0.1:4098", directory).sameOrigin,
    false,
  );
  assert.equal(
    browserURL("data:text/plain,private-payload", origin, directory).path,
    "[data:]",
  );
});

test("browser errors redact registered fixture secrets even in JSON colon-space form", () => {
  const password = "random-fixture+secret";
  const basic = Buffer.from(`opencode:${password}`).toString("base64");
  const error = new Error(
    `{"password": "${password}"} Basic ${basic} ${encodeURIComponent(password)} http://127.0.0.1:4097/api/config?location=private /api/config?token=secret-query due to access control checks.`,
  );
  const redacted = browserError(error, password);
  for (const secret of [
    password,
    basic,
    encodeURIComponent(password),
    "secret-query",
    "location=private",
  ])
    assert.ok(!redacted.includes(secret));
  assert.match(redacted, /due to access control checks/);
});

test("rendered history is not readiness while workspace config is in flight; SSE does not block", () => {
  const config = {
    id: 1,
    document: 1,
    sameOrigin: true,
    path: "/api/config",
    directoryMatches: true,
    method: "GET",
    startedAt: 10,
    endedAt: null,
    status: 200,
  };
  const sse = {
    id: 2,
    document: 1,
    sameOrigin: true,
    path: "/api/event",
    method: "GET",
    startedAt: 10,
    endedAt: null,
  };
  assert.deepEqual(finiteAPIState([config, sse], 1, 1000), {
    pending: [1],
    configComplete: false,
    ready: false,
  });
  const complete = { ...config, finished: true, endedAt: 100 };
  assert.equal(finiteAPIState([complete, sse], 1, 349).ready, false);
  assert.equal(finiteAPIState([complete, sse], 1, 350).ready, true);
  assert.equal(
    finiteAPIState([complete, sse], 2, 1000).ready,
    false,
    "reload must complete its own workspace config request",
  );
  assert.equal(
    finiteAPIState([{ ...complete, directoryMatches: false }], 1, 1000).ready,
    false,
  );
  for (const status of [401, 403, 500])
    assert.equal(
      finiteAPIState([{ ...complete, status }], 1, 1000).ready,
      false,
    );
});

test("delayed finite API work resets the bounded readiness window", () => {
  const config = {
    id: 1,
    document: 1,
    sameOrigin: true,
    path: "/api/config",
    directoryMatches: true,
    method: "GET",
    startedAt: 10,
    endedAt: 100,
    finished: true,
    status: 200,
  };
  const late = {
    ...config,
    id: 2,
    path: "/api/integration",
    startedAt: 340,
    endedAt: null,
    finished: false,
  };
  assert.equal(finiteAPIState([config, late], 1, 400).ready, false);
  assert.equal(
    finiteAPIState([config, { ...late, endedAt: 400, finished: true }], 1, 649)
      .ready,
    false,
  );
  assert.equal(
    finiteAPIState([config, { ...late, endedAt: 400, finished: true }], 1, 650)
      .ready,
    true,
  );
});

test("reload cancellation requires old pending request, explicit cancellation, and navigation timing", () => {
  const request = {
    id: 1,
    document: 1,
    sameOrigin: true,
    method: "GET",
    failedAt: 110,
    failure: "cancelled",
    status: null,
  };
  const navigation = {
    kind: "reload",
    fromDocument: 1,
    pending: [1],
    startedAt: 100,
    completedAt: 120,
  };
  assert.equal(isReloadCancellation(request, navigation), true);
  for (const patch of [
    { document: 2 },
    { failedAt: 99 },
    { failedAt: 121 },
    { status: 401 },
    { status: 403 },
    { status: 200, responseStatuses: [401, 200] },
    { sameOrigin: false },
    { method: "POST" },
    { failure: "Fetch API cannot load due to access control checks." },
    { failure: "Load failed" },
  ])
    assert.equal(
      isReloadCancellation({ ...request, ...patch }, navigation),
      false,
    );
  for (const patch of [
    { kind: "initial" },
    { pending: [] },
    { completedAt: undefined },
  ])
    assert.equal(
      isReloadCancellation(request, { ...navigation, ...patch }),
      false,
    );
});

test("browser gate remains fatal for all page errors and runs after native DB gates", async () => {
  const browser = await readFile(
    new URL("./browser.mjs", import.meta.url),
    "utf8",
  );
  assert.match(browser, /if \(diagnostics\.pageErrors\.length\)\s*throw Error/);
  assert.ok(
    browser.indexOf("await context.addInitScript(") <
      browser.indexOf("await context.newPage()"),
  );
  assert.doesNotMatch(
    browser,
    /waitUntil: ["']networkidle["']|extraHTTPHeaders/,
  );
  const runner = await readFile(new URL("./run.mjs", import.meta.url), "utf8");
  const browserPhase = runner.indexOf('await phase("Chromium and WebKit');
  for (const phase of [
    "independent baseline then port collision",
    "characterize foreground same-DB behavior",
    "native SQLite restart",
  ])
    assert.ok(runner.indexOf(phase) < browserPhase);
  assert.match(runner, /results: report\.metadata\.browsers/);
  assert.ok(runner.indexOf("report.metadata.browsers = {}") < browserPhase);
});

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
