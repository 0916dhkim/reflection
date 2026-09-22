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
  POLICY_SEED_TEXT,
  toolResult,
  createReflectionFixture,
  policyRefusalEvidence,
  policyGlobalRefusalEvidence,
} from "./fixture.mjs";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import {
  browserURL,
  browserError,
  finiteAPIState,
  isReloadCancellation,
  installBrowserLifecycleObserver,
  classifyWebKitTeardown,
  hasJavaScriptFailure,
} from "./browser.mjs";

function teardownProof() {
  const oldTag = "a".repeat(32);
  const newTag = "b".repeat(32);
  const event = (kind, documentTag, sequence, receivedAt, fields = {}) => ({
    kind,
    documentTag,
    sequence,
    receivedAt,
    at: receivedAt,
    timeOrigin: 100000,
    observedDocument: documentTag === oldTag ? 1 : 2,
    afterPagehide: false,
    phase: "reload:navigation",
    ...fields,
  });
  const target = {
    path: "/api/config",
    sameOrigin: true,
    directoryMatches: true,
    queryKeys: ["location[directory]"],
  };
  const config = {
    ...target,
    id: 83,
    key: "a".repeat(16),
    method: "GET",
    type: "fetch",
    document: 1,
    status: 200,
    responseStatuses: [200],
    finished: true,
    routing: "continue",
    startedAt: 480,
    endedAt: 500,
  };
  const asset = {
    id: 84,
    type: "script",
    sameOrigin: true,
    document: 1,
    path: "/_assets/index.js",
    status: 200,
    finished: true,
  };
  return {
    browser: "webkit",
    origin: "http://127.0.0.1:4097",
    assets: 2,
    checks: {
      initial: { history: true, rendered: true, finiteAPI: true },
      reload: { history: true, rendered: true, finiteAPI: true },
      assets: true,
    },
    diagnostics: {
      overflow: false,
      requests: [
        config,
        { ...config, id: 180, document: 2, startedAt: 1300, endedAt: 1350 },
        asset,
        { ...asset, id: 181, document: 2 },
      ],
      navigations: [
        {
          kind: "reload",
          fromDocument: 1,
          startedAt: 1000,
          committedAt: 1100,
          completedAt: 1200,
        },
      ],
      lifecycleEvents: [
        event("installed", oldTag, 1, 100, { phase: "initial:committed" }),
        event("fetch", oldTag, 2, 480, { ...target, phase: "initial:render" }),
        event("fetch", oldTag, 3, 1010, target),
        event("pagehide", oldTag, 4, 1020, {
          persisted: false,
          afterPagehide: true,
        }),
        event("fetch", oldTag, 5, 1030, { ...target, afterPagehide: true }),
        event("installed", newTag, 1, 1110, { phase: "reload:committed" }),
        event("fetch", newTag, 2, 1300, { ...target, phase: "reload:render" }),
      ],
      pageErrors: [1011, 1031].map((at) => ({
        at,
        document: 1,
        phase: "reload:navigation",
        requestIds: [83],
        message:
          "/127.0.0.1:4097/api/config?[query redacted] due to access control checks.",
      })),
    },
  };
}

test("only the fully evidenced WebKit engine pair is classified; input errors are preserved", () => {
  const proof = teardownProof();
  const original = structuredClone(proof);
  const classified = classifyWebKitTeardown(proof);
  assert.equal(classified.length, 2);
  assert.deepEqual(
    classified.map((entry) => entry.fetchSequence),
    [3, 5],
  );
  assert.deepEqual(
    classified.map((entry) => entry.afterPagehide),
    [false, true],
  );
  assert.ok(
    classified.every(
      (entry) =>
        entry.proofRun === "35694815360" &&
        entry.classification === "webkit-config-reload-engine-diagnostic",
    ),
  );
  assert.deepEqual(
    proof,
    original,
    "classification does not mutate or delete errors",
  );
});

