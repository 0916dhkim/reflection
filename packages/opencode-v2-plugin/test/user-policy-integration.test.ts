import type { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { Message, ReasoningPart, SystemPart } from "@opencode/ai";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalizeNativeHistory } from "@reflection/opencode-v2-core/history";
import { estimateNativeTokens } from "@reflection/opencode-v2-core/projection";
import { planNativeSegments } from "@reflection/opencode-v2-core/segmentation";
import { setup } from "../src/index.js";
import type { NativeModelEditor } from "../src/user-policy.js";
import * as userPolicy from "../src/user-policy.js";
import { materializedTokens } from "../src/projection.js";
import { UsageTracker } from "../src/usage.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const source = {
  id: "native",
  kind: "opencode-v2",
  identity_scheme: "source-v1",
} as const;
const selected = { id: "google/allowed", providerID: "openrouter" };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "reflection-policy-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const memory = join(directory, "MEMORY.md");
  const user = join(directory, "USER.md");
  const policyPath = join(directory, "policy.json");
  const configPath = join(directory, "config.json");
  const policy = {
    version: 1,
    instructionFiles: [memory, user],
    modelAllowlists: { openrouter: [selected.id] },
    geminiOpenRouterToolGuard: true,
  };
  await Promise.all([
    writeFile(memory, "MEMORY"),
    writeFile(user, "USER"),
    writeFile(policyPath, JSON.stringify(policy)),
    writeFile(
      configPath,
      JSON.stringify({
        url: "http://reflection.invalid",
        apiKey: "fixture",
        sourceId: source.id,
        sources: {
          native: { kind: source.kind, url: "http://native.invalid" },
        },
        contextProjection: { enabled: true },
      }),
    ),
  ]);
  const hooks = new Map<string, (event: SessionContext) => Promise<void>>();
  const storage = new Map<string, unknown>();
  let transform: ((editor: NativeModelEditor) => void) | undefined;
  const filterDispose = vi.fn(async () => {});
  const modelTransform = vi.fn(async (callback: typeof transform) => {
    transform = callback;
    return { dispose: filterDispose };
  });
  const limits = { context: 20000, input: 16000, output: 4000 };
  const history: unknown[] = [
    { id: "latest", type: "user", text: "latest", time: { created: 1 } },
  ];
  const fetch = vi.fn(async (input: URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/sources/native") return Response.json(source);
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
      return Response.json({ data: history, cursor: {} });
    if (path === "/api/config")
      return Response.json([
        { type: "document", info: { compaction: { auto: false } } },
      ]);
    if (path === "/v1/sessions/s/segments")
      return new Response("unavailable", { status: 503 });
    throw new Error("unexpected fixture request");
  });
  vi.stubGlobal("fetch", fetch);
  const options: Record<string, unknown> = {
    configPath,
    userPolicyPath: policyPath,
  };
  const modelList = vi.fn(async () => ({
    location: { directory: "/work" },
    data: [{ ...selected, limit: limits }],
  }));
  const ctx = {
    app: { name: "opencode", version: "2.0.8", channel: "latest" },
    options,
    location: { directory: "/work" },
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
    tool: { transform: async () => ({ dispose: async () => {} }) },
    model: { list: modelList, transform: modelTransform },
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
  const event = () =>
    ({
      sessionID: "s",
      agent: "build",
      model: selected,
      options: {},
      tools: {},
      system: [SystemPart.make("GLOBAL"), SystemPart.make("PROJECT")],
      messages: [
        Message.make({ id: "latest", role: "user", content: "latest" }),
      ],
    }) as unknown as SessionContext;
  const start = async () => {
    const dispose = await setup(ctx);
    cleanups.push(dispose);
    return dispose;
  };
  return {
    ctx,
    options,
    policy,
    policyPath,
    memory,
    user,
    hooks,
    fetch,
    event,
    start,
    modelTransform,
    filterDispose,
    modelList,
    limits,
    history,
    storage,
    replay: (editor: NativeModelEditor) => transform!(editor),
    context: (value: SessionContext) => hooks.get("context")!(value),
    dispatch: (value: SessionContext, kind = "chat") =>
      hooks.get("model.request")!({ ...value, kind } as SessionContext),
  };
}

