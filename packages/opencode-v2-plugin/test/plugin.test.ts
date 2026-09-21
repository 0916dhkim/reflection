import type { Plugin } from "@opencode/plugin";
import { readFile } from "node:fs/promises";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { afterEach, expect, it, vi } from "vitest";
import { setup } from "../src/index.js";
import { canonicalizeNativeHistory } from "@reflection/opencode-v2-core/history";
import { planNativeSegments } from "@reflection/opencode-v2-core/segmentation";

const state = vi.hoisted(() => ({ config: "{}" }));
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => state.config),
}));
const config = {
  url: "http://reflection.invalid",
  apiKey: "secret",
  sourceId: "native",
  sources: {
    native: { kind: "opencode-v2", url: "http://native.invalid" },
    legacy: { kind: "opencode-v1", url: "http://legacy.invalid" },
  },
  contextProjection: { enabled: true },
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function sdk(
  configPath: unknown = "/isolated/reflection-v2.json",
  directory = "/work",
  version = "2.0.8",
) {
  const hooks = new Map<string, (event: SessionContext) => Promise<void>>();
  const tools = new Map<
    string,
    {
      options?: { codemode: boolean };
      execute: (
        input: unknown,
        context: { sessionID: string },
      ) => Promise<{ content: string }>;
    }
  >();
  const storage = new Map<string, unknown>();
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const subscription = { starts: 0, active: 0, fail: false };
  let wake = () => {};
  const ctx = {
    app: { name: "opencode", version, channel: "latest" },
    options: { configPath },
    location: { directory },
    session: {
      hook: async (
        name: string,
        callback: (event: SessionContext) => Promise<void>,
      ) => {
        hooks.set(name, callback);
        return {
          dispose: async () => {
            hooks.delete(name);
          },
        };
      },
    },
    tool: {
      transform: async (
        callback: (editor: {
          add: (tool: {
            name: string;
            execute: (
              input: unknown,
              context: { sessionID: string },
            ) => Promise<{ content: string }>;
          }) => void;
        }) => void,
      ) => {
        callback({
          add: (tool) => {
            tools.set(tool.name, tool);
          },
        });
        return {
          dispose: async () => {
            tools.clear();
          },
        };
      },
    },
    model: {
      list: async () => ({
        location: { directory },
        data: [
          {
            id: "small",
            providerID: "test",
            limit: { context: 20000, input: 16000, output: 4000 },
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
        subscription.starts++;
        subscription.active++;
        try {
          while (!signal.aborted) {
            if (subscription.fail) throw new Error("stream failed");
            const next = events.shift();
            if (next) {
              yield next;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = () => {
                signal.removeEventListener("abort", wake);
                resolve();
              };
              signal.addEventListener("abort", wake, { once: true });
            });
          }
        } finally {
          subscription.active--;
        }
      },
    },
  } as unknown as Plugin.Context;
  return {
    ctx,
    hooks,
    tools,
    storage,
    subscription,
    emit: (type: string, data: Record<string, unknown>) => {
      events.push({ type, data });
      wake();
    },
  };
}
function event() {
  return {
    sessionID: "s",
    model: { id: "small", providerID: "test" },
    agent: "build",
    system: [],
    messages: [],
    options: {},
    tools: {},
  } as unknown as SessionContext;
}
it.each(["2.0.7", "2.0.9", "v2.0.8", "2.0.8-dev", "unknown", ""])(
  "unsupported host %s retains guards and refuses all model/source IO",
  async (version) => {
    state.config = JSON.stringify(config);
    const fake = sdk(undefined, "/work", version);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.mocked(readFile).mockClear();
    const modelList = vi.spyOn(fake.ctx.model, "list");
    const cleanup = await setup(fake.ctx);
    cleanups.push(cleanup);
    expect(cleanup).toBeTypeOf("function");
    expect(() => fake.hooks.get("compaction")!(event())).toThrow(
      "native checkpoint forbidden",
    );
    for (let i = 0; i < 2; i++) {
      await expect(fake.hooks.get("context")!(event())).rejects.toThrow(
        "unsupported OpenCode host version; exactly 2.0.8 is required",
      );
      await expect(fake.hooks.get("model.request")!(event())).rejects.toThrow(
        "unsupported OpenCode host version",
      );
      expect(
        (
          await fake.tools
            .get("memory_search")!
            .execute({ query: "q" }, { sessionID: "s" })
        ).content,
      ).toContain("unsupported OpenCode host version");
      expect(
        (
          await fake.tools.get("memory_read_segment")!.execute(
            {
              source_id: "native",
              segment_id: "11111111-1111-4111-8111-111111111111",
            },
            { sessionID: "s" },
          )
        ).content,
      ).toContain("unsupported OpenCode host version");
    }
    expect(readFile).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(modelList).not.toHaveBeenCalled();
    expect(fake.subscription.starts).toBe(0);
  },
);
function recoveryFetch(registry: (init: RequestInit) => Promise<Response>) {
  const fetch = vi.fn(async (input: URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/sources/native") return registry(init);
    if (path === "/api/session/s")
      return Response.json({
        data: {
          id: "s",
          time: { updated: 1 },
          location: { directory: "/work" },
        },
      });
    if (path === "/api/session/active")
      return Response.json({ data: { s: { type: "busy" } } });
    if (path.endsWith("/message"))
      return Response.json({ data: [], cursor: {} });
    if (path === "/api/config")
      return Response.json([
        { type: "document", info: { compaction: { auto: false } } },
      ]);
    if (path === "/v1/sessions/s/segments")
      return Response.json({
        source_id: "native",
        manifest_version: 3,
        session_id: "s",
        segments: [],
        boundaries: [],
        targets: [],
      });
    if (path === "/v1/search") return Response.json({ claims: [] });
    throw new Error("unexpected fixture request");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const nativeRegistry = {
  id: "native",
  kind: "opencode-v2",
  identity_scheme: "source-v1",
};
it.each([503, 404])(
  "registry startup %s recovers on a later context invocation without reloading",
  async (status) => {
    state.config = JSON.stringify(config);
    const fake = sdk();
    let attempts = 0;
    recoveryFetch(async () =>
      ++attempts === 1
        ? new Response("unavailable", { status })
        : Response.json(nativeRegistry),
    );
    cleanups.push(await setup(fake.ctx));
    expect(fake.subscription.starts).toBe(0);
    expect(fake.hooks.has("compaction")).toBe(true);
    await fake.hooks.get("context")!(event());
    expect(
      (
        await fake.tools
          .get("memory_search")!
          .execute({ query: "q" }, { sessionID: "s" })
      ).content,
    ).toBe('{"claims":[]}');
    await fake.hooks.get("model.request")!(event());
    expect(attempts).toBe(2);
    expect(fake.subscription).toMatchObject({ starts: 1, active: 1 });
  },
);
it("concurrent model and tool invocations coalesce one registry retry and one subscription", async () => {
  state.config = JSON.stringify(config);
  const fake = sdk();
  let attempts = 0;
  let release!: () => void;
  recoveryFetch(async () => {
    if (++attempts === 1) return new Response("unavailable", { status: 503 });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return Response.json(nativeRegistry);
  });
  cleanups.push(await setup(fake.ctx));
  const tool = fake.tools
    .get("memory_search")!
    .execute({ query: "q" }, { sessionID: "s" });
  const model = fake.hooks.get("model.request")!(event());
  const context = fake.hooks.get("context")!(event());
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(attempts).toBe(2);
  expect(fake.subscription.starts).toBe(0);
  release();
  const [result] = await Promise.all([tool, model, context]);
  expect(result.content).toBe('{"claims":[]}');
  expect(attempts).toBe(2);
  expect(fake.subscription).toMatchObject({ starts: 1, active: 1 });
});
it("each failed invocation retries registry at most once and does not cache its rejection", async () => {
  state.config = JSON.stringify(config);
  const fake = sdk();
  let attempts = 0;
  recoveryFetch(async () => {
    attempts++;
    return new Response("unavailable", { status: 503 });
  });
  cleanups.push(await setup(fake.ctx));
  for (let i = 0; i < 2; i++) {
    const result = await fake.tools
      .get("memory_search")!
      .execute({ query: "q" }, { sessionID: "s" });
    expect(result.content).toContain("source registry missing");
    expect(attempts).toBe(i + 2);
  }
  expect(fake.subscription.starts).toBe(0);
});
it("invalid config remains a reload-required refusal without registry retries", async () => {
  state.config = JSON.stringify({
    ...config,
    contextProjection: { enabled: false },
  });
  const fake = sdk();
  const fetch = recoveryFetch(async () => Response.json(nativeRegistry));
  cleanups.push(await setup(fake.ctx));
  for (let i = 0; i < 2; i++) {
    expect(
      (
        await fake.tools
          .get("memory_search")!
          .execute({ query: "q" }, { sessionID: "s" })
      ).content,
    ).toContain("invalid config");
    await expect(fake.hooks.get("context")!(event())).rejects.toThrow(
      "invalid config",
    );
    await expect(fake.hooks.get("model.request")!(event())).rejects.toThrow(
      "invalid config",
    );
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(fake.subscription.starts).toBe(0);
});
it("disposal aborts registry retry without later readiness, source posts, or an event-loop leak", async () => {
  state.config = JSON.stringify(config);
  const fake = sdk();
  let attempts = 0;
  let aborted = false;
  const fetch = recoveryFetch(async (init) => {
    if (++attempts === 1) return new Response("unavailable", { status: 503 });
    await new Promise<void>((resolve) =>
      init.signal!.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      ),
    );
    // Simulate a late successful response despite the aborted request.
    return Response.json(nativeRegistry);
  });
  const cleanup = await setup(fake.ctx);
  cleanups.push(cleanup);
  const execute = fake.tools.get("memory_search")!.execute;
  const tool = execute({ query: "q" }, { sessionID: "s" });
  const context = fake.hooks.get("context")!(event()).then(
    () => "unexpected success",
    () => "cancelled",
  );
  await vi.waitFor(() => expect(attempts).toBe(2));
  await cleanup();
  expect(aborted).toBe(true);
  expect((await tool).content).toContain("cancelled");
  expect(await context).toBe("cancelled");
  expect(fake.subscription).toMatchObject({ starts: 0, active: 0 });
  expect(
    fetch.mock.calls.every(
      ([input]) => new URL(String(input)).pathname === "/v1/sources/native",
    ),
  ).toBe(true);
  expect((await execute({ query: "q" }, { sessionID: "s" })).content).toContain(
    "disposal",
  );
  expect(attempts).toBe(2);
});
it("fatal event-stream failure remains reload-required rather than restarting registry or subscriptions", async () => {
  state.config = JSON.stringify(config);
  const fake = sdk();
  fake.subscription.fail = true;
  let attempts = 0;
  recoveryFetch(async () => {
    attempts++;
    return Response.json(nativeRegistry);
  });
  cleanups.push(await setup(fake.ctx));
  await vi.waitFor(() => expect(fake.subscription.active).toBe(0));
  expect(
    (
      await fake.tools
        .get("memory_search")!
        .execute({ query: "q" }, { sessionID: "s" })
    ).content,
  ).toContain("event subscription failed");
  await expect(fake.hooks.get("context")!(event())).rejects.toThrow(
    "until plugin reload",
  );
  expect(attempts).toBe(1);
  expect(fake.subscription.starts).toBe(1);
});
it("registers fail-closed context and unscoped compaction veto before any registry IO", async () => {
  state.config = JSON.stringify(config);
  const fake = sdk();
  let release!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      expect(fake.hooks.has("context")).toBe(true);
      expect(fake.hooks.has("compaction")).toBe(true);
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }),
  );
  let returned = false;
  const initializing = setup(fake.ctx).then((cleanup) => {
    returned = true;
    return cleanup;
  });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(returned).toBe(false);
  expect(fake.hooks.has("context")).toBe(true);
  expect(() => fake.hooks.get("compaction")!(event())).toThrow(
    "native checkpoint forbidden",
  );
  release(
    Response.json({
      id: "native",
      kind: "opencode-v2",
      identity_scheme: "source-v1",
    }),
  );
  cleanups.push(await initializing);
  expect(returned).toBe(true);
  expect(fake.tools.get("memory_search")!.options).toEqual({ codemode: false });
  expect(fake.tools.get("memory_read_segment")!.options).toEqual({
    codemode: false,
  });
});
it.each([undefined, "relative.json"])(
  "keeps meaningful tools and guards for invalid explicit configPath %s",
  async (path) => {
    const fake = sdk(path === undefined ? null : path);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const cleanup = await setup(fake.ctx);
    cleanups.push(cleanup);
    await vi.waitFor(async () => {
      const result = await fake.tools
        .get("memory_search")!
        .execute({ query: "q" }, { sessionID: "s" });
      expect(result.content).toContain("explicit absolute");
    });
    expect(fetch).not.toHaveBeenCalled();
    await expect(fake.hooks.get("context")!(event())).rejects.toThrow(
      "explicit absolute",
    );
  },
);
it("disabled projection is an explicit startup error, not native fallback", async () => {
  state.config = JSON.stringify({
    ...config,
    contextProjection: { enabled: false },
  });
  const fake = sdk();
  const cleanup = await setup(fake.ctx);
  cleanups.push(cleanup);
  await vi.waitFor(async () =>
    expect(
      (
        await fake.tools
          .get("memory_search")!
          .execute({ query: "q" }, { sessionID: "s" })
      ).content,
    ).toContain("enabled=true"),
  );
  expect(fake.hooks.has("compaction")).toBe(true);
});
it.each([
  { type: "session.execution.succeeded", data: {} },
  {
    type: "session.execution.failed",
    data: { error: { type: "provider", message: "failed" } },
  },
  { type: "session.execution.interrupted", data: { reason: "user" } },
])(
  "$type ingests an exact closed native range at idle priority and tolerates terminal aliases",
  async (terminal) => {
    state.config = JSON.stringify(config);
    const fake = sdk();
    const source = {
      id: "native",
      kind: "opencode-v2" as const,
      identity_scheme: "source-v1" as const,
    };
    const history = [
      {
        id: "msg_user",
        type: "user",
        text: "x".repeat(24000),
        time: { created: 1 },
      },
    ];
    const segment = planNativeSegments({
      source,
      sessionId: "s",
      records: canonicalizeNativeHistory(history),
    })[0]!;
    const manifest = {
      source_id: "native",
      manifest_version: 3,
      session_id: "s",
      segments: [],
      boundaries: [],
      targets: [],
    };
    const target = {
      id: segment.id,
      source_boundary_version: 3,
      start_source_message_id: "msg_user",
      end_source_message_id: "msg_user",
      source_fingerprint: segment.fingerprint,
      projection_version: 3,
      status: "pending",
    };
    const requests: Array<Record<string, unknown>> = [];
    let release!: () => void;
    let accepted = false;
    let ingestionAborted = false;
    let toolStarted = false;
    let sweeps = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL, init: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/sources/native") return Response.json(source);
        if (path === "/v1/search") {
          toolStarted = true;
          await new Promise<void>((_resolve, reject) =>
            init.signal!.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            ),
          );
        }
        if (path === "/api/session/s")
          return Response.json({
            data: {
              id: "s",
              time: { updated: 1 },
              location: { directory: "/work" },
            },
          });
        if (path === "/api/session/active") return Response.json({ data: {} });
        if (path.endsWith("/message"))
          return Response.json({ data: history, cursor: {} });
        if (path === "/v1/sessions/s/segments")
          return Response.json({
            ...manifest,
            targets: accepted ? [target] : [],
          });
        if (path === "/api/session") {
          sweeps++;
          return Response.json({ data: [], cursor: {} });
        }
        expect(path).toBe("/v1/segments");
        requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        init.signal!.addEventListener(
          "abort",
          () => {
            ingestionAborted = true;
          },
          { once: true },
        );
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        accepted = true;
        const { id: _id, ...boundary } = target;
        return Response.json({
          ...boundary,
          id: 1,
          source_id: "native",
          segment_id: segment.id,
          attempts: 0,
          error: null,
          created_at: "now",
          started_at: null,
          finished_at: null,
          next_attempt_at: "now",
        });
      }),
    );
    cleanups.push(await setup(fake.ctx));
    const pendingTool = fake.tools
      .get("memory_search")!
      .execute({ query: "pending" }, { sessionID: "s" });
    await vi.waitFor(() => expect(toolStarted).toBe(true));
    fake.emit(terminal.type, { sessionID: "s", ...terminal.data });
    expect((await pendingTool).content).toContain("cancelled");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    fake.emit("session.status", { sessionID: "s", status: { type: "idle" } });
    fake.emit("session.idle", { sessionID: "s" });
    fake.emit(terminal.type, { sessionID: "s", ...terminal.data });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await vi.waitFor(() => expect(sweeps).toBeGreaterThan(0));
    expect(requests).toEqual([{ ...segment.request, processing_priority: 50 }]);
    expect(ingestionAborted).toBe(false);
  },
);
it.each(["/work", "/work/\uD55C\uAE00 project"])(
  "rechecks scoped automatic compaction for %s before dispatch without unscoped retry",
  async (directory) => {
    state.config = JSON.stringify(config);
    const fake = sdk(undefined, directory);
    let auto = false;
    let rejectConfig = false;
    let sessionDirectory = directory;
    let configGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/sources/native")
          return Response.json({
            id: "native",
            kind: "opencode-v2",
            identity_scheme: "source-v1",
          });
        if (url.pathname === "/api/session/s")
          return Response.json({
            data: {
              id: "s",
              time: { updated: 1 },
              location: { directory: sessionDirectory },
            },
          });
        if (url.pathname === "/api/session/active")
          return Response.json({ data: { s: { type: "busy" } } });
        if (url.pathname.endsWith("/message"))
          return Response.json({ data: [], cursor: {} });
        if (url.pathname === "/api/config") {
          configGets++;
          expect([...url.searchParams.entries()]).toEqual([
            ["location[directory]", directory],
          ]);
          expect(url.searchParams.has("location")).toBe(false);
          if (rejectConfig)
            return new Response("invalid selector", { status: 400 });
          return Response.json([
            { type: "document", info: { compaction: { auto } } },
          ]);
        }
        return Response.json({
          source_id: "native",
          manifest_version: 3,
          session_id: "s",
          segments: [],
          boundaries: [],
          targets: [],
        });
      }),
    );
    const cleanup = await setup(fake.ctx);
    cleanups.push(cleanup);
    await vi.waitFor(async () =>
      expect(
        (
          await fake.tools
            .get("memory_search")!
            .execute({ query: "q" }, { sessionID: "s" })
        ).content,
      ).not.toContain("initializing"),
    );
    await fake.hooks.get("context")!(event());
    auto = true;
    await expect(fake.hooks.get("context")!(event())).rejects.toThrow(
      "compaction.auto must be false",
    );
    await expect(fake.hooks.get("model.request")!(event())).rejects.toThrow(
      "compaction.auto must be false",
    );
    expect(configGets).toBe(3);
    rejectConfig = true;
    await expect(fake.hooks.get("context")!(event())).rejects.toThrow(
      "endpoint rejected request",
    );
    await expect(fake.hooks.get("model.request")!(event())).rejects.toThrow(
      "endpoint rejected request",
    );
    expect(configGets).toBe(5);
    sessionDirectory = "/other-scope";
    await expect(fake.hooks.get("model.request")!(event())).rejects.toThrow(
      "session location is not owned",
    );
    expect(configGets).toBe(5);
  },
);
it("memory_read_segment rejects wrong source/segment pair and unavailable legacy source without fallback", async () => {
  state.config = JSON.stringify(config);
  const fake = sdk();
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL) => {
      const url = new URL(String(input));
      urls.push(url.href);
      if (url.pathname === "/v1/sources/native")
        return Response.json({
          id: "native",
          kind: "opencode-v2",
          identity_scheme: "source-v1",
        });
      if (url.pathname === "/v1/sources/legacy")
        return new Response("unavailable", { status: 404 });
      return Response.json({ source_id: "wrong" });
    }),
  );
  const cleanup = await setup(fake.ctx);
  cleanups.push(cleanup);
  await vi.waitFor(async () =>
    expect(
      (
        await fake.tools
          .get("memory_search")!
          .execute({ query: "q" }, { sessionID: "s" })
      ).content,
    ).not.toContain("initializing"),
  );
  const native = await fake.tools.get("memory_read_segment")!.execute(
    {
      source_id: "native",
      segment_id: "11111111-1111-4111-8111-111111111111",
    },
    { sessionID: "s" },
  );
  expect(native.content).toContain("invalid source-owned metadata");
  const legacy = await fake.tools.get("memory_read_segment")!.execute(
    {
      source_id: "legacy",
      segment_id: "11111111-1111-4111-8111-111111111111",
    },
    { sessionID: "s" },
  );
  expect(legacy.content).toContain("registry missing");
  expect(urls.some((url) => url.startsWith("http://native.invalid"))).toBe(
    false,
  );
  expect(urls.find((url) => url.includes("/v1/segments/"))).toContain(
    "source_id=native",
  );
});
it("hydrates native exact ranges and reports absence of backend fingerprint honestly", async () => {
  state.config = JSON.stringify(config);
  const fake = sdk();
  const source = {
    id: "native",
    kind: "opencode-v2" as const,
    identity_scheme: "source-v1" as const,
  };
  const history = [
    { id: "msg_u", type: "user", text: "exact text", time: { created: 1 } },
  ];
  const segment = planNativeSegments({
    source,
    sessionId: "archived",
    records: canonicalizeNativeHistory(history),
    allowOpenSnapshot: true,
  })[0]!;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/sources/native") return Response.json(source);
      if (path.startsWith("/v1/segments/"))
        return Response.json({
          id: segment.id,
          source_id: "native",
          session_id: "archived",
          source_boundary_version: 3,
          start_source_message_id: "msg_u",
          end_source_message_id: "msg_u",
          summary: "summary",
          claims: [],
          created_at: "now",
          updated_at: "now",
        });
      if (path === "/api/session/archived")
        return Response.json({
          data: {
            id: "archived",
            time: { updated: 1 },
            location: { directory: "/other-location-permitted-for-memory" },
          },
        });
      if (path === "/api/session/active") return Response.json({ data: {} });
      if (path.endsWith("/message"))
        return Response.json({ data: history, cursor: {} });
      return Response.json({});
    }),
  );
  const cleanup = await setup(fake.ctx);
  cleanups.push(cleanup);
  await vi.waitFor(async () =>
    expect(
      (
        await fake.tools
          .get("memory_search")!
          .execute({ query: "q" }, { sessionID: "s" })
      ).content,
    ).not.toContain("initializing"),
  );
  const result = JSON.parse(
    (
      await fake.tools
        .get("memory_read_segment")!
        .execute(
          { source_id: "native", segment_id: segment.id },
          { sessionID: "s" },
        )
    ).content,
  ) as Record<string, unknown>;
  expect(result.messages).toEqual([
    { id: "msg_u", type: "user", text: "exact text" },
  ]);
  expect(result.verification).toContain("backend fingerprint unavailable");
});
it("session deletion aborts in-flight tools, removes checkpoint, and prevents new work", async () => {
  state.config = JSON.stringify(config);
  const fake = sdk();
  let slow = false;
  let started = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL, init: RequestInit) => {
      if (String(input).includes("/v1/sources/"))
        return Response.json({
          id: "native",
          kind: "opencode-v2",
          identity_scheme: "source-v1",
        });
      if (!slow) return Response.json({});
      started = true;
      await new Promise<void>((_resolve, reject) =>
        init.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        ),
      );
      return Response.json({});
    }),
  );
  const cleanup = await setup(fake.ctx);
  cleanups.push(cleanup);
  await vi.waitFor(async () =>
    expect(
      (
        await fake.tools
          .get("memory_search")!
          .execute({ query: "q" }, { sessionID: "s" })
      ).content,
    ).not.toContain("initializing"),
  );
  fake.storage.set("reflection-v2/checkpoint/2/native/s", {});
  slow = true;
  const pending = fake.tools
    .get("memory_search")!
    .execute({ query: "q" }, { sessionID: "s" });
  await vi.waitFor(() => expect(started).toBe(true));
  fake.emit("session.deleted", { sessionID: "s" });
  expect((await pending).content).toContain("cancelled");
  await vi.waitFor(() => expect(fake.storage.size).toBe(0));
  expect(
    (
      await fake.tools
        .get("memory_search")!
        .execute({ query: "q" }, { sessionID: "s" })
    ).content,
  ).toContain("deletion");
});
it.each([1, 2])(
  "hydrates legacy boundary version %s through shared exact reader and rejects absent endpoints",
  async (version) => {
    state.config = JSON.stringify(config);
    const fake = sdk();
    let missing = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/sources/native")
          return Response.json({
            id: "native",
            kind: "opencode-v2",
            identity_scheme: "source-v1",
          });
        if (url.pathname === "/v1/sources/legacy")
          return Response.json({
            id: "legacy",
            kind: "opencode-v1",
            identity_scheme: "legacy",
          });
        if (url.pathname.startsWith("/v1/segments/"))
          return Response.json({
            id: "11111111-1111-4111-8111-111111111111",
            source_id: "legacy",
            session_id: "old",
            source_boundary_version: version,
            start_user_message_id: "u",
            end_user_message_id: "u",
            start_source_message_id: version === 1 ? null : "u",
            end_source_message_id: version === 1 ? null : "a",
            summary: "summary",
            claims: [],
            created_at: "now",
            updated_at: "now",
          });
        if (url.pathname === "/session/old/message")
          return Response.json(
            missing
              ? []
              : [
                  {
                    info: { id: "u", role: "user", time: { created: 1 } },
                    parts: [{ type: "text", text: "legacy input" }],
                  },
                  {
                    info: {
                      id: "a",
                      role: "assistant",
                      parentID: "u",
                      time: { created: 2, completed: 3 },
                    },
                    parts: [{ type: "text", text: "legacy answer" }],
                  },
                ],
          );
        return Response.json({});
      }),
    );
    const cleanup = await setup(fake.ctx);
    cleanups.push(cleanup);
    await vi.waitFor(async () =>
      expect(
        (
          await fake.tools
            .get("memory_search")!
            .execute({ query: "q" }, { sessionID: "s" })
        ).content,
      ).not.toContain("initializing"),
    );
    const input = {
      source_id: "legacy",
      segment_id: "11111111-1111-4111-8111-111111111111",
    };
    const result = JSON.parse(
      (
        await fake.tools
          .get("memory_read_segment")!
          .execute(input, { sessionID: "s" })
      ).content,
    ) as Record<string, unknown>;
    expect(result.messages).toEqual([
      { role: "user", text: "legacy input" },
      { role: "assistant", text: "legacy answer" },
    ]);
    missing = true;
    expect(
      (
        await fake.tools
          .get("memory_read_segment")!
          .execute(input, { sessionID: "s" })
      ).content,
    ).toContain("error");
  },
);