test("WebKit classification fails closed across missing evidence and unrelated-error matrix", (t) => {
  const mutations = [
    [
      "additional config network attempt",
      (p) => {
        p.diagnostics.requests.push({ ...p.diagnostics.requests[0], id: 999 });
      },
    ],
    [
      "additional cancelled config network attempt",
      (p) => {
        p.diagnostics.requests.push({
          ...p.diagnostics.requests[0],
          id: 999,
          failure: "cancelled",
          status: null,
          responseStatuses: [],
        });
      },
    ],
    [
      "Chromium",
      (p) => {
        p.browser = "chromium";
      },
    ],
    [
      "Firefox",
      (p) => {
        p.browser = "firefox";
      },
    ],
    [
      "unknown browser",
      (p) => {
        delete p.browser;
      },
    ],
    [
      "external origin",
      (p) => {
        p.origin = "http://example.com";
      },
    ],
    [
      "wrong origin port",
      (p) => {
        p.origin = "http://127.0.0.1:4098";
      },
    ],
    [
      "missing checks",
      (p) => {
        delete p.checks;
      },
    ],
    [
      "no asset gate",
      (p) => {
        delete p.checks.assets;
      },
    ],
    [
      "failed asset gate",
      (p) => {
        p.checks.assets = false;
      },
    ],
    [
      "no assets",
      (p) => {
        p.assets = 0;
      },
    ],
    [
      "asset count mismatch",
      (p) => {
        p.assets = 3;
      },
    ],
    [
      "failed asset HTTP",
      (p) => {
        p.diagnostics.requests[2].status = 404;
      },
    ],
    [
      "unfinished asset",
      (p) => {
        p.diagnostics.requests[2].finished = false;
      },
    ],
    [
      "cancelled asset",
      (p) => {
        p.diagnostics.requests[2].failure = "cancelled";
      },
    ],
    [
      "overflow/decode error",
      (p) => {
        p.diagnostics.overflow = true;
      },
    ],
    [
      "unknown overflow",
      (p) => {
        delete p.diagnostics.overflow;
      },
    ],
    [
      "no diagnostics",
      (p) => {
        delete p.diagnostics;
      },
    ],
    [
      "no page error",
      (p) => {
        p.diagnostics.pageErrors = [];
      },
    ],
    [
      "only one error",
      (p) => {
        p.diagnostics.pageErrors.pop();
      },
    ],
    [
      "extra unrelated error",
      (p) => {
        p.diagnostics.pageErrors.push({ message: "unrelated failure" });
      },
    ],
    [
      "missing error message",
      (p) => {
        delete p.diagnostics.pageErrors[0].message;
      },
    ],
    [
      "random message",
      (p) => {
        p.diagnostics.pageErrors[0].message =
          "random due to access control checks.";
      },
    ],
    [
      "wrong error endpoint",
      (p) => {
        p.diagnostics.pageErrors[0].message =
          p.diagnostics.pageErrors[0].message.replace("/config", "/model");
      },
    ],
    [
      "extra message suffix",
      (p) => {
        p.diagnostics.pageErrors[0].message += " another error";
      },
    ],
    [
      "different provider in message",
      (p) => {
        p.diagnostics.pageErrors[0].message =
          p.diagnostics.pageErrors[0].message.replace(
            "127.0.0.1:4097",
            "provider.example",
          );
      },
    ],
    [
      "missing URL correlation",
      (p) => {
        p.diagnostics.pageErrors[0].requestIds = [];
      },
    ],
    [
      "wrong URL correlation",
      (p) => {
        p.diagnostics.pageErrors[0].requestIds = [999];
      },
    ],
    [
      "ambiguous URL correlation",
      (p) => {
        p.diagnostics.pageErrors[0].requestIds.push(180);
      },
    ],
    [
      "new-document error",
      (p) => {
        p.diagnostics.pageErrors[0].document = 2;
      },
    ],
    [
      "error outside reload phase",
      (p) => {
        p.diagnostics.pageErrors[0].phase = "initial:render";
      },
    ],
    [
      "error at reload start",
      (p) => {
        p.diagnostics.pageErrors[0].at = 1000;
      },
    ],
    [
      "error at commit",
      (p) => {
        p.diagnostics.pageErrors[1].at = 1100;
      },
    ],
    [
      "error before invocation",
      (p) => {
        p.diagnostics.pageErrors[0].at = 1009;
      },
    ],
    [
      "ambiguous preceding invocation",
      (p) => {
        p.diagnostics.pageErrors[0].at = 1030;
      },
    ],
    [
      "missing error time",
      (p) => {
        delete p.diagnostics.pageErrors[0].at;
      },
    ],
    [
      "no reload",
      (p) => {
        p.diagnostics.navigations = [];
      },
    ],
    [
      "duplicate reload",
      (p) => {
        p.diagnostics.navigations.push({ ...p.diagnostics.navigations[0] });
      },
    ],
    [
      "transition over 1000ms",
      (p) => {
        p.diagnostics.navigations[0].committedAt = 2001;
      },
    ],
    [
      "zero transition",
      (p) => {
        p.diagnostics.navigations[0].committedAt = 1000;
      },
    ],
    [
      "missing commit",
      (p) => {
        delete p.diagnostics.navigations[0].committedAt;
      },
    ],
    [
      "invalid completion",
      (p) => {
        p.diagnostics.navigations[0].completedAt = 1099;
      },
    ],
    [
      "wrong old document",
      (p) => {
        p.diagnostics.navigations[0].fromDocument = 2;
      },
    ],
    [
      "no old observer installation",
      (p) => {
        p.diagnostics.lifecycleEvents.shift();
      },
    ],
    [
      "no new observer installation",
      (p) => {
        p.diagnostics.lifecycleEvents.splice(5, 1);
      },
    ],
    [
      "new observer installed before commit",
      (p) => {
        p.diagnostics.lifecycleEvents[5].receivedAt = 1099;
      },
    ],
    [
      "late new observer installation",
      (p) => {
        p.diagnostics.lifecycleEvents[5].receivedAt = 1201;
      },
    ],
    [
      "missing observer sequence",
      (p) => {
        delete p.diagnostics.lifecycleEvents[2].sequence;
      },
    ],
    [
      "observer sequence gap",
      (p) => {
        p.diagnostics.lifecycleEvents[2].sequence = 4;
      },
    ],
    [
      "bad document tag",
      (p) => {
        p.diagnostics.lifecycleEvents[2].documentTag = "unknown";
      },
    ],
    [
      "wrong observed document",
      (p) => {
        p.diagnostics.lifecycleEvents[2].observedDocument = 2;
      },
    ],
    [
      "unknown observer kind",
      (p) => {
        p.diagnostics.lifecycleEvents[2].kind = "unknown";
      },
    ],
    [
      "unknown observer summary",
      (p) => {
        p.diagnostics.lifecycleEvents[2].summaryUnavailable = true;
      },
    ],
    [
      "unknown fetch target",
      (p) => {
        p.diagnostics.lifecycleEvents[2].targetUnavailable = true;
      },
    ],
    [
      "invalid observer clock",
      (p) => {
        p.diagnostics.lifecycleEvents[2].at = NaN;
      },
    ],
    [
      "missing observer receipt",
      (p) => {
        delete p.diagnostics.lifecycleEvents[2].receivedAt;
      },
    ],
    [
      "observer clock reverses",
      (p) => {
        p.diagnostics.lifecycleEvents[2].at = 1;
      },
    ],
    [
      "null observer event",
      (p) => {
        p.diagnostics.lifecycleEvents[2] = null;
      },
    ],
    [
      "no pagehide",
      (p) => {
        p.diagnostics.lifecycleEvents.splice(3, 1);
      },
    ],
    [
      "pagehide outside transition",
      (p) => {
        p.diagnostics.lifecycleEvents[3].receivedAt = 1100;
      },
    ],
    [
      "BFCache pagehide",
      (p) => {
        p.diagnostics.lifecycleEvents[3].persisted = true;
      },
    ],
    [
      "missing persisted evidence",
      (p) => {
        delete p.diagnostics.lifecycleEvents[3].persisted;
      },
    ],
    [
      "no post-pagehide fetch",
      (p) => {
        p.diagnostics.lifecycleEvents.splice(4, 1);
      },
    ],
    [
      "unknown hidden state",
      (p) => {
        delete p.diagnostics.lifecycleEvents[4].afterPagehide;
      },
    ],
    [
      "contradictory hidden state",
      (p) => {
        p.diagnostics.lifecycleEvents[4].afterPagehide = false;
      },
    ],
    [
      "wrong fetch endpoint",
      (p) => {
        p.diagnostics.lifecycleEvents[4].path = "/api/model";
      },
    ],
    [
      "external fetch",
      (p) => {
        p.diagnostics.lifecycleEvents[4].sameOrigin = false;
      },
    ],
    [
      "wrong fetch directory",
      (p) => {
        p.diagnostics.lifecycleEvents[4].directoryMatches = false;
      },
    ],
    [
      "wrong fetch query",
      (p) => {
        p.diagnostics.lifecycleEvents[4].queryKeys = ["directory"];
      },
    ],
    [
      "wrong fetch phase",
      (p) => {
        p.diagnostics.lifecycleEvents[4].phase = "reload:render";
      },
    ],
    [
      "fetch at transition start",
      (p) => {
        p.diagnostics.lifecycleEvents[2].receivedAt = 1000;
      },
    ],
    [
      "extra transition fetch",
      (p) => {
        p.diagnostics.lifecycleEvents.splice(5, 0, {
          ...p.diagnostics.lifecycleEvents[4],
          sequence: 6,
          at: 1040,
          receivedAt: 1040,
        });
      },
    ],
    [
      "no HTTP before",
      (p) => {
        p.diagnostics.requests.shift();
      },
    ],
    [
      "no HTTP after",
      (p) => {
        p.diagnostics.requests.splice(1, 1);
      },
    ],
    [
      "config HTTP 401",
      (p) => {
        p.diagnostics.requests[0].status = 401;
      },
    ],
    [
      "config HTTP 403",
      (p) => {
        p.diagnostics.requests[1].status = 403;
      },
    ],
    [
      "config earlier auth rejection",
      (p) => {
        p.diagnostics.requests[0].responseStatuses = [401, 200];
      },
    ],
    [
      "config non-200 success",
      (p) => {
        p.diagnostics.requests[1].status = 201;
      },
    ],
    [
      "config not finished",
      (p) => {
        p.diagnostics.requests[0].finished = false;
      },
    ],
    [
      "config cancellation",
      (p) => {
        p.diagnostics.requests[0].failedAt = 500;
      },
    ],
    [
      "config failed despite 200",
      (p) => {
        p.diagnostics.requests[0].failure = "cancelled";
      },
    ],
    [
      "config blocked by harness",
      (p) => {
        p.diagnostics.requests[0].routing = "blocked-origin";
      },
    ],
    [
      "config wrong method",
      (p) => {
        p.diagnostics.requests[0].method = "POST";
      },
    ],
    [
      "config wrong directory",
      (p) => {
        p.diagnostics.requests[0].directoryMatches = false;
      },
    ],
    [
      "config cross-origin",
      (p) => {
        p.diagnostics.requests[0].sameOrigin = false;
      },
    ],
    [
      "config wrong key",
      (p) => {
        p.diagnostics.requests[1].key = "b".repeat(16);
      },
    ],
    [
      "config key missing",
      (p) => {
        delete p.diagnostics.requests[0].key;
      },
    ],
    [
      "config statuses missing",
      (p) => {
        delete p.diagnostics.requests[0].responseStatuses;
      },
    ],
    [
      "config statuses malformed",
      (p) => {
        p.diagnostics.requests[0].responseStatuses = {};
      },
    ],
    [
      "config statuses empty",
      (p) => {
        p.diagnostics.requests[0].responseStatuses = [];
      },
    ],
    [
      "config before still in flight",
      (p) => {
        p.diagnostics.requests[0].endedAt = 1000;
      },
    ],
    [
      "config after started before commit",
      (p) => {
        p.diagnostics.requests[1].startedAt = 1099;
      },
    ],
    [
      "config end time missing",
      (p) => {
        delete p.diagnostics.requests[0].endedAt;
      },
    ],
    [
      "actual JavaScript error",
      (p) => {
        p.diagnostics.lifecycleEvents.push({
          kind: "window-error",
          javascriptErrorEvent: true,
        });
      },
    ],
    [
      "unknown window error",
      (p) => {
        p.diagnostics.lifecycleEvents.push({ kind: "window-error" });
      },
    ],
    [
      "actual unhandled rejection",
      (p) => {
        p.diagnostics.lifecycleEvents.push({ kind: "unhandled-rejection" });
      },
    ],
  ];
  for (const stage of ["initial", "reload"])
    for (const check of ["history", "rendered", "finiteAPI"])
      mutations.push([
        `missing ${stage} ${check}`,
        (p) => {
          delete p.checks[stage][check];
        },
      ]);
  for (const key of [
    "requests",
    "pageErrors",
    "lifecycleEvents",
    "navigations",
  ])
    mutations.push([
      `missing ${key}`,
      (p) => {
        delete p.diagnostics[key];
      },
    ]);
  for (const [label, mutate] of mutations) {
    const proof = teardownProof();
    mutate(proof);
    assert.deepEqual(classifyWebKitTeardown(proof), [], label);
  }
  t.diagnostic(`${mutations.length} negative evidence variants rejected`);
});