it.each([undefined, null, "relative.json", "/missing/private-policy.json"])(
  "invalid present policy %s retains all mandatory guards without IO",
  async (path) => {
    const f = await fixture();
    f.options.userPolicyPath = path;
    await f.start();
    expect(() => f.hooks.get("compaction")!(f.event())).toThrow(
      "native checkpoint forbidden",
    );
    for (let i = 0; i < 2; i++) {
      await expect(f.context(f.event())).rejects.toThrow(
        "Reflection: user policy unavailable or invalid; reload required",
      );
      await expect(f.dispatch(f.event())).rejects.toThrow(
        "Reflection: user policy unavailable or invalid; reload required",
      );
    }
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.modelTransform).not.toHaveBeenCalled();
  },
);
it.each(["not JSON private-value", "{}", " ".repeat(1024 * 1024 + 1)])(
  "rejects malformed or oversized profiles (%#)",
  async (text) => {
    const f = await fixture();
    await writeFile(f.policyPath, text);
    await f.start();
    await expect(f.context(f.event())).rejects.toThrow(
      "Reflection: user policy unavailable or invalid; reload required",
    );
    expect(f.fetch).not.toHaveBeenCalled();
  },
);

it("absent policy never uses model.transform and retains the native system", async () => {
  const f = await fixture();
  delete f.options.userPolicyPath;
  Reflect.deleteProperty(f.ctx.model, "transform");
  await f.start();
  const event = f.event();
  const system = event.system;
  await f.context(event);
  expect(event.system).toBe(system);
  await f.dispatch(event);
});

it("appends fresh ordered instructions, avoids duplicate append, and retries missing files", async () => {
  const f = await fixture();
  await f.start();
  const event = f.event();
  await f.context(event);
  expect(event.system.map((part) => part.text)).toEqual([
    "GLOBAL",
    "PROJECT",
    `Instructions from: ${f.memory}\nMEMORY`,
    `Instructions from: ${f.user}\nUSER`,
  ]);
  await writeFile(f.memory, "CHANGED");
  await f.context(event);
  expect(event.system).toHaveLength(4);
  expect(event.system[2]!.text).toContain("CHANGED");
  await rm(f.user);
  const originalSystem = event.system;
  const originalMessages = event.messages;
  f.fetch.mockClear();
  await expect(f.context(event)).rejects.toThrow(
    "Reflection: user policy instructions unavailable; request blocked",
  );
  expect(event.system).toBe(originalSystem);
  expect(event.messages).toBe(originalMessages);
  expect(f.fetch).not.toHaveBeenCalled();
  await writeFile(f.user, "RECOVERED");
  // Policy itself is cached until reload, unlike instruction contents.
  await writeFile(f.policyPath, "invalid");
  await f.context(event);
  expect(event.system[3]!.text).toContain("RECOVERED");
});

