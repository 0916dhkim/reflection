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
    | "verified"
    | "gateway-404"
    | "app-404",
  large = false,
  output = 4000,
) {
  let context!: (event: SessionContext) => Promise<void>;
  const storage = new Map<string, unknown>();
  const longText = "x".repeat(50000);
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
  cleanups.push(await setup(ctx, ctx.storage));
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
    context: (value: SessionContext) => context(value),
    restart: async () => {
      await cleanups.pop()!();
      cleanups.push(await setup(ctx, ctx.storage));
    },
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
it("an outage keeps projecting with the last known summaries and cut", async () => {
  const { context, event, storage, setManifestResponses } = await fixture(
    "verified",
    true,
  );
  const originals = [...event.messages];
  await context(event);
  expect(event.messages[0]?.id).toContain("reflection-cursor-");
  expect(JSON.stringify(event.messages[0])).toContain(
    "VERIFIED_NATIVE_SUMMARY_",
  );
  expect(event.messages.slice(1)).toEqual([originals.at(-1)]);
  const notice = event.messages[0];
  expect(storage.get("reflection-v2/cursor/1/native/s")).toMatchObject({
    projectedThrough: "answer",
  });

  setManifestResponses([503]);
  event.messages = [...originals];
  await context(event);
  expect(event.messages).toEqual([notice, originals.at(-1)]);
});
it("an outage right after a restart reuses the persisted archive block", async () => {
  const { context, restart, event, setManifestResponses } = await fixture(
    "verified",
    true,
  );
  const originals = [...event.messages];
  await context(event);
  const notice = event.messages[0];
  expect(JSON.stringify(notice)).toContain("VERIFIED_NATIVE_SUMMARY_");
  await restart();
  setManifestResponses([503]);
  event.messages = [...originals];
  await context(event);
  expect(event.messages).toEqual([notice, originals.at(-1)]);
});
it("a reverted ingestion cursor resumes from the last summary that exists", async () => {
  const { context, event, storage, fetch } = await fixture("verified", true);
  const key = "reflection-v2/cursor/1/native/s";
  storage.set(key, {
    version: 1,
    sourceId: "native",
    sessionId: "s",
    submittedThrough: "reverted",
    summarizedThrough: null,
    summaryFingerprint: "",
  });
  await context(event);
  const after = fetch.mock.calls
    .map(([input]) => new URL(String(input)).searchParams.get("cursor"))
    .filter((cursor) => cursor !== null)
    .map(
      (cursor) =>
        (
          JSON.parse(Buffer.from(cursor, "base64url").toString()) as {
            id: string;
          }
        ).id,
    );
  expect(after).not.toContain("reverted");
  expect(after).toContain("answer");
  expect(storage.get(key)).toMatchObject({ submittedThrough: "answer" });
});
it("503 does not block tiny source-validated context", async () => {
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
  // Nothing is summarized, so the archived history is marked as missing.
  expect(event.messages.slice(1)).toEqual([originals.at(-1)]);
  expect(JSON.stringify(event.messages[0])).toContain(
    "[Reflection omitted old..answer: missing-or-stale-summary]",
  );
});
it("an application 404 envelope still fails closed with its HTTP status", async () => {
  const { context, event } = await fixture("app-404");
  await expect(context(event)).rejects.toThrow(
    "Reflection: endpoint rejected request (HTTP 404)",
  );
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
it("an oversized explicit output limit is capped during a Reflection outage", async () => {
  const { context, event } = await fixture("503", false, 20000);
  event.options.maxTokens = 20000;
  await context(event);
  expect(event.options.maxTokens).toBe(5000);
});
it("manifest outage never sends a request that cannot fit the latest user", async () => {
  const { context, event, history } = await fixture("503");
  history[0]!.text = "x".repeat(50000);
  event.messages = [
    Message.make({ id: "latest", role: "user", content: history[0]!.text! }),
  ];
  await expect(context(event)).rejects.toThrow(
    "materialized context exceeds hard input budget",
  );
});