test("pairing is bounded to 100ms and transition to 1000ms, inclusively", () => {
  const proof = teardownProof();
  Object.assign(proof.diagnostics.navigations[0], {
    committedAt: 2000,
    completedAt: 2100,
  });
  proof.diagnostics.lifecycleEvents[5].receivedAt = 2010;
  proof.diagnostics.lifecycleEvents[6].receivedAt = 2200;
  Object.assign(proof.diagnostics.requests[1], {
    startedAt: 2200,
    endedAt: 2250,
  });
  proof.diagnostics.pageErrors[1].at = 1130;
  assert.equal(classifyWebKitTeardown(proof).length, 2);
  proof.diagnostics.pageErrors[1].at = 1131;
  assert.deepEqual(classifyWebKitTeardown(proof), []);
});

test("manifest HTTP 401 and resource errors remain separate; JS errors fail without pageerrors", () => {
  const proof = teardownProof();
  proof.diagnostics.requests.push({
    id: 99,
    path: "/site.webmanifest",
    status: 401,
  });
  proof.diagnostics.lifecycleEvents.push({
    ...proof.diagnostics.lifecycleEvents.at(-1),
    kind: "window-error",
    sequence: 3,
    at: 1400,
    receivedAt: 1400,
    javascriptErrorEvent: false,
  });
  assert.equal(classifyWebKitTeardown(proof).length, 2);
  assert.equal(hasJavaScriptFailure(proof.diagnostics.lifecycleEvents), false);
  proof.diagnostics.pageErrors = [];
  proof.diagnostics.lifecycleEvents.at(-1).javascriptErrorEvent = true;
  assert.equal(hasJavaScriptFailure(proof.diagnostics.lifecycleEvents), true);
  assert.deepEqual(classifyWebKitTeardown(proof), []);
  assert.equal(hasJavaScriptFailure([{ kind: "unhandled-rejection" }]), true);
});

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