it("retains provider usage after policy MEMORY.md and USER.md edits while rendering fresh instructions", async () => {
  const f = await fixture();
  const prepare = vi.spyOn(UsageTracker.prototype, "prepare");
  await f.start();
  const event = f.event();
  await f.context(event);
  const answer = Message.make({
    id: "answer",
    role: "assistant",
    content: "reply",
  });
  f.history.push({
    id: "answer",
    type: "assistant",
    agent: "build",
    model: selected,
    content: [{ type: "text", text: "reply" }],
    time: { created: 2, completed: 3 },
    tokens: {
      input: 100,
      output: 20,
      reasoning: 10,
      cache: { read: 30, write: 40 },
    },
  });
  event.messages.push(answer);
  const providerTotal = 200;
  await f.context(event);
  expect(prepare.mock.results.at(-1)!.value.estimate(event.messages)).toBe(
    providerTotal,
  );
  for (const [path, text, index] of [
    [f.memory, "UPDATED MEMORY", 2],
    [f.user, "UPDATED USER", 3],
  ] as const) {
    await writeFile(path, text);
    await f.context(event);
    expect(event.system[index]!.text).toBe(
      `Instructions from: ${path}\n${text}`,
    );
    expect(prepare.mock.results.at(-1)!.value.estimate(event.messages)).toBe(
      providerTotal,
    );
  }
  const next = Message.make({ id: "next", role: "user", content: "continue" });
  f.history.push({
    id: "next",
    type: "user",
    text: "continue",
    time: { created: 4 },
  });
  event.messages.push(next);
  await f.context(event);
  expect(prepare.mock.results.at(-1)!.value.estimate(event.messages)).toBe(
    providerTotal +
      8 +
      estimateNativeTokens({ role: next.role, content: next.content }),
  );
  await f.dispatch(event);
});

it("invalidates provider usage for nonexempt instructions or changed base system, tools, and options", async () => {
  const f = await fixture();
  const extra = join(dirname(f.memory), "OTHER.md");
  f.policy.instructionFiles.push(extra);
  await Promise.all([
    writeFile(extra, "original"),
    writeFile(f.policyPath, JSON.stringify(f.policy)),
  ]);
  const prepare = vi.spyOn(UsageTracker.prototype, "prepare");
  await f.start();
  const event = f.event();
  await f.context(event);
  event.messages.push(
    Message.make({ id: "answer", role: "assistant", content: "reply" }),
  );
  f.history.push({
    id: "answer",
    type: "assistant",
    agent: "build",
    model: selected,
    content: [{ type: "text", text: "reply" }],
    time: { created: 2, completed: 3 },
    tokens: {
      input: 100,
      output: 20,
      reasoning: 10,
      cache: { read: 30, write: 40 },
    },
  });
  await f.context(event);
  expect(prepare.mock.results.at(-1)!.value.estimate(event.messages)).toBe(200);
  await writeFile(extra, "changed");
  await f.context(event);
  expect(
    prepare.mock.results.at(-1)!.value.estimate(event.messages),
  ).toBeUndefined();
  // Re-establish a proven anchor after each fallback so every negative check
  // tests its own configuration change rather than an already absent anchor.
  const changed = [
    () => {
      event.system = [SystemPart.make("NEW BASE")];
    },
    () => {
      event.tools = {
        changed: { description: "different", input: { type: "object" } },
      };
    },
    () => {
      event.options = { temperature: 0.9 };
    },
  ];
  for (const [index, mutate] of changed.entries()) {
    const id = `answer-${index}`;
    event.messages.push(
      Message.make({ id, role: "assistant", content: "reply" }),
    );
    f.history.push({
      id,
      type: "assistant",
      agent: "build",
      model: selected,
      content: [{ type: "text", text: "reply" }],
      time: { created: 4 + index * 2, completed: 5 + index * 2 },
      tokens: {
        input: 100,
        output: 20,
        reasoning: 10,
        cache: { read: 30, write: 40 },
      },
    });
    await f.context(event);
    expect(prepare.mock.results.at(-1)!.value.estimate(event.messages)).toBe(
      200,
    );
    mutate();
    await f.context(event);
    expect(
      prepare.mock.results.at(-1)!.value.estimate(event.messages),
    ).toBeUndefined();
  }
});

