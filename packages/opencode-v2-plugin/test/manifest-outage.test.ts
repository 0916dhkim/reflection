import type { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { Message } from "@opencode/ai";
import { afterEach, expect, it, vi } from "vitest";
import { setup } from "../src/index.js";
import {
  parseNativeSegmentCreate,
  nativeSegmentIdForRequest,
  nativeSourceFingerprint,
} from "@reflection/shared/native";
import { canonicalizeNativeHistory } from "@reflection/opencode-v2-core/history";
import { planNativeSegments } from "@reflection/opencode-v2-core/segmentation";
import {
  checkpoint,
  checkpointSchemaJson,
  materializedTokens,
} from "../src/projection.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () =>
    JSON.stringify({
      url: "http://reflection.invalid",
      apiKey: "secret",
      sourceId: "native",
      sources: {
        native: { kind: "opencode-v2", url: "http://native.invalid" },
      },
      contextProjection: { enabled: true },
    }),
  ),
}));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fixture(
  mode:
    | "503"
    | "timeout"
    | "wrong-source"
    | "malformed"
    | "json"
    | "retry-503"
    | "verified"
    | "gateway-404"
    | "app-404",
  large = false,
  output = 4000,
) {
  let context!: (event: SessionContext) => Promise<void>;
  const storage = new Map<string, unknown>();
  const longText = "x".repeat(50000);
  let failedJob: unknown;
  let manifestResponses: unknown[] = [];
  const history = large
    ? [
        { id: "old", type: "user", text: "old", time: { created: 1 } },
        {
          id: "answer",
          type: "assistant",
          agent: "build",
          model: { id: "small", providerID: "test" },
          content: [{ type: "text", text: longText }],
          time: { created: 2, completed: 3 },
        },
        { id: "latest", type: "user", text: "latest", time: { created: 4 } },
      ]
    : [{ id: "latest", type: "user", text: "latest", time: { created: 4 } }];
  const fetch = vi.fn(async (input: URL, init: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/v1/sources/native")
      return Response.json({
        id: "native",
        kind: "opencode-v2",
        identity_scheme: "source-v1",
      });
    if (path === "/api/session/s")
      return Response.json({
        data: {
          id: "s",
          time: { updated: 4 },
          location: { directory: "/work" },
        },
      });
    if (path === "/api/session/active")
      return Response.json({ data: { s: { type: "busy" } } });
    if (path.endsWith("/message"))
      return Response.json({ data: history, cursor: {} });
    if (path === "/api/config") {
      expect([...url.searchParams.entries()]).toEqual([
        ["location[directory]", "/work"],
      ]);
      return Response.json([
        { type: "document", info: { compaction: { auto: false } } },
      ]);
    }
    if (mode === "verified") {
      if (path === "/v1/sessions/s/segments") {
        if (manifestResponses.length > 0) {
          const response = manifestResponses.shift();
          return typeof response === "number"
            ? new Response("unavailable", { status: response })
            : Response.json(response);
        }
        const planned = planNativeSegments({
          source: {
            id: "native",
            kind: "opencode-v2",
            identity_scheme: "source-v1",
          },
          sessionId: "s",
          records: canonicalizeNativeHistory(history),
        });
        const ranges = planned.map((segment) => ({
          id: segment.id,
          source_boundary_version: 3,
          start_source_message_id: segment.request.start_source_message_id,
          end_source_message_id: segment.request.end_source_message_id,
          projection_version: 3,
        }));
        return Response.json({
          source_id: "native",
          session_id: "s",
          manifest_version: 3,
          boundaries: [],
          targets: ranges.map((range, i) => ({
            ...range,
            source_fingerprint: planned[i]!.fingerprint,
            status: "succeeded",
          })),
          segments: ranges.map((range) => ({
            ...range,
            summary: `VERIFIED_NATIVE_SUMMARY_${range.id}`,
          })),
        });
      }
      if (path === "/v1/segments") {
        const request = parseNativeSegmentCreate(JSON.parse(String(init.body)));
        return Response.json({
          id: 1,
          source_id: "native",
          segment_id: nativeSegmentIdForRequest(request, {
            id: "native",
            kind: "opencode-v2",
            identity_scheme: "source-v1",
          }),
          source_boundary_version: 3,
          start_source_message_id: request.start_source_message_id,
          end_source_message_id: request.end_source_message_id,
          projection_version: 3,
          source_fingerprint: nativeSourceFingerprint(request),
          status: "succeeded",
          attempts: 1,
          error: null,
          created_at: "now",
          started_at: "start",
          finished_at: "finish",
          next_attempt_at: "now",
        });
      }
    }
    if (mode === "retry-503") {
      if (path === "/v1/sessions/s/segments")
        return Response.json({
          source_id: "native",
          session_id: "s",
          manifest_version: 3,
          segments: [],
          boundaries: [],
          targets: [],
        });
      if (path === "/v1/segments") {
        const request = parseNativeSegmentCreate(JSON.parse(String(init.body)));
        failedJob = {
          id: 1,
          source_id: "native",
          segment_id: nativeSegmentIdForRequest(request, {
            id: "native",
            kind: "opencode-v2",
            identity_scheme: "source-v1",
          }),
          source_boundary_version: 3,
          start_source_message_id: request.start_source_message_id,
          end_source_message_id: request.end_source_message_id,
          projection_version: 3,
          source_fingerprint: nativeSourceFingerprint(request),
          status: "failed",
          attempts: 1,
          error: null,
          created_at: "now",
          started_at: "old",
          finished_at: "old-finish",
          next_attempt_at: "now",
        };
        return Response.json(failedJob);
      }
      if (path.endsWith("/retry"))
        return new Response("unavailable", { status: 503 });
      expect(path).toBe("/v1/jobs/1");
      expect(url.searchParams.get("source_id")).toBe("native");
      return Response.json(failedJob);
    }
    if (mode === "503")
      return new Response("secret server body", { status: 503 });
    // Traefik answers with a plain-text 404 while the API container is replaced.
    if (mode === "gateway-404")
      return new Response("404 page not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    if (mode === "app-404")
      return Response.json({ detail: "Not Found" }, { status: 404 });
    if (mode === "timeout") {
      await new Promise<void>((_resolve, reject) =>
        init.signal!.addEventListener(
          "abort",
          () => reject(new Error("secret timeout")),
          { once: true },
        ),
      );
      throw new Error("unreachable");
    }
    if (mode === "json") return new Response("not json");
    return Response.json(
      mode === "malformed"
        ? {}
        : {
            source_id: "other",
            session_id: "s",
            manifest_version: 3,
            segments: [],
            boundaries: [],
            targets: [],
          },
    );
  });
  vi.stubGlobal("fetch", fetch);
  const ctx = {
    app: { name: "opencode", version: "2.0.8", channel: "latest" },
    options: { configPath: "/isolated/config.json" },
    location: { directory: "/work" },
    session: {
      hook: async (
        name: string,
        hook: (event: SessionContext) => Promise<void>,
      ) => {
        if (name === "context") context = hook;
        return { dispose: async () => {} };
      },
    },
    tool: { transform: async () => ({ dispose: async () => {} }) },
    model: {
      list: async () => ({
        location: { directory: "/work" },
        data: [
          {
            id: "small",
            providerID: "test",
            limit: { context: 20000, input: 16000, output },
          },
        ],
      }),
    },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value);
      },
      remove: async (key: string) => {
        storage.delete(key);
      },
    },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        if (!signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
      },
    },
  } as unknown as Plugin.Context;
  cleanups.push(await setup(ctx));
  const event = {
    sessionID: "s",
    agent: "build",
    model: { id: "small", providerID: "test" },
    options: {},
    system: [],
    tools: {},
    messages: [
      ...(large
        ? [
            Message.make({ id: "old", role: "user", content: "old" }),
            Message.make({
              id: "answer",
              role: "assistant",
              content: longText,
            }),
          ]
        : []),
      Message.make({ id: "latest", role: "user", content: "latest" }),
    ],
  } as unknown as SessionContext;
  return {
    context,
    event,
    storage,
    fetch,
    history,
    setMode: (next: typeof mode) => {
      mode = next;
    },
    setManifestResponses: (responses: unknown[]) => {
      manifestResponses = responses;
    },
  };
}
const nativeSource = {
  id: "native",
  kind: "opencode-v2" as const,
  identity_scheme: "source-v1" as const,
};
function anchoredManifest(
  segments: ReturnType<typeof planNativeSegments>,
  label: string,
) {
  const ranges = segments.map((segment) => ({
    id: segment.id,
    source_boundary_version: 3,
    projection_version: 3,
    start_source_message_id: segment.request.start_source_message_id,
    end_source_message_id: segment.request.end_source_message_id,
  }));
  return {
    source_id: "native",
    session_id: "s",
    manifest_version: 3,
    targets: [],
    boundaries: ranges.map((range, i) => ({
      ...range,
      source_eligible: true,
      source_fingerprint: segments[i]!.fingerprint,
    })),
    segments: ranges.map((range, i) => ({
      ...range,
      summary: `${label}_${i}`,
    })),
  };
}
async function frozenFixture() {
  const f = await fixture("verified", true, 15000);
  f.history[0]!.text = "x".repeat(1000);
  f.history[1]!.content = [{ type: "text", text: "y".repeat(18000) }];
  const originals = [
    Message.make({ id: "old", role: "user", content: f.history[0]!.text! }),
    Message.make({
      id: "answer",
      role: "assistant",
      content: "y".repeat(18000),
    }),
    Message.make({ id: "latest", role: "user", content: "latest" }),
  ];
  f.event.messages = [...originals];
  const records = canonicalizeNativeHistory(f.history);
  // These were two independent inactive open snapshots before later appends.
  const snapshots = [0, 1].map(
    (index) =>
      planNativeSegments({
        source: nativeSource,
        sessionId: "s",
        records: records.slice(index, index + 1),
        allowOpenSnapshot: true,
      })[0]!,
  );
  expect(
    snapshots.every(
      (segment) => !segment.closed && segment.weightedChars < 20000,
    ),
  ).toBe(true);
  expect(
    planNativeSegments({ source: nativeSource, sessionId: "s", records }),
  ).toEqual([]);
  const manifest = anchoredManifest(snapshots, "FROZEN_VERIFIED");
  f.setManifestResponses([manifest, manifest]);
  await f.context(f.event);
  const previous = checkpoint(
    f.storage.get("reflection-v2/checkpoint/2/native/s"),
    "native",
    "s",
  )!;
  expect(previous.archived.map((range) => range.id)).toEqual(
    snapshots.map((segment) => segment.id),
  );
  expect(previous.cachedSummaries).toHaveLength(2);
  expect(JSON.stringify(f.event.messages)).toContain("FROZEN_VERIFIED_0");
  expect(JSON.stringify(f.event.messages)).toContain("FROZEN_VERIFIED_1");
  return { ...f, originals, previous };
}
it("outage planning preserves two frozen underlimit ranges without treating hints as backend evidence", async () => {
  const f = await frozenFixture();
  f.setMode("503");
  f.event.messages = [...f.originals];
  await f.context(f.event);
  const retained = checkpoint(
    f.storage.get("reflection-v2/checkpoint/2/native/s"),
    "native",
    "s",
  )!;
  expect(retained.archived).toEqual(f.previous.archived);
  expect(retained.cachedSummaries).toEqual(f.previous.cachedSummaries);
  expect(JSON.stringify(f.event.messages)).toContain("FROZEN_VERIFIED_0");
  expect(JSON.stringify(f.event.messages)).toContain("FROZEN_VERIFIED_1");
  expect(JSON.stringify(f.event.messages)).not.toContain(
    "missing-or-stale-summary",
  );
  expect(f.event.messages.at(-1)).toBe(f.originals.at(-1));
  expect(
    materializedTokens(f.event.messages, f.event.system, f.event.tools),
  ).toBeLessThanOrEqual(4500);
  // Recovered authority merges the old frozen ranges. Local hints must not win.
  f.setMode("verified");
  const merged = planNativeSegments({
    source: nativeSource,
    sessionId: "s",
    records: canonicalizeNativeHistory(f.history).slice(0, 2),
    allowOpenSnapshot: true,
  });
  expect(merged).toHaveLength(1);
  const recovered = anchoredManifest(merged, "RECOVERED_MERGED");
  f.setManifestResponses([recovered, recovered]);
  f.event.messages = [...f.originals];
  await f.context(f.event);
  expect(JSON.stringify(f.event.messages)).toContain("RECOVERED_MERGED_0");
  expect(JSON.stringify(f.event.messages)).not.toContain("FROZEN_VERIFIED");
  expect(
    checkpoint(
      f.storage.get("reflection-v2/checkpoint/2/native/s"),
      "native",
      "s",
    )!.archived,
  ).toHaveLength(1);
});
it("frozen planning hints preserve boundaries but cannot reuse cached text after source changes", async () => {
  const f = await frozenFixture();
  f.setMode("503");
  f.history[1]!.content = [{ type: "text", text: "z".repeat(18000) }];
  f.event.messages = [...f.originals];
  f.event.messages[1] = Message.make({
    id: "answer",
    role: "assistant",
    content: "z".repeat(18000),
  });
  await f.context(f.event);
  expect(JSON.stringify(f.event.messages)).not.toContain("FROZEN_VERIFIED");
  expect(JSON.stringify(f.event.messages)).toContain(
    "missing-or-stale-summary",
  );
  expect(
    checkpoint(
      f.storage.get("reflection-v2/checkpoint/2/native/s"),
      "native",
      "s",
    )!.cachedSummaries,
  ).toEqual([]);
});
it.each([
  "id",
  "missing",
  "reordered",
  "overlapping",
  "foreign-source",
  "incomplete",
] as const)(
  "corrupt %s checkpoint hints cannot block fitting raw context or force archival",
  async (kind) => {
    const f = await frozenFixture();
    const corrupted = checkpointSchemaJson(f.previous);
    if (kind === "id")
      corrupted.archived[0]!.id = "11111111-1111-4111-8111-111111111111";
    if (kind === "missing")
      Object.assign(corrupted.archived[0]!, {
        start_source_message_id: "injected",
        end_source_message_id: "injected",
        source_message_ids: ["injected"],
      });
    if (kind === "reordered") corrupted.archived.reverse();
    if (kind === "overlapping")
      corrupted.archived[1] = {
        ...corrupted.archived[0]!,
        source_message_ids: [...corrupted.archived[0]!.source_message_ids],
      };
    if (kind === "foreign-source") corrupted.source_id = "injected-source";
    if (kind === "incomplete") f.history[1]!.time = { created: 2 };
    f.storage.set("reflection-v2/checkpoint/2/native/s", corrupted);
    f.setMode("503");
    f.event.messages = [...f.originals];
    f.event.options.maxTokens = 0;
    await f.context(f.event);
    f.event.messages.forEach((message, i) =>
      expect(message).toBe(f.originals[i]),
    );
    expect(f.event.messages).toHaveLength(3);
    expect(f.storage.has("reflection-v2/checkpoint/2/native/s")).toBe(false);
    expect(JSON.stringify(f.event.messages)).not.toContain("injected");
    expect(
      f.fetch.mock.calls.every(([url]) => !String(url).includes("injected")),
    ).toBe(true);
  },
);
it("persists a strict version-2 cache and retains verified summaries plus the raw latest user during outage", async () => {
  const { context, event, history, storage, setMode } = await fixture(
    "verified",
    true,
  );
  const originals = [...event.messages];
  await context(event);
  const stored = storage.get("reflection-v2/checkpoint/2/native/s");
  const previous = checkpoint(stored, "native", "s");
  expect(previous?.version).toBe(2);
  expect(previous!.archived.length).toBeGreaterThan(0);
  expect(previous!.cachedSummaries.length).toBeGreaterThan(0);
  expect(JSON.stringify(event.messages)).toContain("VERIFIED_NATIVE_SUMMARY_");
  const serialized = checkpointSchemaJson(previous!);
  expect(JSON.parse(JSON.stringify(serialized))).toEqual(stored);
  expect(serialized.cachedSummaries).not.toBe(previous!.cachedSummaries);
  expect(serialized.cachedSummaries[0]).not.toBe(previous!.cachedSummaries[0]);
  expect(
    checkpoint({ ...serialized, version: 1 }, "native", "s"),
  ).toBeUndefined();
  expect(
    checkpoint(
      {
        ...serialized,
        cachedSummaries: [
          { ...serialized.cachedSummaries[0], projection_version: 2 },
        ],
      },
      "native",
      "s",
    ),
  ).toBeUndefined();
  expect(
    checkpoint(
      {
        ...serialized,
        cachedSummaries: [
          { ...serialized.cachedSummaries[0], unexpected: true },
        ],
      },
      "native",
      "s",
    ),
  ).toBeUndefined();
  setMode("503");
  event.messages = [...originals];
  await context(event);
  expect(event.messages.at(-1)).toBe(originals.at(-1));
  for (const summary of previous!.cachedSummaries)
    expect(JSON.stringify(event.messages)).toContain(summary.summary);
  expect(JSON.stringify(event.messages)).not.toContain(
    "missing-or-stale-summary",
  );
  expect(
    materializedTokens(event.messages, event.system, event.tools),
  ).toBeLessThanOrEqual(14400);
  history[0]!.text = "source changed";
  event.messages = [...originals];
  event.messages[0] = Message.make({
    id: "old",
    role: "user",
    content: "source changed",
  });
  await context(event);
  expect(JSON.stringify(event.messages)).not.toContain(
    "VERIFIED_NATIVE_SUMMARY_",
  );
  expect(JSON.stringify(event.messages)).toContain("missing-or-stale-summary");
});
it("outage extension retains verified old summaries and explicitly omits new archived ranges", async () => {
  const { context, event, history, storage, setMode } = await fixture(
    "verified",
    true,
  );
  const originals = [...event.messages];
  await context(event);
  const previous = checkpoint(
    storage.get("reflection-v2/checkpoint/2/native/s"),
    "native",
    "s",
  )!;
  const extra = "y".repeat(50000);
  history.push(
    {
      id: "answer2",
      type: "assistant",
      agent: "build",
      model: { id: "small", providerID: "test" },
      content: [{ type: "text", text: extra }],
      time: { created: 5, completed: 6 },
    },
    { id: "latest2", type: "user", text: "latest2", time: { created: 7 } },
  );
  const latest = Message.make({
    id: "latest2",
    role: "user",
    content: "latest2",
  });
  event.messages = [
    ...originals,
    Message.make({ id: "answer2", role: "assistant", content: extra }),
    latest,
  ];
  setMode("503");
  await context(event);
  expect(event.messages.at(-1)).toBe(latest);
  for (const summary of previous.cachedSummaries)
    expect(JSON.stringify(event.messages)).toContain(summary.summary);
  expect(JSON.stringify(event.messages)).toContain("missing-or-stale-summary");
  const extended = checkpoint(
    storage.get("reflection-v2/checkpoint/2/native/s"),
    "native",
    "s",
  )!;
  expect(extended.archived.length).toBeGreaterThan(previous.archived.length);
  expect(extended.cachedSummaries).toEqual(previous.cachedSummaries);
});
it("a changed cached summary without its matching fingerprint cannot supply outage context", async () => {
  const { context, event, storage, setMode } = await fixture("verified", true);
  const originals = [...event.messages];
  await context(event);
  const previous = checkpoint(
    storage.get("reflection-v2/checkpoint/2/native/s"),
    "native",
    "s",
  )!;
  storage.set("reflection-v2/checkpoint/2/native/s", {
    ...checkpointSchemaJson(previous),
    cachedSummaries: previous.cachedSummaries.map((summary) => ({
      ...summary,
      summary: "UNVERIFIED_CHANGED_SUMMARY",
    })),
  });
  setMode("503");
  event.messages = [...originals];
  await context(event);
  expect(JSON.stringify(event.messages)).not.toContain(
    "UNVERIFIED_CHANGED_SUMMARY",
  );
  expect(JSON.stringify(event.messages)).toContain("missing-or-stale-summary");
});
it.each([
  "outage",
  "available",
  "wrong-source",
  "malformed",
  "target-evidence",
] as const)(
  "refresh %s uses the current availability flag without ignoring authoritative evidence",
  async (mode) => {
    const { context, event, storage, setManifestResponses } = await fixture(
      "verified",
      true,
    );
    const originals = [...event.messages];
    await context(event);
    const previous = checkpoint(
      storage.get("reflection-v2/checkpoint/2/native/s"),
      "native",
      "s",
    )!;
    const empty = {
      source_id: "native",
      session_id: "s",
      manifest_version: 3,
      segments: [],
      boundaries: [],
      targets: [],
    };
    const evidence = {
      ...empty,
      targets: previous.cachedSummaries.map(
        ({ summary: _summary, ...cached }) => ({
          ...cached,
          source_boundary_version: 3,
          status: "pending",
        }),
      ),
    };
    setManifestResponses([
      mode === "target-evidence" ? evidence : empty,
      mode === "outage" || mode === "target-evidence"
        ? 503
        : mode === "available"
          ? empty
          : mode === "malformed"
            ? {}
            : { ...empty, source_id: "wrong" },
    ]);
    event.messages = [...originals];
    if (mode === "wrong-source" || mode === "malformed") {
      await expect(context(event)).rejects.toThrow("Reflection:");
      return;
    }
    await context(event);
    if (mode === "outage") {
      for (const summary of previous.cachedSummaries)
        expect(JSON.stringify(event.messages)).toContain(summary.summary);
      expect(JSON.stringify(event.messages)).not.toContain(
        "missing-or-stale-summary",
      );
    } else {
      expect(JSON.stringify(event.messages)).not.toContain(
        "VERIFIED_NATIVE_SUMMARY_",
      );
      expect(JSON.stringify(event.messages)).toContain(
        "missing-or-stale-summary",
      );
    }
  },
);
it("503 does not block tiny source-validated context or send a native checkpoint", async () => {
  const { context, event, fetch } = await fixture("503");
  const latest = event.messages[0];
  await context(event);
  expect(event.messages).toEqual([latest]);
  expect(
    fetch.mock.calls.filter(([url]) => String(url).includes("/v1/sources/")),
  ).toHaveLength(1);
});
it("a reverse-proxy 404 during a deploy degrades like an outage instead of blocking", async () => {
  const { context, event } = await fixture("gateway-404", true);
  const originals = [...event.messages];
  await context(event);
  expect(JSON.stringify(event.messages)).toContain("missing-or-stale-summary");
  expect(event.messages.at(-1)).toBe(originals.at(-1));
});
it("an application 404 envelope still fails closed with its HTTP status", async () => {
  const { context, event } = await fixture("app-404");
  await expect(context(event)).rejects.toThrow(
    "Reflection: endpoint rejected request (HTTP 404)",
  );
});
it("unavailable retry delivery remains explicit omissions rather than a hard projection failure", async () => {
  const { context, event, fetch } = await fixture("retry-503", true);
  const originals = [...event.messages];
  for (let i = 0; i < 2; i++) {
    event.messages = [...originals];
    event.options.maxTokens = i === 0 ? 4000 : 3000;
    await context(event);
    expect(JSON.stringify(event.messages)).toContain(
      "missing-or-stale-summary",
    );
  }
  expect(
    fetch.mock.calls.some(([input]) =>
      String(input).includes("/v1/jobs/1?source_id=native"),
    ),
  ).toBe(true);
});
it("request timeout does not block tiny context after registry validation", async () => {
  const { context, event } = await fixture("timeout");
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  const pending = context(event);
  await vi.advanceTimersByTimeAsync(5001);
  await pending;
  expect(event.messages).toHaveLength(1);
});
it.each(["wrong-source", "malformed", "json"] as const)(
  "%s manifest fails closed even for tiny context",
  async (mode) => {
    const { context, event } = await fixture(mode);
    await expect(context(event)).rejects.toThrow("Reflection:");
  },
);
it("503 projects closed source-safe segments with omissions and revalidates a previous checkpoint", async () => {
  const { context, event, history, storage } = await fixture("503", true);
  const originals = [...event.messages];
  await context(event);
  expect(JSON.stringify(event.messages)).toContain("missing-or-stale-summary");
  expect(event.messages.at(-1)).toBe(originals.at(-1));
  const first = JSON.stringify([...storage.values()]);
  history[0]!.text = "changed source";
  event.messages = [...originals];
  event.messages[0] = Message.make({
    id: "old",
    role: "user",
    content: "changed source",
  });
  await context(event);
  expect(JSON.stringify([...storage.values()])).not.toBe(first);
});
it("an impossible output reserve still throws explicitly during a Reflection outage", async () => {
  const { context, event } = await fixture("503", false, 20000);
  await expect(context(event)).rejects.toThrow("no usable input budget");
});
it("manifest outage never permits a projection that cannot safely fit the latest user", async () => {
  const { context, event, history } = await fixture("503");
  history[0]!.text = "x".repeat(50000);
  event.messages = [
    Message.make({ id: "latest", role: "user", content: history[0]!.text! }),
  ];
  await expect(context(event)).rejects.toThrow(
    "no source-safe native projection fits",
  );
});