test("browser gate retains JS and unclassified page errors and runs after native DB gates", async () => {
  const browser = await readFile(
    new URL("./browser.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    browser,
    /if \(diagnostics\.pageErrors\.length !== classified\.length\)\s*throw Error/,
  );
  assert.match(
    browser,
    /if \(hasJavaScriptFailure\(diagnostics\.lifecycleEvents\)\)\s*throw Error/,
  );
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

test("policy wire requires exactly one encoding layer and byte-exact original JSON text", () => {
  const raw = JSON.stringify(
    {
      claims: [
        { segments: [{ source_id: SOURCE.id, segment_id: "actual-citation" }] },
      ],
    },
    null,
    2,
  );
  assert.deepEqual(toolResult({ content: raw }), JSON.parse(raw));
  assert.deepEqual(
    toolResult({ content: JSON.stringify(raw) }, true, raw),
    JSON.parse(raw),
  );
  for (const content of [
    raw,
    JSON.stringify(JSON.stringify(raw)),
    JSON.stringify(JSON.stringify(JSON.parse(raw))),
    '"{}"',
  ])
    assert.throws(() => toolResult({ content }, true, raw));
  assert.throws(() => toolResult({ content: JSON.stringify(raw) }, false, raw));
  assert.throws(() =>
    toolResult({ content: JSON.stringify(JSON.stringify(raw)) }, true),
  );
  assert.throws(() =>
    toolResult({ content: JSON.stringify({ changed: true }) }, false, raw),
  );
});

test("OpenRouter Google roundtrip preserves braces, refs, nested JSON and rejects changed source", () => {
  const citation = { source_id: SOURCE.id, segment_id: "wire-citation" };
  const raw = [
    JSON.stringify({ claims: [{ segments: [citation] }] }),
    JSON.stringify({
      source_id: SOURCE.id,
      messages: [{ text: POLICY_SEED_TEXT }],
      verification: "deterministic segment ID",
    }),
  ];
  assert.ok(POLICY_SEED_TEXT.includes("PREFIX{}SUFFIX"));
  assert.ok(POLICY_SEED_TEXT.includes('"$ref"'));
  const body = {
    model: "google/fixture-model",
    stream: true,
    tools: ["memory_search", "memory_read_segment"].map((name) => ({
      type: "function",
      function: { name },
    })),
    messages: [],
  };
  const options = { policyEnabled: true, originals: raw };
  assert.equal(completionTurn(body, options).name, "memory_search");
  body.messages.push({ role: "tool", content: JSON.stringify(raw[0]) });
  assert.deepEqual(completionTurn(body, options), {
    name: "memory_read_segment",
    arguments: citation,
  });
  body.messages.push({
    role: "tool",
    content: [{ type: "text", text: JSON.stringify(raw[1]) }],
  });
  assert.deepEqual(completionTurn(body, options), { text: MARKER });
  assert.throws(() => completionTurn(body));
  assert.throws(() =>
    completionTurn({ ...body, model: "fixture-model" }, options),
  );
  assert.throws(() => completionTurn({ ...body, stream: false }, options));
  assert.throws(() => completionTurn({ ...body, tools: [] }, options));
  for (const text of [
    SEED_TEXT,
    JSON.stringify(POLICY_SEED_TEXT),
    POLICY_SEED_TEXT.replace("PREFIX{}SUFFIX", "{}"),
  ]) {
    const changed = JSON.stringify({
      source_id: SOURCE.id,
      messages: [{ text }],
      verification: "deterministic segment ID",
    });
    const changedBody = {
      ...body,
      messages: [
        body.messages[0],
        { role: "tool", content: JSON.stringify(changed) },
      ],
    };
    assert.throws(
      () => completionTurn(changedBody, { policyEnabled: true }),
      /not verified/,
    );
    assert.throws(() => completionTurn(changedBody, options), /differs/);
  }
  for (const content of [raw[1], JSON.stringify(JSON.stringify(raw[1]))])
    assert.throws(() =>
      completionTurn(
        { ...body, messages: [body.messages[0], { role: "tool", content }] },
        options,
      ),
    );
  assert.equal(
    completionChunks({ text: MARKER }, 3, body.model)[0].model,
    body.model,
  );
});

test("native refusal evidence requires the direct durable event and the specific policy reason", () => {
  // 7673 schema/event.ts + session-event.ts Execution.Failed, emitted directly
  // by HttpApi StreamSse(data), not the SDK's client-side event wrapper.
  const sessionID = "synthetic-session";
  const expected =
    "Reflection: user policy instructions unavailable; request blocked";
  const failure = {
    id: "event-fixture",
    type: "session.execution.failed",
    created: 1,
    durable: { aggregateID: sessionID, seq: 4, version: 1 },
    data: { sessionID, error: { type: "unknown", message: expected } },
  };
  const sse = (event, name = "message") =>
    `event: ${name}\ndata: ${JSON.stringify(event)}\n\n`;
  const marker = sse({ type: "log.synced", aggregateID: sessionID, seq: 4 });
  const positive = policyRefusalEvidence(
    sse(failure) + marker,
    sessionID,
    expected,
  );
  assert.equal(positive.matched, true);
  assert.equal(positive.events[0].errorType, "unknown");
  assert.equal(
    positive.nativeOutputExpectedReason,
    false,
    "log output is not required or sufficient proof",
  );
  assert.equal(
    policyRefusalEvidence(
      (sse(failure) + marker).replaceAll("\n", "\r\n"),
      sessionID,
      expected,
    ).matched,
    true,
  );
  for (const mutate of [
    (e) => {
      e.type = "session.execution.succeeded";
    },
    (e) => {
      e.type = "session.execution.interrupted";
    },
    (e) => {
      e.data.sessionID = "other-session";
    },
    (e) => {
      e.durable.aggregateID = "other-session";
    },
    (e) => {
      delete e.durable;
    },
    (e) => {
      e.durable.version = 2;
    },
    (e) => {
      e.durable.seq = -1;
    },
    (e) => {
      e.data.error.type = "provider.auth";
    },
    (e) => {
      e.data.error.message = "Unrelated failure";
    },
    (e) => {
      e.data.error.message = "Reflection: user policy forbids selected model";
    },
    (e) => {
      e.data.error.message =
        "Reflection: operation failed validation or is unavailable; no native fallback";
    },
    (e) => {
      delete e.data.error;
    },
  ]) {
    const changed = structuredClone(failure);
    mutate(changed);
    assert.equal(
      policyRefusalEvidence(sse(changed), sessionID, expected, expected)
        .matched,
      false,
    );
  }
  const wrapped = policyRefusalEvidence(
    sse({ data: failure }),
    sessionID,
    expected,
    expected,
  );
  assert.equal(wrapped.matched, false);
  assert.equal(wrapped.events[0].nestedEventType, true);
  assert.equal(wrapped.nativeOutputExpectedReason, true);
  for (const extra of [
    sse(failure),
    sse({ ...failure, type: "session.execution.succeeded" }),
    "data: not-json\n\n",
    sse({}, "effect/httpapi/stream/failure"),
  ])
    assert.equal(
      policyRefusalEvidence(sse(failure) + extra, sessionID, expected).matched,
      false,
    );
  assert.equal(
    policyRefusalEvidence("", sessionID, expected, expected).matched,
    false,
  );
  assert.equal(
    policyRefusalEvidence(sse(failure), sessionID, "").matched,
    false,
  );
});

test("global SSE scopes refusal proof to the requested session without accepting wrong terminals", () => {
  const id = "requested-session";
  const expected =
    "Reflection: user policy instructions unavailable; request blocked";
  const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;
  const connected = frame({
    id: "connected-event",
    type: "server.connected",
    data: {},
  });
  const failure = {
    id: "failure-event",
    created: 1,
    type: "session.execution.failed",
    durable: { aggregateID: id, version: 1, seq: 5 },
    data: { sessionID: id, error: { type: "unknown", message: expected } },
  };
  const other = structuredClone(failure);
  other.durable.aggregateID = "unrelated-session";
  other.data.sessionID = "unrelated-session";
  other.data.error.message = "unrelated-secret-message";
  const background =
    frame(other) + frame({ ...other, type: "session.execution.succeeded" });
  const text = connected + background + frame(failure) + background;
  const result = policyGlobalRefusalEvidence(text, id, expected);
  assert.equal(result.connected, true);
  assert.equal(result.ignoredEvents, 4);
  assert.equal(result.terminal.terminalCount, 1);
  assert.equal(result.terminal.matched, true);
  assert.doesNotMatch(
    JSON.stringify(result),
    /requested-session|unrelated-|Reflection:/,
  );
  assert.equal(
    policyGlobalRefusalEvidence(text.replaceAll("\n", "\r\n"), id, expected)
      .terminal.matched,
    true,
  );
  assert.equal(
    policyGlobalRefusalEvidence(
      connected + frame(failure).slice(0, -1),
      id,
      expected,
    ).terminal.matched,
    false,
    "partial frame is not proof",
  );
  assert.equal(
    policyGlobalRefusalEvidence(frame(failure), id, expected).terminal.matched,
    false,
    "handshake required",
  );
  assert.equal(
    policyGlobalRefusalEvidence(connected + background, id, expected).terminal
      .terminalCount,
    0,
  );
  for (const mutate of [
    (e) => {
      e.type = "session.execution.succeeded";
    },
    (e) => {
      e.type = "session.execution.interrupted";
    },
    (e) => {
      e.data.error.message = "unrelated reason";
    },
    (e) => {
      e.data.error.type = "provider.auth";
    },
    (e) => {
      e.durable.aggregateID = "wrong";
    },
    (e) => {
      e.data.sessionID = "wrong";
    },
    (e) => {
      e.durable.version = 2;
    },
    (e) => {
      e.durable.seq = "5";
    },
  ]) {
    const changed = structuredClone(failure);
    mutate(changed);
    const failed = policyGlobalRefusalEvidence(
      connected + background + frame(changed),
      id,
      expected,
    );
    assert.equal(
      failed.terminal.terminalCount,
      1,
      "malformed target terminals must not be ignored",
    );
    assert.equal(failed.terminal.matched, false);
  }
  for (const extra of [
    frame(failure),
    frame({ ...failure, type: "session.execution.succeeded" }),
    "data: invalid\n\n",
    "event: effect/httpapi/stream/failure\ndata: {}\n\n",
  ])
    assert.equal(
      policyGlobalRefusalEvidence(
        connected + frame(failure) + extra,
        id,
        expected,
      ).terminal.matched,
      false,
    );
  const capped = policyGlobalRefusalEvidence(
    connected + frame(other).repeat(128) + frame(failure),
    id,
    expected,
  );
  assert.equal(
    capped.overflow,
    true,
    "global event budget includes unrelated sessions",
  );
  assert.equal(capped.terminal.matched, false);
  assert.equal(
    policyGlobalRefusalEvidence("x".repeat(256 * 1024 + 1), id, expected)
      .overflow,
    true,
  );
});

test("refusal diagnostics are bounded and never include raw error, instruction, credential or ID values", () => {
  const privateText = "Bearer private-key private-instruction private-session";
  const event = {
    type: "arbitrary-private-type",
    data: {
      sessionID: "private-session",
      error: { type: privateText, message: privateText, status: privateText },
      [privateText]: privateText,
    },
  };
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  const summary = policyRefusalEvidence(
    frame.repeat(129),
    "private-session",
    "expected-policy-error",
    privateText,
  );
  assert.equal(summary.overflow, true);
  assert.equal(summary.matched, false);
  assert.equal(summary.events.length, 8);
  assert.doesNotMatch(JSON.stringify(summary), /private-|Bearer|arbitrary-/);
  assert.equal(summary.events[0].errorType, "other");
  assert.equal(summary.events[0].status, null);
  assert.equal(
    policyRefusalEvidence("x".repeat(256 * 1024 + 1), "id", "expected")
      .overflow,
    true,
  );
  const malformed = policyRefusalEvidence(
    `data: ${privateText}\n\n`,
    "id",
    "expected",
  );
  assert.equal(malformed.malformed, 1);
  assert.doesNotMatch(JSON.stringify(malformed), /private-|Bearer/);
});

test("source forwarding cannot target remote hosts and policy gate is mandatory before port reuse", async () => {
  const fixture = createReflectionFixture();
  assert.throws(() => fixture.setNative("https://example.com", "fixture-only"));
  await fixture.close();
  const runner = await readFile(new URL("./run.mjs", import.meta.url), "utf8");
  const policyPhase = runner.search(/await phase\(\s*"opt-in user policy/);
  assert.ok(
    policyPhase >
      runner.indexOf(
        '"pluginInitialization and actual native memory toolchain"',
      ),
  );
  assert.ok(
    policyPhase < runner.indexOf('"independent baseline then port collision'),
  );
  assert.match(runner, /policyEnabled: true,\s*readOriginals: originals/);
  assert.match(runner, /if \(policyServer\) await terminate\(policyServer\)/);
  assert.match(runner, /await policyFixture\.close\(\)/);
  assert.match(runner, /baselineProviderRequests: 3/);
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