it("replays filtering for new catalog models and blocks late overrides for every dispatch kind", async () => {
  const f = await fixture();
  const dispose = await f.start();
  for (const id of ["google/blocked", "google/newly-discovered"]) {
    const models = [
      { ...selected, enabled: true },
      { ...selected, id, enabled: true },
    ];
    f.replay({
      list: () => models,
      update: (provider, model, update) => {
        update(
          models.find(
            (candidate) =>
              candidate.providerID === provider && candidate.id === model,
          )!,
        );
      },
    });
    expect(models.map((model) => model.enabled)).toEqual([true, false]);
    models[1]!.enabled = true;
    const base = f.event();
    const event = { ...base, model: { ...base.model, id } } as SessionContext;
    f.fetch.mockClear();
    for (const kind of ["chat", "title", "generate", "compaction"]) {
      await expect(f.dispatch(event, kind)).rejects.toThrow(
        "user policy forbids selected model",
      );
    }
    await expect(f.context(event)).rejects.toThrow(
      "user policy forbids selected model",
    );
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.modelList).not.toHaveBeenCalled();
  }
  await dispose();
  await dispose();
  expect(f.filterDispose).toHaveBeenCalledTimes(1);
});

it("includes instructions in the real hard budget before provider dispatch", async () => {
  const f = await fixture();
  await f.start();
  const provider = vi.fn();
  await writeFile(f.memory, "instruction ".repeat(12000));
  const event = f.event();
  const system = event.system;
  await expect(
    (async () => {
      await f.context(event);
      await f.dispatch(event);
      provider();
    })(),
  ).rejects.toThrow("Reflection:");
  expect(provider).not.toHaveBeenCalled();
  expect(event.system).toBe(system);
  await writeFile(f.memory, "small");
  await f.context(event);
  await f.dispatch(event);
  expect(
    materializedTokens(event.messages, event.system, event.tools),
  ).toBeLessThanOrEqual(14400);
});

it("materializes guarded tool results without changing canonical source IDs or fingerprints", async () => {
  const f = await fixture();
  const old = "old ".repeat(7000);
  f.history.unshift({
    id: "old",
    type: "user",
    text: old,
    time: { created: 0 },
  });
  f.limits.output = 15000;
  const raw = '{"answer":"quoted\\value"}\n';
  const result = {
    type: "tool-result",
    id: "call",
    name: "read",
    result: { type: "text", value: raw },
  } as const;
  f.history.push({
    id: "answer",
    type: "assistant",
    agent: "build",
    model: selected,
    content: [
      {
        type: "tool",
        id: "call",
        name: "read",
        time: { created: 2 },
        state: {
          status: "completed",
          input: {},
          content: [{ type: "text", text: raw }],
        },
      },
    ],
    time: { created: 2, completed: 3 },
  });
  const segments = () =>
    planNativeSegments({
      source,
      sessionId: "s",
      records: canonicalizeNativeHistory(f.history),
      allowOpenSnapshot: true,
    });
  const original = segments();
  await f.start();
  const event = f.event();
  event.messages.unshift(
    Message.make({ id: "old", role: "user", content: old }),
  );
  const message = Message.make({
    id: "answer",
    role: "assistant",
    content: [
      result,
      ReasoningPart.make({
        type: "reasoning",
        text: "reasoning",
        encrypted: "signed-state",
      }),
    ],
    providerMetadata: { openrouter: { reasoning: "encrypted-provider-state" } },
  });
  event.messages.push(message);
  await f.context(event);
  expect(JSON.stringify(event.messages)).toContain(
    "System-generated Reflection context",
  );
  expect(event.messages.at(-1)!.content[0]).toEqual({
    ...result,
    result: { type: "text", value: JSON.stringify(raw) },
  });
  expect(message.content[0]).toEqual(result);
  expect(event.messages.at(-1)!.content[1]).toBe(message.content[1]);
  expect(event.messages.at(-1)!.providerMetadata).toBe(
    message.providerMetadata,
  );
  const guarded = event.messages.at(-1)!.content[0];
  expect(
    userPolicy.guardGeminiToolResults(event.messages, selected, true).at(-1)!
      .content[0],
  ).toBe(guarded);
  expect(segments()).toEqual(original);
  expect(original[0]!.request.source_id).toBe("native");
  expect(original[0]!.fingerprint).toMatch(/^[a-f0-9]{64}$/);
});

