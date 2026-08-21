import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  PROJECTION_LOSS_WARNING,
  type OpenCodeMessage,
} from "../src/segments.js";

const paths = vi.hoisted(() => ({
  home: `/tmp/reflection-plugin-test-${process.pid}`,
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => paths.home,
}));

import { Reflection } from "../src/index.js";

beforeAll(() => {
  mkdirSync(join(paths.home, ".config", "opencode"), { recursive: true });
  writeFileSync(
    join(paths.home, ".config", "opencode", "reflection.json"),
    JSON.stringify({
      url: "https://reflection.example.com",
      apiKey: "test",
      contextProjection: { enabled: true },
    }),
  );
});

afterAll(() => {
  rmSync(paths.home, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function projectionMessages(sessionId: string): OpenCodeMessage[] {
  return [
    {
      info: {
        id: `${sessionId}-old-user`,
        sessionID: sessionId,
        role: "user",
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
      },
      parts: [{ type: "text", text: "u".repeat(100_000) }],
    },
    {
      info: {
        id: `${sessionId}-old-assistant`,
        sessionID: sessionId,
        role: "assistant",
        parentID: `${sessionId}-old-user`,
        providerID: "provider",
        modelID: "model",
        time: { created: 0, completed: 1 },
        finish: "stop",
        tokens: {
          input: 100_000,
          output: 1_000,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
      parts: [{ type: "text", text: "answer" }],
    },
    {
      info: {
        id: `${sessionId}-current`,
        sessionID: sessionId,
        role: "user",
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
      },
      parts: [{ type: "text", text: "continue" }],
    },
  ];
}

function clientFor(messages: OpenCodeMessage[]) {
  return {
    app: {
      log: vi.fn(
        async (_input: {
          body: { message: string; extra?: Record<string, unknown> };
        }) => ({ data: true }),
      ),
    },
    provider: {
      list: vi.fn(async () => ({
        data: {
          all: [
            {
              id: "provider",
              models: {
                model: {
                  limit: { context: 120_000, input: 120_000, output: 32_000 },
                },
              },
            },
          ],
        },
      })),
    },
    session: {
      get: vi.fn(async () => ({ data: { time: { updated: 0 } } })),
      messages: vi.fn(async (_input?: { path: { id: string } }) => ({
        data: messages,
      })),
      prompt: vi.fn(async (_input?: { body?: Record<string, unknown> }) => ({
        data: {},
      })),
      list: vi.fn(
        async (): Promise<{
          data: Array<{ id: string; time: { updated: number } }>;
        }> => ({ data: [] }),
      ),
      status: vi.fn(async () => ({ data: {} })),
    },
    tui: { showToast: vi.fn(async () => ({ data: true })) },
  };
}

const pluginInput = (client: ReturnType<typeof clientFor>) =>
  ({
    client,
    directory: "/tmp",
  }) as never;

function ok(data: unknown = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Reflection plugin hooks", () => {
  it("disables automatic compaction but bypasses projection for manual compaction", async () => {
    const providerList = vi.fn(() => {
      throw new Error("provider lookup must not run during manual compaction");
    });
    const hooks = await Reflection({
      client: { provider: { list: providerList } },
      directory: "/tmp",
    } as never);
    const config: { compaction?: { auto?: boolean } } = {};
    await hooks.config?.(config as never);
    expect(config.compaction?.auto).toBe(false);

    await hooks["experimental.session.compacting"]?.(
      { sessionID: "session" },
      { context: [] },
    );
    const output = {
      messages: [
        {
          info: {
            id: "compaction-user",
            sessionID: "session",
            role: "user",
            time: { created: 0 },
            agent: "build",
            model: { providerID: "provider", modelID: "model" },
          },
          parts: [],
        },
      ],
    };
    const original = structuredClone(output.messages);

    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    expect(output.messages).toEqual(original);
    expect(providerList).not.toHaveBeenCalled();
  });

  it("serializes target updates and waits for all pending updates before loading summaries", async () => {
    const sessionId = "serialized-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    const postResolvers: Array<() => void> = [];
    let activePosts = 0;
    let maxActivePosts = 0;
    let postCount = 0;
    let summaryGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          postCount += 1;
          activePosts += 1;
          maxActivePosts = Math.max(maxActivePosts, activePosts);
          await new Promise<void>((resolve) => postResolvers.push(resolve));
          activePosts -= 1;
          return ok();
        }
        summaryGets += 1;
        return ok({ session_id: sessionId, segments: [] });
      }),
    );
    const hooks = await Reflection(pluginInput(client));

    const firstIdle = hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);
    const secondIdle = hooks.event?.({
      event: {
        type: "session.status",
        properties: { sessionID: sessionId, status: { type: "idle" } },
      },
    } as never);
    await vi.waitFor(() => expect(postResolvers).toHaveLength(1));

    const output = { messages: structuredClone(messages) };
    const projection = hooks["experimental.chat.messages.transform"]?.(
      {},
      output as never,
    );
    await Promise.resolve();
    expect(summaryGets).toBe(0);

    postResolvers.shift()?.();

    await Promise.all([firstIdle, secondIdle, projection]);
    expect(maxActivePosts).toBe(1);
    expect(summaryGets).toBe(1);
    expect(client.session.messages).toHaveBeenCalledTimes(2);
    expect(client.session.status).toHaveBeenCalledTimes(4);
    expect(output.messages[1]?.parts[0]?.text).toContain(
      "Reflection compacted older context with omissions",
    );

    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);
    expect(postCount).toBe(1);
  });

  it("posts only newly closed segments on active idle", async () => {
    const sessionId = "snapshot-retry-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    const submittedBodies: Array<Record<string, unknown>> = [];
    let targetPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          targetPosts += 1;
          submittedBodies.push(JSON.parse(String(init.body)));
        }
        return ok();
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const idleEvent = {
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never;

    await hooks.event?.(idleEvent);
    await hooks.event?.(idleEvent);
    expect(targetPosts).toBe(1);
    expect(submittedBodies[0]).toMatchObject({
      start_user_message_id: `${sessionId}-old-user`,
      end_user_message_id: `${sessionId}-old-user`,
    });
    expect(submittedBodies).not.toContainEqual(
      expect.objectContaining({
        start_user_message_id: `${sessionId}-current`,
      }),
    );

    messages.push({
      info: {
        id: `${sessionId}-current-assistant`,
        sessionID: sessionId,
        role: "assistant",
        parentID: `${sessionId}-current`,
        time: { created: 2, completed: 3 },
      },
      parts: [{ type: "text", text: "x".repeat(25_000) }],
    });
    await hooks.event?.(idleEvent);
    await hooks.event?.(idleEvent);
    expect(targetPosts).toBe(2);
    expect(submittedBodies[1]).toMatchObject({
      start_user_message_id: `${sessionId}-current`,
      end_user_message_id: `${sessionId}-current`,
    });
  });

  it("snapshots an inactive open segment once and reposts it after source change", async () => {
    const sessionId = "active-sweep-session";
    const inactiveSessionId = "inactive-open-session";
    const activeMessages = projectionMessages(sessionId);
    const inactiveMessages: OpenCodeMessage[] = [
      {
        info: {
          id: `${inactiveSessionId}-user`,
          sessionID: inactiveSessionId,
          role: "user",
          model: { providerID: "provider", modelID: "model" },
        },
        parts: [{ type: "text", text: "open request" }],
      },
    ];
    const client = clientFor(activeMessages);
    client.session.list.mockResolvedValue({
      data: [{ id: inactiveSessionId, time: { updated: 0 } }],
    });
    client.session.messages.mockImplementation(async (input) => ({
      data:
        input?.path.id === inactiveSessionId
          ? inactiveMessages
          : activeMessages,
    }));
    const submittedBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          submittedBodies.push(JSON.parse(String(init.body)));
        }
        return ok();
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const idle = {
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never;

    await hooks.event?.(idle);
    await hooks.event?.(idle);
    expect(
      submittedBodies.filter((body) => body.session_id === inactiveSessionId),
    ).toHaveLength(1);

    if (inactiveMessages[0]) {
      inactiveMessages[0].parts = [
        ...inactiveMessages[0].parts,
        { type: "text", text: " updated" },
      ];
    }
    await hooks.event?.(idle);
    const inactiveBodies = submittedBodies.filter(
      (body) => body.session_id === inactiveSessionId,
    );
    expect(inactiveBodies).toHaveLength(2);
    expect(inactiveBodies[1]).toMatchObject({
      messages: [{ role: "user", text: "open request updated" }],
    });
  });

  it("revalidates stale-list inactivity after paused message capture", async () => {
    const activeSessionId = "active-stale-list-race";
    const inactiveSessionId = "inactive-stale-list-race";
    const activeMessages = projectionMessages(activeSessionId);
    const inactiveMessages = projectionMessages(inactiveSessionId);
    const client = clientFor(activeMessages);
    client.session.list.mockResolvedValue({
      data: [{ id: inactiveSessionId, time: { updated: 0 } }],
    });
    let releaseInactiveMessages: (() => void) | undefined;
    client.session.messages.mockImplementation(async (input) => {
      if (input?.path.id !== inactiveSessionId) return { data: activeMessages };
      return new Promise<{ data: OpenCodeMessage[] }>((resolve) => {
        releaseInactiveMessages = () => resolve({ data: inactiveMessages });
      });
    });
    let currentUpdated = 0;
    client.session.get.mockImplementation(async () => ({
      data: { time: { updated: currentUpdated } },
    }));
    const submittedBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          submittedBodies.push(JSON.parse(String(init.body)));
        }
        return ok();
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const idle = hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: activeSessionId },
      },
    } as never);
    await vi.waitFor(() => expect(releaseInactiveMessages).toBeDefined());

    currentUpdated = Date.now();
    releaseInactiveMessages?.();
    await idle;

    const inactiveBodies = submittedBodies.filter(
      (body) => body.session_id === inactiveSessionId,
    );
    expect(inactiveBodies).toHaveLength(1);
    expect(inactiveBodies[0]).toMatchObject({
      start_user_message_id: `${inactiveSessionId}-old-user`,
    });
    expect(inactiveBodies).not.toContainEqual(
      expect.objectContaining({
        start_user_message_id: `${inactiveSessionId}-current`,
      }),
    );
    expect(client.session.status).toHaveBeenCalledTimes(4);
    expect(client.session.get).toHaveBeenCalledWith({
      path: { id: inactiveSessionId },
      query: { directory: "/tmp" },
    });
  });

  it("retries an inactive open failure without blocking closed projection", async () => {
    const activeSessionId = "active-open-failure-sweep";
    const inactiveSessionId = "inactive-open-failure";
    const activeMessages = projectionMessages(activeSessionId);
    const inactiveMessages = projectionMessages(inactiveSessionId);
    const client = clientFor(activeMessages);
    client.session.list.mockResolvedValue({
      data: [{ id: inactiveSessionId, time: { updated: 0 } }],
    });
    client.session.messages.mockImplementation(async (input) => ({
      data:
        input?.path.id === inactiveSessionId
          ? inactiveMessages
          : activeMessages,
    }));
    let summaryGets = 0;
    let openAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          if (
            body.session_id === inactiveSessionId &&
            body.start_user_message_id === `${inactiveSessionId}-current`
          ) {
            openAttempts += 1;
            if (openAttempts === 1) {
              return new Response("failed", { status: 500 });
            }
          }
          return ok();
        }
        summaryGets += 1;
        return ok({
          session_id: inactiveSessionId,
          segments: [
            {
              id: "closed-summary",
              start_user_message_id: `${inactiveSessionId}-old-user`,
              end_user_message_id: `${inactiveSessionId}-old-user`,
              projection_version: 1,
              summary: "Closed segment summary",
            },
          ],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: activeSessionId },
      },
    } as never);
    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: activeSessionId },
      },
    } as never);
    const output = { messages: structuredClone(inactiveMessages) };

    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    const context = output.messages
      .flatMap((message) => message.parts)
      .find((part) => part.synthetic === true)?.text;
    expect(summaryGets).toBe(1);
    expect(openAttempts).toBe(2);
    expect(context).toContain("Closed segment summary");
    expect(context).not.toContain(PROJECTION_LOSS_WARNING);
  });

  it("registers the target barrier before idle message capture", async () => {
    const sessionId = "capture-barrier-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    let releaseMessages: (() => void) | undefined;
    client.session.messages.mockImplementation(
      async () =>
        new Promise<{ data: OpenCodeMessage[] }>((resolve) => {
          releaseMessages = () => resolve({ data: messages });
        }),
    );
    let summaryGets = 0;
    let targetPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          targetPosts += 1;
          return ok();
        }
        summaryGets += 1;
        return ok({ session_id: sessionId, segments: [] });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const idle = hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);
    await vi.waitFor(() =>
      expect(client.session.messages).toHaveBeenCalledOnce(),
    );
    const output = { messages: structuredClone(messages) };
    const projection = hooks["experimental.chat.messages.transform"]?.(
      {},
      output as never,
    );
    await Promise.resolve();

    expect(summaryGets).toBe(0);
    expect(targetPosts).toBe(0);
    releaseMessages?.();
    await Promise.all([idle, projection]);
    expect(targetPosts).toBe(1);
    expect(summaryGets).toBe(1);
  });

  it("defers one dirty rerun while the active pass is sweeping", async () => {
    const sessionId = "dirty-sweep-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    let releaseList: (() => void) | undefined;
    client.session.list.mockResolvedValue({ data: [] }).mockImplementationOnce(
      async () =>
        new Promise<{ data: [] }>((resolve) => {
          releaseList = () => resolve({ data: [] });
        }),
    );
    let blockPosts = false;
    const postResolvers: Array<() => void> = [];
    let summaryGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          if (blockPosts) {
            await new Promise<void>((resolve) => postResolvers.push(resolve));
          }
          return ok();
        }
        summaryGets += 1;
        return ok({ session_id: sessionId, segments: [] });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const firstIdle = hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);
    await vi.waitFor(() => expect(client.session.list).toHaveBeenCalledOnce());
    messages.push({
      info: {
        id: `${sessionId}-current-assistant`,
        sessionID: sessionId,
        role: "assistant",
        parentID: `${sessionId}-current`,
        time: { created: 2, completed: 3 },
      },
      parts: [{ type: "text", text: "x".repeat(25_000) }],
    });
    blockPosts = true;
    const overlappingIdle = hooks.event?.({
      event: {
        type: "session.status",
        properties: { sessionID: sessionId, status: { type: "idle" } },
      },
    } as never);
    await Promise.resolve();
    expect(postResolvers).toHaveLength(0);
    const output = { messages: structuredClone(messages) };
    const projection = hooks["experimental.chat.messages.transform"]?.(
      {},
      output as never,
    );
    await Promise.resolve();
    expect(summaryGets).toBe(0);

    releaseList?.();
    await vi.waitFor(() => expect(postResolvers).toHaveLength(1));
    postResolvers.shift()?.();
    await Promise.all([firstIdle, overlappingIdle, projection]);
    expect(client.session.messages).toHaveBeenCalledTimes(2);
    expect(summaryGets).toBe(1);
  });

  it("retries summary loading when a target update registers during the GET", async () => {
    const sessionId = "summary-revision-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    let releaseFirstGet: (() => void) | undefined;
    let summaryGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") return ok();
        summaryGets += 1;
        if (summaryGets === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirstGet = () =>
              resolve(ok({ session_id: sessionId, segments: [] }));
          });
        }
        return ok({ session_id: sessionId, segments: [] });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const output = { messages: structuredClone(messages) };
    const projection = hooks["experimental.chat.messages.transform"]?.(
      {},
      output as never,
    );
    await vi.waitFor(() => expect(summaryGets).toBe(1));

    const idle = hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);
    await vi.waitFor(() =>
      expect(client.session.messages).toHaveBeenCalledOnce(),
    );
    releaseFirstGet?.();
    await Promise.all([projection, idle]);

    expect(summaryGets).toBe(2);
  });

  it("coalesces duplicate idle events and abandons a snapshot that became busy", async () => {
    const sessionId = "busy-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    client.session.status
      .mockResolvedValue({ data: { [sessionId]: { type: "busy" } } })
      .mockResolvedValueOnce({ data: {} });
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const hooks = await Reflection(pluginInput(client));

    await Promise.all([
      hooks.event?.({
        event: { type: "session.idle", properties: { sessionID: sessionId } },
      } as never),
      hooks.event?.({
        event: {
          type: "session.status",
          properties: { sessionID: sessionId, status: { type: "idle" } },
        },
      } as never),
    ]);

    expect(client.session.messages).toHaveBeenCalledOnce();
    expect(client.session.status).toHaveBeenCalledTimes(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reruns an overlapping idle event when the session changed", async () => {
    const sessionId = "idle-rerun-session";
    const messages = projectionMessages(sessionId);
    const firstSnapshot = structuredClone(messages);
    const client = clientFor(messages);
    client.session.messages
      .mockResolvedValue({ data: messages })
      .mockResolvedValueOnce({ data: firstSnapshot });
    const postResolvers: Array<() => void> = [];
    const submittedBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method !== "POST") return ok();
        submittedBodies.push(JSON.parse(String(init.body)));
        await new Promise<void>((resolve) => postResolvers.push(resolve));
        return ok();
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const firstIdle = hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);
    await vi.waitFor(() => expect(postResolvers).toHaveLength(1));
    messages.push({
      info: {
        id: `${sessionId}-current-assistant`,
        sessionID: sessionId,
        role: "assistant",
        parentID: `${sessionId}-current`,
        time: { created: 2, completed: 3 },
      },
      parts: [{ type: "text", text: "x".repeat(25_000) }],
    });
    const overlappingIdle = hooks.event?.({
      event: {
        type: "session.status",
        properties: { sessionID: sessionId, status: { type: "idle" } },
      },
    } as never);

    for (let index = 0; index < 2; index += 1) {
      postResolvers.shift()?.();
      if (index < 1) {
        await vi.waitFor(() => expect(postResolvers).toHaveLength(1));
      }
    }
    await Promise.all([firstIdle, overlappingIdle]);

    expect(client.session.messages).toHaveBeenCalledTimes(2);
    expect(submittedBodies).toHaveLength(2);
    expect(submittedBodies.at(-1)).toMatchObject({
      messages: [
        { role: "user", text: "continue" },
        { role: "assistant", text: "x".repeat(25_000) },
      ],
    });
  });

  it("aborts in-flight target ingestion when a session is deleted", async () => {
    const sessionId = "deleted-session";
    const client = clientFor(projectionMessages(sessionId));
    let postSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method !== "POST") return ok();
        postSignal = init.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          postSignal?.addEventListener(
            "abort",
            () => reject(postSignal?.reason),
            {
              once: true,
            },
          );
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const idle = hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);
    await vi.waitFor(() => expect(postSignal).toBeDefined());

    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: sessionId } },
      },
    } as never);
    await idle;

    expect(postSignal?.aborted).toBe(true);
  });

  it("does not ingest a deleted session from a stale inactive-session list", async () => {
    const sessionId = "active-session";
    const deletedSessionId = "stale-deleted-session";
    const client = clientFor(projectionMessages(sessionId));
    let releaseList: (() => void) | undefined;
    client.session.list.mockImplementation(
      async () =>
        new Promise<{ data: Array<{ id: string; time: { updated: number } }> }>(
          (resolve) => {
            releaseList = () =>
              resolve({
                data: [
                  {
                    id: deletedSessionId,
                    time: { updated: Date.now() - 1_000_000 },
                  },
                ],
              });
          },
        ),
    );
    const submittedSessions: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          submittedSessions.push(JSON.parse(String(init.body)).session_id);
        }
        return ok();
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const idle = hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);
    await vi.waitFor(() => expect(client.session.list).toHaveBeenCalledOnce());
    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: deletedSessionId } },
      },
    } as never);
    releaseList?.();
    await idle;

    expect(submittedSessions).not.toContain(deletedSessionId);
  });

  it("rejects a transform that starts after the session was deleted", async () => {
    const sessionId = "deleted-transform-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    const hooks = await Reflection(pluginInput(client));
    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: sessionId } },
      },
    } as never);

    await expect(
      hooks["experimental.chat.messages.transform"]?.({}, {
        messages: structuredClone(messages),
      } as never),
    ).rejects.toThrow("was deleted before context projection");
    expect(client.provider.list).not.toHaveBeenCalled();
  });

  it("syncs closed targets before summary GET after plugin restart", async () => {
    const sessionId = "restart-target-sync-session";
    const messages = projectionMessages(sessionId);
    const firstClient = clientFor(messages);
    const secondClient = clientFor(messages);
    const submittedBodies: Array<Record<string, unknown>> = [];
    let targetPosts = 0;
    let summaryGets = 0;
    let synced = false;
    let releaseRestartSync: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          targetPosts += 1;
          submittedBodies.push(JSON.parse(String(init.body)));
          if (targetPosts === 1) {
            return new Response("failed", { status: 500 });
          }
          if (targetPosts === 2) {
            return new Promise<Response>((resolve) => {
              releaseRestartSync = () => {
                synced = true;
                resolve(ok());
              };
            });
          }
          return ok();
        }
        summaryGets += 1;
        return ok({
          session_id: sessionId,
          segments: [
            {
              id: synced ? "fresh-summary" : "stale-summary",
              start_user_message_id: `${sessionId}-old-user`,
              end_user_message_id: `${sessionId}-old-user`,
              projection_version: 1,
              summary: synced ? "FRESH SUMMARY" : "STALE SUMMARY",
            },
          ],
        });
      }),
    );
    const firstHooks = await Reflection(pluginInput(firstClient));
    await firstHooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);

    const secondHooks = await Reflection(pluginInput(secondClient));
    const output = { messages: structuredClone(messages) };
    const projection = secondHooks["experimental.chat.messages.transform"]?.(
      {},
      output as never,
    );
    await vi.waitFor(() => expect(releaseRestartSync).toBeDefined());
    expect(summaryGets).toBe(0);

    releaseRestartSync?.();
    await projection;
    const context = output.messages[1]?.parts[0]?.text;
    expect(summaryGets).toBe(1);
    expect(context).toContain("FRESH SUMMARY");
    expect(context).not.toContain("STALE SUMMARY");
    expect(submittedBodies).toHaveLength(2);
    expect(submittedBodies).not.toContainEqual(
      expect.objectContaining({
        start_user_message_id: `${sessionId}-current`,
      }),
    );

    rmSync(
      join(
        paths.home,
        ".local",
        "state",
        "reflection",
        "projection",
        `${encodeURIComponent(sessionId)}.json`,
      ),
      { force: true },
    );
    await secondHooks["experimental.chat.messages.transform"]?.({}, {
      messages: structuredClone(messages),
    } as never);
    expect(targetPosts).toBe(2);
    expect(summaryGets).toBe(2);
  });

  it("makes reset lossy without GET when initial closed sync fails", async () => {
    const sessionId = "reset-sync-failure-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    const submittedBodies: Array<Record<string, unknown>> = [];
    let summaryGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          submittedBodies.push(JSON.parse(String(init.body)));
          return new Response("failed", { status: 500 });
        }
        summaryGets += 1;
        return ok({ session_id: sessionId, segments: [] });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const output = { messages: structuredClone(messages) };

    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    expect(summaryGets).toBe(0);
    expect(submittedBodies).toHaveLength(1);
    expect(submittedBodies[0]).toMatchObject({
      start_user_message_id: `${sessionId}-old-user`,
    });
    expect(submittedBodies).not.toContainEqual(
      expect.objectContaining({
        start_user_message_id: `${sessionId}-current`,
      }),
    );
    expect(output.messages[1]?.parts[0]?.text).toContain(
      "Reflection summaries were unavailable",
    );
  });

  it("bounds initial reset sync and never posts the open segment", async () => {
    vi.useFakeTimers();
    const sessionId = "reset-sync-timeout-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    const submittedBodies: Array<Record<string, unknown>> = [];
    let summaryGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          submittedBodies.push(JSON.parse(String(init.body)));
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          });
        }
        summaryGets += 1;
        return ok({ session_id: sessionId, segments: [] });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const output = { messages: structuredClone(messages) };
    const projection = hooks["experimental.chat.messages.transform"]?.(
      {},
      output as never,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(submittedBodies).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await projection;

    expect(summaryGets).toBe(0);
    expect(submittedBodies).not.toContainEqual(
      expect.objectContaining({
        start_user_message_id: `${sessionId}-current`,
      }),
    );
    expect(output.messages[1]?.parts[0]?.text).toContain(
      "Reflection summaries were unavailable",
    );
  });

  it("keeps a target failure through a later busy no-op", async () => {
    const sessionId = "failed-target-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    let summaryGets = 0;
    let targetPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          targetPosts += 1;
          return new Response("failed", { status: 500 });
        }
        summaryGets += 1;
        return ok({ session_id: sessionId, segments: [] });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);
    client.session.status.mockResolvedValue({
      data: { [sessionId]: { type: "busy" } },
    });
    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);

    const output = { messages: structuredClone(messages) };
    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    expect(targetPosts).toBe(2);
    expect(summaryGets).toBe(0);
    expect(output.messages[1]?.parts[0]?.text).toContain(
      "Reflection summaries were unavailable",
    );
  });

  it("keeps a failed target through an SDK-resolved message-list error", async () => {
    const sessionId = "resolved-message-error-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    let resolveWithError = false;
    client.session.messages.mockImplementation(async () =>
      resolveWithError
        ? ({ error: { name: "NotFoundError" } } as never)
        : { data: messages },
    );
    let targetPosts = 0;
    let summaryGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          targetPosts += 1;
          return new Response("failed", { status: 500 });
        }
        summaryGets += 1;
        return ok({
          session_id: sessionId,
          segments: [
            {
              id: "stale-summary",
              start_user_message_id: `${sessionId}-old-user`,
              end_user_message_id: `${sessionId}-old-user`,
              projection_version: 1,
              summary: "STALE LOSSLESS SUMMARY",
            },
          ],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const idle = {
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never;

    await hooks.event?.(idle);
    resolveWithError = true;
    await hooks.event?.(idle);
    const output = { messages: structuredClone(messages) };
    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    const context = output.messages[1]?.parts[0]?.text;
    expect(targetPosts).toBe(2);
    expect(summaryGets).toBe(0);
    expect(context).toContain("Reflection summaries were unavailable");
    expect(context).not.toContain("STALE LOSSLESS SUMMARY");
    expect(client.session.messages).toHaveBeenCalledWith({
      path: { id: sessionId },
      query: { directory: "/tmp" },
      throwOnError: true,
    });
  });

  it("keeps a present failed boundary through capture error and unrelated success", async () => {
    const sessionId = "present-failure-session";
    const original = projectionMessages(sessionId);
    const presentHistory = projectionMessages(sessionId);
    const failedSegmentKey = `${sessionId}-old-user`;
    const newClosedKey = `${sessionId}-new-closed`;
    presentHistory[0]!.info.id = newClosedKey;
    presentHistory[1]!.info.parentID = newClosedKey;
    presentHistory[2]!.info.id = failedSegmentKey;
    let currentMessages = original;
    let failCapture = false;
    const client = clientFor(original);
    client.session.messages.mockImplementation(async () => {
      if (failCapture) throw new Error("capture failed");
      return { data: currentMessages };
    });
    let targetPosts = 0;
    let summaryGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          targetPosts += 1;
          return targetPosts === 1
            ? new Response("failed", { status: 500 })
            : ok();
        }
        summaryGets += 1;
        return ok({ session_id: sessionId, segments: [] });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const idle = {
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never;

    await hooks.event?.(idle);
    failCapture = true;
    await hooks.event?.(idle);
    failCapture = false;
    currentMessages = presentHistory;
    await hooks.event?.(idle);
    const output = { messages: structuredClone(presentHistory) };
    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    expect(targetPosts).toBe(2);
    expect(summaryGets).toBe(0);
    expect(output.messages[1]?.parts[0]?.text).toContain(
      "Reflection summaries were unavailable",
    );
  });

  it("retries a failed closed segment and caches the successful submission", async () => {
    const sessionId = "failed-segment-retry-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    let targetPosts = 0;
    let summaryGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          targetPosts += 1;
          return targetPosts === 1
            ? new Response("failed", { status: 500 })
            : ok();
        }
        summaryGets += 1;
        return ok({ session_id: sessionId, segments: [] });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const idle = {
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never;

    await hooks.event?.(idle);
    await hooks.event?.(idle);
    await hooks.event?.(idle);
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: structuredClone(messages),
    } as never);

    expect(targetPosts).toBe(2);
    expect(summaryGets).toBe(1);
  });

  it("clears a failed closed boundary after replacement-history rewind", async () => {
    const sessionId = "replacement-rewind-session";
    const original = projectionMessages(sessionId);
    const replacement = projectionMessages(sessionId);
    const replacementUserId = `${sessionId}-replacement-user`;
    const replacementAssistantId = `${sessionId}-replacement-assistant`;
    replacement[0]!.info.id = replacementUserId;
    replacement[1]!.info.id = replacementAssistantId;
    replacement[1]!.info.parentID = replacementUserId;
    let currentMessages = original;
    const client = clientFor(original);
    client.session.messages.mockImplementation(async () => ({
      data: currentMessages,
    }));
    let targetPosts = 0;
    let summaryGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          targetPosts += 1;
          return targetPosts === 1
            ? new Response("failed", { status: 500 })
            : ok();
        }
        summaryGets += 1;
        return ok({
          session_id: sessionId,
          segments: [
            {
              id: "replacement-summary",
              start_user_message_id: replacementUserId,
              end_user_message_id: replacementUserId,
              projection_version: 1,
              summary: "Exact replacement summary",
            },
          ],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const idle = {
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never;

    await hooks.event?.(idle);
    currentMessages = replacement;
    await hooks.event?.(idle);
    const output = { messages: structuredClone(replacement) };
    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    const context = output.messages
      .flatMap((message) => message.parts)
      .find((part) => part.synthetic === true)?.text;
    expect(targetPosts).toBe(2);
    expect(summaryGets).toBe(1);
    expect(context).toContain("Exact replacement summary");
    expect(context).not.toContain("Reflection summaries were unavailable");
  });

  it("clears a failed closed boundary after rewind to empty history", async () => {
    const sessionId = "empty-rewind-session";
    const original = projectionMessages(sessionId);
    let currentMessages = original;
    const client = clientFor(original);
    client.session.messages.mockImplementation(async () => ({
      data: currentMessages,
    }));
    let targetPosts = 0;
    let summaryGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          targetPosts += 1;
          return targetPosts === 1
            ? new Response("failed", { status: 500 })
            : ok();
        }
        summaryGets += 1;
        return ok({
          session_id: sessionId,
          segments: [
            {
              id: "post-rewind-summary",
              start_user_message_id: `${sessionId}-replacement-user`,
              end_user_message_id: `${sessionId}-replacement-user`,
              projection_version: 1,
              summary: "Post-rewind summary",
            },
          ],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const idle = {
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never;

    await hooks.event?.(idle);
    currentMessages = [];
    await hooks.event?.(idle);

    const replacement = projectionMessages(sessionId);
    replacement[0]!.info.id = `${sessionId}-replacement-user`;
    replacement[1]!.info.id = `${sessionId}-replacement-assistant`;
    replacement[1]!.info.parentID = `${sessionId}-replacement-user`;
    const output = { messages: structuredClone(replacement) };
    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    expect(targetPosts).toBe(2);
    expect(summaryGets).toBe(1);
    expect(output.messages[1]?.parts[0]?.text).toContain("Post-rewind summary");
  });

  it("never rejects when queued idle finish work fails", async () => {
    const sessionId = "detached-finish-failure-session";
    const client = clientFor(projectionMessages(sessionId));
    client.session.list.mockRejectedValue(new Error("list failed"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok()),
    );
    const hooks = await Reflection(pluginInput(client));

    await expect(
      Promise.all([
        hooks.event?.({
          event: { type: "session.idle", properties: { sessionID: sessionId } },
        } as never),
        hooks.event?.({
          event: {
            type: "session.status",
            properties: { sessionID: sessionId, status: { type: "idle" } },
          },
        } as never),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    expect(client.app.log).toHaveBeenCalledWith({
      body: {
        service: "reflection",
        level: "warn",
        message: expect.stringContaining(
          "idle hook failed: Error: list failed",
        ),
      },
    });
  });

  it("bounds the aggregate foreground target wait to five seconds", async () => {
    vi.useFakeTimers();
    const sessionId = "target-timeout-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    let summaryGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          });
        }
        summaryGets += 1;
        return ok({ session_id: sessionId, segments: [] });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const idle = hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);
    await vi.advanceTimersByTimeAsync(0);
    const output = { messages: structuredClone(messages) };
    const projection = hooks["experimental.chat.messages.transform"]?.(
      {},
      output as never,
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([idle, projection]);

    expect(summaryGets).toBe(0);
    expect(output.messages[1]?.parts[0]?.text).toContain(
      "Reflection summaries were unavailable",
    );
  });

  it("inserts one persisted warning before paired idle work", async () => {
    const sessionId = "warning-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
        init?.method === "POST"
          ? ok()
          : ok({ session_id: sessionId, segments: [] }),
      ),
    );
    const hooks = await Reflection(pluginInput(client));
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: structuredClone(messages),
    } as never);

    let resolveWarning: (() => void) | undefined;
    client.session.prompt.mockImplementation(
      async () =>
        new Promise<{ data: Record<string, never> }>((resolve) => {
          resolveWarning = () => resolve({ data: {} });
        }),
    );
    const firstIdle = hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);
    const pairedIdle = hooks.event?.({
      event: {
        type: "session.status",
        properties: { sessionID: sessionId, status: { type: "idle" } },
      },
    } as never);

    expect(client.session.prompt).toHaveBeenCalledOnce();
    expect(client.session.status).not.toHaveBeenCalled();
    expect(client.session.messages).not.toHaveBeenCalled();
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.prompt).toHaveBeenCalledWith({
      path: { id: sessionId },
      query: { directory: "/tmp" },
      body: {
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
        noReply: true,
        parts: [
          {
            type: "text",
            text: PROJECTION_LOSS_WARNING,
            synthetic: false,
            ignored: false,
            metadata: {
              reflection: { type: "projection-loss-warning", version: 1 },
            },
          },
        ],
      },
      throwOnError: true,
    });
    expect(client.session.prompt.mock.calls[0]?.[0]?.body).not.toHaveProperty(
      "variant",
    );

    resolveWarning?.();
    await Promise.all([firstIdle, pairedIdle]);
    expect(client.session.prompt).toHaveBeenCalledOnce();
    expect(client.tui.showToast).not.toHaveBeenCalled();
  });

  it("preserves the active model variant in persisted warning insertion", async () => {
    const sessionId = "warning-variant-session";
    const messages = projectionMessages(sessionId);
    const activeUser = messages.find(
      (message) => message.info.id === `${sessionId}-current`,
    );
    if (!activeUser?.info.model) throw new Error("active user model missing");
    activeUser.info.model.variant = "xhigh";
    const client = clientFor(messages);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
        init?.method === "POST"
          ? ok()
          : ok({ session_id: sessionId, segments: [] }),
      ),
    );
    const hooks = await Reflection(pluginInput(client));
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: structuredClone(messages),
    } as never);

    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);

    expect(client.session.prompt).toHaveBeenCalledOnce();
    expect(client.session.prompt.mock.calls[0]?.[0]?.body).toMatchObject({
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      variant: "xhigh",
      noReply: true,
    });
  });

  it("retries failed persisted warning insertion until success", async () => {
    const sessionId = "warning-retry-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    client.session.prompt
      .mockResolvedValueOnce({ error: new Error("insert failed") } as never)
      .mockRejectedValueOnce(new Error("session disconnected"))
      .mockResolvedValue({ data: {} });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
        init?.method === "POST"
          ? ok()
          : ok({ session_id: sessionId, segments: [] }),
      ),
    );
    const hooks = await Reflection(pluginInput(client));
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: structuredClone(messages),
    } as never);
    const idle = {
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never;

    await hooks.event?.(idle);
    await hooks.event?.(idle);
    await hooks.event?.(idle);
    await hooks.event?.(idle);

    expect(client.session.prompt).toHaveBeenCalledTimes(3);
    expect(client.tui.showToast).not.toHaveBeenCalled();
  });

  it("does not recover an uninserted warning after plugin restart", async () => {
    const sessionId = "warning-restart-session";
    const messages = projectionMessages(sessionId);
    const firstClient = clientFor(messages);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
        init?.method === "POST"
          ? ok()
          : ok({ session_id: sessionId, segments: [] }),
      ),
    );
    const firstHooks = await Reflection(pluginInput(firstClient));
    await firstHooks["experimental.chat.messages.transform"]?.({}, {
      messages: structuredClone(messages),
    } as never);

    const secondClient = clientFor(messages);
    const secondHooks = await Reflection(pluginInput(secondClient));
    await secondHooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);

    expect(firstClient.session.prompt).not.toHaveBeenCalled();
    expect(secondClient.session.prompt).not.toHaveBeenCalled();
  });

  it("accepts concurrent user persistence before noReply warning completion", async () => {
    const sessionId = "warning-overlap-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
        init?.method === "POST"
          ? ok()
          : ok({ session_id: sessionId, segments: [] }),
      ),
    );
    const hooks = await Reflection(pluginInput(client));
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: structuredClone(messages),
    } as never);

    let completeWarning: (() => void) | undefined;
    client.session.prompt.mockImplementation(
      async () =>
        new Promise<{ data: Record<string, never> }>((resolve) => {
          completeWarning = () => {
            messages.push({
              info: { id: "warning", sessionID: sessionId, role: "user" },
              parts: [
                {
                  type: "text",
                  text: PROJECTION_LOSS_WARNING,
                  synthetic: false,
                  ignored: false,
                  metadata: {
                    reflection: {
                      type: "projection-loss-warning",
                      version: 1,
                    },
                  },
                },
              ],
            });
            resolve({ data: {} });
          };
        }),
    );
    const idle = hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);
    messages.push({
      info: {
        id: "concurrent-user",
        sessionID: sessionId,
        role: "user",
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
      },
      parts: [{ type: "text", text: "concurrent request" }],
    });

    completeWarning?.();
    await idle;

    expect(messages.at(-2)?.info.id).toBe("concurrent-user");
    expect(messages.at(-1)?.info.id).toBe("warning");
    expect(client.session.prompt).toHaveBeenCalledOnce();
  });
});