it.each(["pending", "resolve", "reject", "close-reject"] as const)(
  "bounds a pending policy open and safely handles late %s",
  async (outcome) => {
    const f = await fixture();
    const handle = await fs.open(f.policyPath, "r");
    const actualClose = handle.close.bind(handle);
    cleanups.push(() => actualClose());
    const close = vi.spyOn(handle, "close");
    let resolve!: (value: typeof handle) => void;
    let reject!: (error: Error) => void;
    const opening = new Promise<typeof handle>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    vi.mocked(fs.open).mockReturnValueOnce(opening);
    vi.useFakeTimers();
    let returned = false;
    const starting = f.start().then((dispose) => {
      returned = true;
      return dispose;
    });
    await vi.advanceTimersByTimeAsync(60001);
    expect(returned).toBe(true);
    const dispose = await starting;
    expect(() => f.hooks.get("compaction")!(f.event())).toThrow(
      "native checkpoint forbidden",
    );
    await expect(f.context(f.event())).rejects.toThrow(
      "Reflection: user policy unavailable or invalid; reload required",
    );
    await expect(f.dispatch(f.event())).rejects.toThrow(
      "Reflection: user policy unavailable or invalid; reload required",
    );
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.modelTransform).not.toHaveBeenCalled();
    await dispose();
    if (outcome === "reject") {
      reject(new Error("private late open failure"));
      // The mocked failed acquisition never returned this fixture-owned handle.
      await handle.close();
    } else if (outcome !== "pending") {
      if (outcome === "close-reject") {
        close.mockImplementationOnce(async () => {
          await actualClose();
          throw new Error("private late close failure");
        });
      }
      resolve(handle);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledTimes(outcome === "pending" ? 0 : 1);
    await dispose();
    expect(close).toHaveBeenCalledTimes(outcome === "pending" ? 0 : 1);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.modelTransform).not.toHaveBeenCalled();
  },
);

it.each(["stat", "read", "close"] as const)(
  "bounds a pending policy %s including descriptor cleanup",
  async (method) => {
    const f = await fixture();
    const handle = await fs.open(f.policyPath, "r");
    const actualClose = handle.close.bind(handle);
    cleanups.push(() => actualClose());
    const close = vi.spyOn(handle, "close");
    const pending = method === "close" ? close : vi.spyOn(handle, method);
    pending.mockImplementationOnce(() => new Promise<never>(() => {}));
    vi.mocked(fs.open).mockResolvedValueOnce(handle);
    vi.useFakeTimers();
    let returned = false;
    const starting = f.start().then((dispose) => {
      returned = true;
      return dispose;
    });
    await vi.waitFor(() => expect(pending).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(60001);
    expect(returned).toBe(true);
    const dispose = await starting;
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => f.hooks.get("compaction")!(f.event())).toThrow(
      "native checkpoint forbidden",
    );
    await expect(f.context(f.event())).rejects.toThrow(
      "Reflection: user policy unavailable or invalid; reload required",
    );
    await expect(f.dispatch(f.event())).rejects.toThrow(
      "Reflection: user policy unavailable or invalid; reload required",
    );
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.modelTransform).not.toHaveBeenCalled();
    await dispose();
  },
);

it.each(["pending", "resolve", "reject", "dispose-reject"] as const)(
  "bounds pending model registration and handles late %s without revival",
  async (outcome) => {
    const f = await fixture();
    let resolve!: (value: Awaited<ReturnType<typeof f.modelTransform>>) => void;
    let reject!: (error: Error) => void;
    let replay: Parameters<typeof f.modelTransform>[0];
    f.modelTransform.mockImplementationOnce(async (callback) => {
      replay = callback;
      return new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
    });
    vi.useFakeTimers();
    let returned = false;
    const starting = f.start().then((dispose) => {
      returned = true;
      return dispose;
    });
    await vi.waitFor(() => expect(f.modelTransform).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(60001);
    expect(returned).toBe(true);
    const dispose = await starting;
    expect(() => f.hooks.get("compaction")!(f.event())).toThrow(
      "native checkpoint forbidden",
    );
    await expect(f.context(f.event())).rejects.toThrow(
      "Reflection: user policy unavailable or invalid; reload required",
    );
    await expect(f.dispatch(f.event())).rejects.toThrow(
      "Reflection: user policy unavailable or invalid; reload required",
    );
    const editor = {
      list: vi.fn(() => [{ ...selected, id: "blocked" }]),
      update: vi.fn(),
    };
    replay!(editor);
    expect(editor.list).not.toHaveBeenCalled();
    await dispose();
    const lateDispose = vi.fn(async () => {
      if (outcome === "dispose-reject")
        throw new Error("private late disposal failure");
    });
    if (outcome === "reject")
      reject(new Error("private late registration failure"));
    else if (outcome !== "pending") resolve({ dispose: lateDispose });
    await vi.advanceTimersByTimeAsync(0);
    expect(lateDispose).toHaveBeenCalledTimes(
      outcome === "reject" || outcome === "pending" ? 0 : 1,
    );
    await dispose();
    expect(lateDispose).toHaveBeenCalledTimes(
      outcome === "reject" || outcome === "pending" ? 0 : 1,
    );
    replay!(editor);
    expect(editor.update).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  },
);

it("disposal during an instruction read cannot mutate the event after cancellation", async () => {
  const f = await fixture();
  const dispose = await f.start();
  let release!: () => void;
  let readingSignal: AbortSignal | undefined;
  vi.spyOn(userPolicy, "readUserInstructionParts").mockImplementation(
    async (_policy, signal) => {
      readingSignal = signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [SystemPart.make("late instructions")];
    },
  );
  const event = f.event();
  const system = event.system;
  const messages = event.messages;
  const pending = f.context(event);
  const rejected = expect(pending).rejects.toThrow("Reflection:");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await dispose();
  expect(readingSignal?.aborted).toBe(true);
  release();
  await rejected;
  await Promise.resolve();
  expect(event.system).toBe(system);
  expect(event.messages).toBe(messages);
});

it("worst-case tool escaping is budgeted before dispatch, not appended after projection", async () => {
  const f = await fixture();
  const dispose = await f.start();
  const event = f.event();
  const raw = "{" + "\u0000".repeat(3000);
  event.messages.push(
    Message.make({
      id: "answer",
      role: "assistant",
      content: [
        {
          type: "tool-result",
          id: "call",
          name: "read",
          result: { type: "text", value: raw },
        },
      ],
    }),
  );
  f.history.push({
    id: "answer",
    type: "assistant",
    agent: "build",
    model: selected,
    content: [
      {
        type: "tool",
        id: "call",
        name: "read",
        time: { created: 2 },
        state: {
          status: "completed",
          input: {},
          content: [{ type: "text", text: raw }],
        },
      },
    ],
    time: { created: 2, completed: 3 },
  });
  const parts = await userPolicy.readUserInstructionParts(
    userPolicy.parseUserPolicy(f.policy),
  );
  const system = [...event.system, ...parts];
  const rawTokens = materializedTokens(event.messages, system, event.tools);
  const guardedTokens = materializedTokens(
    userPolicy.guardGeminiToolResults(event.messages, selected, true),
    system,
    event.tools,
  );
  expect(guardedTokens).toBeGreaterThan(rawTokens + 200);
  f.limits.input = Math.ceil((rawTokens + 150) / 0.9);
  f.limits.context = f.limits.input + f.limits.output;
  const original = event.messages;
  await expect(f.context(event)).rejects.toThrow("hard input budget");
  expect(event.messages).toBe(original);
  // The identical raw payload fits without the opt-in guard.
  await dispose();
  await writeFile(
    f.policyPath,
    JSON.stringify({ ...f.policy, geminiOpenRouterToolGuard: false }),
  );
  await f.start();
  await f.context(event);
  await f.dispatch(event);
});
