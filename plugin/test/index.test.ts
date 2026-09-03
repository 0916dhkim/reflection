import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  segmentMessages,
  submissionSourceFingerprint,
  type OpenCodeMessage,
  type ReflectionSegment,
} from "@reflection/shared/segmentation";
import { parseJobResponse } from "@reflection/shared/contracts";
import {
  segmentIdForRequest,
  sourceFingerprint,
} from "@reflection/shared/domain";

const paths = vi.hoisted(() => ({
  home: `/tmp/reflection-plugin-test-${process.pid}`,
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => paths.home,
}));

import { Reflection } from "../src/index.js";

function segmentId(sessionId: string, segment: ReflectionSegment): string {
  return segmentIdForRequest({
    session_id: sessionId,
    start_user_message_id: segment.startUserMessageId,
    source_boundary_version: segment.sourceBoundaryVersion,
    start_source_message_id: segment.startSourceMessageId,
  });
}

function segmentWireBoundary(segment: ReflectionSegment) {
  return segment.sourceBoundaryVersion === 1
    ? {
        source_boundary_version: 1 as const,
        start_source_message_id: null,
        end_source_message_id: null,
      }
    : {
        source_boundary_version: 2 as const,
        start_source_message_id: segment.startSourceMessageId!,
        end_source_message_id: segment.endSourceMessageId!,
      };
}

function segmentSummary(
  sessionId: string,
  segment: ReflectionSegment,
  summary: string,
) {
  return {
    id: segmentId(sessionId, segment),
    start_user_message_id: segment.startUserMessageId,
    end_user_message_id: segment.endUserMessageId,
    ...segmentWireBoundary(segment),
    projection_version: segment.projectionVersion ?? 1,
    summary,
  };
}

function segmentBoundary(
  sessionId: string,
  segment: ReflectionSegment,
  sourceFingerprint = submissionSourceFingerprint(sessionId, segment),
) {
  return {
    id: segmentId(sessionId, segment),
    start_user_message_id: segment.startUserMessageId,
    end_user_message_id: segment.endUserMessageId,
    ...segmentWireBoundary(segment),
    projection_version: segment.projectionVersion ?? 1,
    source_eligible: true,
    source_fingerprint: sourceFingerprint,
  };
}

function segmentTarget(sessionId: string, segment: ReflectionSegment) {
  return {
    id: segmentId(sessionId, segment),
    start_user_message_id: segment.startUserMessageId,
    end_user_message_id: segment.endUserMessageId,
    ...segmentWireBoundary(segment),
    projection_version: segment.projectionVersion ?? 1,
    status: "running",
    source_fingerprint: submissionSourceFingerprint(sessionId, segment),
  };
}

function segmentFingerprint(
  sessionId: string,
  messages: readonly OpenCodeMessage[],
  startUserMessageId: string,
): string {
  const segment = segmentMessages(messages).find(
    (candidate) => candidate.startUserMessageId === startUserMessageId,
  );
  if (!segment) throw new Error(`missing segment ${startUserMessageId}`);
  return submissionSourceFingerprint(sessionId, segment);
}

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

function siblingProjectionMessages(sessionId: string): OpenCodeMessage[] {
  return [
    {
      info: {
        id: `${sessionId}-turn`,
        sessionID: sessionId,
        role: "user",
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
      },
      parts: [{ type: "text", text: "request" }],
    },
    {
      info: {
        id: `${sessionId}-step-1`,
        sessionID: sessionId,
        role: "assistant",
        parentID: `${sessionId}-turn`,
        providerID: "provider",
        modelID: "model",
        time: { created: 0, completed: 1 },
        finish: "tool-calls",
        tokens: {
          input: 100_000,
          output: 1_000,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
      parts: [{ type: "text", text: "a".repeat(25_000) }],
    },
    {
      info: {
        id: `${sessionId}-step-2`,
        sessionID: sessionId,
        role: "assistant",
        parentID: `${sessionId}-turn`,
        providerID: "provider",
        modelID: "model",
        time: { created: 2, completed: 3 },
        finish: "stop",
      },
      parts: [{ type: "text", text: "b".repeat(25_000) }],
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

function v2Manifest(data: unknown): unknown {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return data;
  }
  const value = data as Record<string, unknown>;
  if (
    typeof value.session_id !== "string" ||
    !Array.isArray(value.segments) ||
    !Array.isArray(value.boundaries) ||
    !Array.isArray(value.targets)
  ) {
    return data;
  }
  const boundary = (item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return item;
    }
    const current = item as Record<string, unknown>;
    const sourceBoundaryVersion = current.source_boundary_version ?? 1;
    const startSourceMessageId =
      sourceBoundaryVersion === 1 ? null : current.start_source_message_id;
    const normalized: Record<string, unknown> = {
      ...current,
      source_boundary_version: sourceBoundaryVersion,
      start_source_message_id: startSourceMessageId,
      end_source_message_id:
        sourceBoundaryVersion === 1 ? null : current.end_source_message_id,
    };
    if (
      typeof normalized["start_user_message_id"] === "string" &&
      (typeof normalized["id"] !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          normalized["id"],
        ))
    ) {
      normalized["id"] = segmentIdForRequest({
        session_id: value.session_id as string,
        start_user_message_id: normalized["start_user_message_id"],
        source_boundary_version: sourceBoundaryVersion as 1 | 2,
        start_source_message_id: startSourceMessageId as string | null,
      });
    }
    return normalized;
  };
  return {
    ...value,
    manifest_version: value.manifest_version ?? 2,
    segments: value.segments.map(boundary),
    boundaries: value.boundaries.map(boundary),
    targets: value.targets.map(boundary),
  };
}

function ok(data: unknown = {}): Response {
  return new Response(JSON.stringify(v2Manifest(data)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function acceptedSegment(
  init: RequestInit | undefined,
  status = "pending",
): Response {
  const body = JSON.parse(String(init?.body));
  return ok(segmentJob(body, status));
}

function segmentJob(
  body: Parameters<typeof sourceFingerprint>[0],
  status = "pending",
) {
  const job = {
    id: 1,
    segment_id: segmentIdForRequest(body),
    start_user_message_id: body.start_user_message_id,
    end_user_message_id: body.end_user_message_id,
    source_boundary_version: body.source_boundary_version,
    start_source_message_id: body.start_source_message_id,
    end_source_message_id: body.end_source_message_id,
    source_fingerprint: sourceFingerprint(body),
    projection_version: body.projection_version,
    status,
    attempts: 0,
    error: status === "failed" ? "failed" : null,
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    finished_at: null,
    next_attempt_at: "2026-01-01T00:00:00.000Z",
  };
  parseJobResponse(job);
  return job;
}

function emptyListing(
  url: string | URL | Request,
  init?: RequestInit,
): Response {
  if (init?.method === "POST") return acceptedSegment(init);
  const match = String(url).match(/\/v1\/sessions\/([^/]+)\/segments/);
  return ok({
    session_id: match ? decodeURIComponent(match[1]!) : "unknown",
    segments: [],
    boundaries: [],
    targets: [],
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

  it("rejects a session manifest without strict version 2 metadata", async () => {
    const sessionId = "strict-manifest-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              manifest_version: 1,
              session_id: sessionId,
              segments: [],
              boundaries: [],
              targets: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const hooks = await Reflection(pluginInput(client));

    await expect(
      hooks["experimental.chat.messages.transform"]?.({}, {
        messages: structuredClone(messages),
      } as never),
    ).rejects.toThrow("invalid segment summaries");
  });

  it("rejects manifest entries without explicit source boundaries", async () => {
    const sessionId = "strict-boundary-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              manifest_version: 2,
              session_id: sessionId,
              segments: [
                {
                  id: segmentIdForRequest({
                    session_id: sessionId,
                    start_user_message_id: `${sessionId}-old-user`,
                    source_boundary_version: 1,
                    start_source_message_id: null,
                  }),
                  start_user_message_id: `${sessionId}-old-user`,
                  end_user_message_id: `${sessionId}-old-user`,
                  projection_version: 1,
                  summary: "missing source fields",
                },
              ],
              boundaries: [],
              targets: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const hooks = await Reflection(pluginInput(client));

    await expect(
      hooks["experimental.chat.messages.transform"]?.({}, {
        messages: structuredClone(messages),
      } as never),
    ).rejects.toThrow("invalid segment summaries");
  });

  it("hydrates only the exact V2 source span in memory_read_segment", async () => {
    const sessionId = "exact-memory-session";
    const messages = siblingProjectionMessages(sessionId);
    const segment = segmentMessages(messages).find(
      (candidate) => candidate.startMessageId === `${sessionId}-step-2`,
    );
    if (!segment || segment.sourceBoundaryVersion !== 2) {
      throw new Error("expected an assistant-starting V2 segment");
    }
    const id = segmentId(sessionId, segment);
    const client = clientFor(messages);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ok({
          id,
          session_id: sessionId,
          start_user_message_id: segment.startUserMessageId,
          end_user_message_id: segment.endUserMessageId,
          ...segmentWireBoundary(segment),
          summary: "Second tool step",
          claims: [],
          created_at: "2026-08-22T00:00:00Z",
          updated_at: "2026-08-22T00:00:00Z",
        }),
      ),
    );
    const hooks = await Reflection(pluginInput(client));
    const reader = hooks.tool?.memory_read_segment as unknown as {
      execute(
        args: { segment_id: string },
        context: { abort: AbortSignal },
      ): Promise<string>;
    };

    const result = JSON.parse(
      await reader.execute(
        { segment_id: id },
        { abort: new AbortController().signal },
      ),
    );

    expect(result).toMatchObject({
      segment_id: id,
      session_id: sessionId,
      source_boundary_version: 2,
      start_source_message_id: `${sessionId}-step-2`,
      end_source_message_id: `${sessionId}-step-2`,
      messages: [{ role: "assistant", text: "b".repeat(25_000) }],
    });
  });

  it("propagates memory_read_segment cancellation into SDK hydration", async () => {
    const sessionId = "cancelled-memory-session";
    const messages = projectionMessages(sessionId);
    const segment = segmentMessages(messages)[0]!;
    const id = segmentId(sessionId, segment);
    const client = clientFor(messages);
    let hydrationSignal: AbortSignal | undefined;
    client.session.messages.mockImplementation(async (input) => {
      hydrationSignal = (input as { signal?: AbortSignal }).signal;
      return new Promise<{ data: OpenCodeMessage[] }>((_resolve, reject) => {
        hydrationSignal?.addEventListener(
          "abort",
          () => reject(hydrationSignal?.reason),
          { once: true },
        );
      });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ok({
          id,
          session_id: sessionId,
          start_user_message_id: segment.startUserMessageId,
          end_user_message_id: segment.endUserMessageId,
          ...segmentWireBoundary(segment),
          summary: "summary",
          claims: [],
          created_at: "2026-08-22T00:00:00Z",
          updated_at: "2026-08-22T00:00:00Z",
        }),
      ),
    );
    const hooks = await Reflection(pluginInput(client));
    const reader = hooks.tool?.memory_read_segment as unknown as {
      execute(
        args: { segment_id: string },
        context: { abort: AbortSignal },
      ): Promise<string>;
    };
    const cancellation = new AbortController();
    const pending = reader.execute(
      { segment_id: id },
      { abort: cancellation.signal },
    );
    await vi.waitFor(() => expect(hydrationSignal).toBeDefined());

    const reason = new Error("tool cancelled");
    cancellation.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(hydrationSignal?.aborted).toBe(true);
  });

  it("serializes target updates and waits for all pending updates before loading summaries", async () => {
    const sessionId = "serialized-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    const submittedBodies: Array<Record<string, unknown>> = [];
    const postResolvers: Array<() => void> = [];
    let activePosts = 0;
    let maxActivePosts = 0;
    let postCount = 0;
    let summaryGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          submittedBodies.push(JSON.parse(String(init.body)));
          postCount += 1;
          activePosts += 1;
          maxActivePosts = Math.max(maxActivePosts, activePosts);
          await new Promise<void>((resolve) => postResolvers.push(resolve));
          activePosts -= 1;
          return acceptedSegment(init);
        }
        summaryGets += 1;
        return ok({
          session_id: sessionId,
          segments: [],
          boundaries: [],
          targets: [],
        });
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
    expect(summaryGets).toBe(1);

    postResolvers.shift()?.();
    await vi.waitFor(() => expect(postResolvers).toHaveLength(1));
    expect(summaryGets).toBe(3);
    postResolvers.shift()?.();

    await Promise.all([firstIdle, secondIdle, projection]);
    expect(maxActivePosts).toBe(1);
    expect(submittedBodies.map((body) => body.processing_priority)).toEqual([
      50, 100,
    ]);
    expect(summaryGets).toBe(4);
    expect(client.session.messages).toHaveBeenCalledTimes(3);
    expect(client.session.status).toHaveBeenCalledTimes(4);
    expect(output.messages[0]?.parts[0]?.text).toContain(
      "Reflection compacted older context with omissions",
    );

    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);
    expect(postCount).toBe(2);
  });

  it("posts only newly closed segments on active idle", async () => {
    const sessionId = "snapshot-retry-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    const submittedBodies: Array<Record<string, unknown>> = [];
    let targetPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          targetPosts += 1;
          submittedBodies.push(JSON.parse(String(init.body)));
        }
        return emptyListing(url, init);
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
      source_boundary_version: 2,
      start_source_message_id: `${sessionId}-old-user`,
      end_source_message_id: `${sessionId}-old-assistant`,
      processing_priority: 50,
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
      source_boundary_version: 2,
      start_source_message_id: `${sessionId}-current`,
      end_source_message_id: `${sessionId}-current-assistant`,
      processing_priority: 50,
    });
  });

  it("submits tool-only fallback sources at projection version 2", async () => {
    const sessionId = "tool-only-source-session";
    const messages: OpenCodeMessage[] = [
      {
        info: { id: "u1", sessionID: sessionId, role: "user" },
        parts: [{ type: "text", text: "x".repeat(19_990) }],
      },
      {
        info: {
          id: "a0",
          sessionID: sessionId,
          role: "assistant",
          parentID: "u1",
          time: { created: 0, completed: 1 },
          finish: "tool-calls",
        },
        parts: [{ type: "text", text: "first boundary" }],
      },
      {
        info: {
          id: "a1",
          sessionID: sessionId,
          role: "assistant",
          parentID: "u1",
          time: { created: 2, completed: 3 },
          finish: "tool-calls",
        },
        parts: [
          {
            type: "tool",
            tool: "read",
            state: { status: "completed", output: "x".repeat(25_000) },
          },
        ],
      },
      {
        info: { id: "u2", sessionID: sessionId, role: "user" },
        parts: [{ type: "text", text: "continue" }],
      },
    ];
    const client = clientFor(messages);
    const submittedBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          submittedBodies.push(JSON.parse(String(init.body)));
        }
        return emptyListing(url, init);
      }),
    );
    const hooks = await Reflection(pluginInput(client));

    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);

    const toolSubmission = submittedBodies.find(
      (body) => body.start_source_message_id === "a1",
    );
    expect(toolSubmission).toMatchObject({
      projection_version: 2,
      source_boundary_version: 2,
      start_source_message_id: "a1",
      end_source_message_id: "a1",
    });
    expect(
      (toolSubmission?.messages as Array<{ text: string }>)[0]?.text,
    ).toContain('[Tool "read"]');
  });

  it("quarantines an unsplittable closed span before HTTP submission", async () => {
    const sessionId = "oversized-source-session";
    const messages = projectionMessages(sessionId);
    messages[0]!.parts = [{ type: "text", text: "x".repeat(1_000_001) }];
    const client = clientFor(messages);
    let targetPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") targetPosts += 1;
        return emptyListing(url, init);
      }),
    );
    const hooks = await Reflection(pluginInput(client));

    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);

    expect(targetPosts).toBe(0);
    expect(client.app.log).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          message: expect.stringContaining("failed local validation"),
        }),
      }),
    );
  });

  it("keeps same-user sibling caches and cross-writer invalidation independent", async () => {
    const sessionId = "sibling-cache-session";
    const messages = siblingProjectionMessages(sessionId);
    const canonical = segmentMessages(messages);
    const siblings = canonical.filter(
      (segment) => segment.startUserMessageId === `${sessionId}-turn`,
    );
    expect(siblings).toHaveLength(2);
    expect(segmentId(sessionId, siblings[0]!)).not.toBe(
      segmentId(sessionId, siblings[1]!),
    );
    const client = clientFor(messages);
    let boundaries: unknown[] = [];
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          posted.push(JSON.parse(String(init.body)));
          return acceptedSegment(init);
        }
        const match = String(url).match(/\/v1\/sessions\/([^/]+)\/segments/);
        return ok({
          session_id: match ? decodeURIComponent(match[1]!) : sessionId,
          segments: [],
          boundaries,
          targets: [],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const idle = {
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never;

    await hooks.event?.(idle);
    await hooks.event?.(idle);
    expect(posted).toHaveLength(2);
    expect(posted.map((body) => body.processing_priority)).toEqual([50, 50]);
    expect(
      posted.map((body) =>
        segmentIdForRequest(body as Parameters<typeof segmentIdForRequest>[0]),
      ),
    ).toEqual(siblings.map((segment) => segmentId(sessionId, segment)));

    boundaries = [
      segmentBoundary(sessionId, siblings[0]!, "cross-writer-snapshot"),
      segmentBoundary(sessionId, siblings[1]!),
    ];
    await hooks.event?.(idle);
    expect(posted).toHaveLength(3);
    expect(
      segmentIdForRequest(
        posted[2] as Parameters<typeof segmentIdForRequest>[0],
      ),
    ).toBe(segmentId(sessionId, siblings[0]!));

    boundaries = siblings.map((segment) => segmentBoundary(sessionId, segment));
    messages[2]!.parts = [{ type: "text", text: "changed sibling source" }];
    await hooks.event?.(idle);
    expect(posted).toHaveLength(4);
    expect(
      segmentIdForRequest(
        posted[3] as Parameters<typeof segmentIdForRequest>[0],
      ),
    ).toBe(segmentId(sessionId, siblings[1]!));
  });

  it("promotes an active-idle submission once for foreground processing", async () => {
    const sessionId = "priority-promotion-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    const submittedBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          submittedBodies.push(JSON.parse(String(init.body)));
          return acceptedSegment(init);
        }
        return emptyListing(url, init);
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const idle = {
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never;

    await hooks.event?.(idle);
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: structuredClone(messages),
    } as never);
    expect(submittedBodies.map((body) => body.processing_priority)).toEqual([
      50, 100,
    ]);

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
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: structuredClone(messages),
    } as never);

    expect(submittedBodies.map((body) => body.processing_priority)).toEqual([
      50, 100,
    ]);
  });

  it("clears only a removed sibling failure after a history rewind", async () => {
    const sessionId = "sibling-rewind-session";
    const original = siblingProjectionMessages(sessionId);
    let currentMessages = original;
    const originalSegments = segmentMessages(original);
    const siblings = originalSegments.filter(
      (segment) => segment.startUserMessageId === `${sessionId}-turn`,
    );
    const retained = siblings[0]!;
    const removed = siblings[1]!;
    const client = clientFor(original);
    client.session.messages.mockImplementation(async () => ({
      data: currentMessages,
    }));
    let failRemoved = true;
    const postedIds: string[] = [];
    const postedPriorities: number[] = [];
    let manifest = {
      segments: [] as unknown[],
      boundaries: [] as unknown[],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          const id = segmentIdForRequest(body);
          postedIds.push(id);
          postedPriorities.push(body.processing_priority);
          if (id === segmentId(sessionId, removed) && failRemoved) {
            failRemoved = false;
            return new Response("failed", { status: 500 });
          }
          return acceptedSegment(init);
        }
        return ok({
          session_id: sessionId,
          segments: manifest.segments,
          boundaries: manifest.boundaries,
          targets: [],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const idle = {
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never;

    await hooks.event?.(idle);
    expect(postedIds).toEqual([
      segmentId(sessionId, retained),
      segmentId(sessionId, removed),
    ]);

    currentMessages = original.filter(
      (message) => message.info.id !== `${sessionId}-step-2`,
    );
    manifest = {
      segments: [segmentSummary(sessionId, retained, "Retained summary")],
      boundaries: [segmentBoundary(sessionId, retained)],
    };
    await hooks.event?.(idle);
    const output = { messages: structuredClone(currentMessages) };
    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    expect(postedIds).toEqual([
      segmentId(sessionId, retained),
      segmentId(sessionId, removed),
      segmentId(sessionId, retained),
    ]);
    expect(postedPriorities).toEqual([50, 50, 100]);
    expect(output.messages[0]?.parts[0]?.text).toContain("Retained summary");
    expect(output.messages[0]?.parts[0]?.text).not.toContain(
      "Reflection summaries were unavailable",
    );
  });

  it("plans and submits from one raw snapshot instead of filtered history", async () => {
    const sessionId = "raw-filtered-session";
    const raw = siblingProjectionMessages(sessionId);
    const filtered = raw.filter(
      (message) => message.info.id !== `${sessionId}-step-1`,
    );
    const visibleAssistant = filtered.find(
      (message) => message.info.id === `${sessionId}-step-2`,
    );
    visibleAssistant!.info.tokens = {
      input: 100_000,
      output: 1_000,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    };
    const client = clientFor(raw);
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          posted.push(JSON.parse(String(init.body)));
          return acceptedSegment(init);
        }
        return emptyListing(url, init);
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const output = { messages: structuredClone(filtered) };

    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    expect(client.session.messages).toHaveBeenCalledOnce();
    expect(posted).toHaveLength(2);
    expect(posted.every((body) => body.processing_priority === 100)).toBe(true);
    expect(posted[0]).toMatchObject({
      start_source_message_id: `${sessionId}-turn`,
      end_source_message_id: `${sessionId}-step-1`,
      messages: expect.arrayContaining([
        expect.objectContaining({ text: "a".repeat(25_000) }),
      ]),
    });
    expect(posted[1]).toMatchObject({
      start_source_message_id: `${sessionId}-step-2`,
      end_source_message_id: `${sessionId}-step-2`,
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
    let listedRevision = 0;
    client.session.list.mockImplementation(async () => ({
      data: [{ id: inactiveSessionId, time: { updated: listedRevision } }],
    }));
    client.session.messages.mockImplementation(async (input) => ({
      data:
        input?.path.id === inactiveSessionId
          ? inactiveMessages
          : activeMessages,
    }));
    const submittedBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          submittedBodies.push(JSON.parse(String(init.body)));
        }
        return emptyListing(url, init);
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const idle = {
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never;

    await hooks.event?.(idle);
    await vi.waitFor(() =>
      expect(
        submittedBodies.filter((body) => body.session_id === inactiveSessionId),
      ).toHaveLength(1),
    );
    await hooks.event?.(idle);
    await vi.waitFor(() =>
      expect(client.session.list).toHaveBeenCalledTimes(2),
    );
    expect(
      submittedBodies.filter((body) => body.session_id === inactiveSessionId),
    ).toHaveLength(1);

    if (inactiveMessages[0]) {
      inactiveMessages[0].parts = [
        ...inactiveMessages[0].parts,
        { type: "text", text: " updated" },
      ];
    }
    listedRevision = 1;
    await hooks.event?.(idle);
    await vi.waitFor(() =>
      expect(
        submittedBodies.filter((body) => body.session_id === inactiveSessionId),
      ).toHaveLength(2),
    );
    const inactiveBodies = submittedBodies.filter(
      (body) => body.session_id === inactiveSessionId,
    );
    expect(inactiveBodies).toHaveLength(2);
    expect(inactiveBodies[1]).toMatchObject({
      messages: [{ role: "user", text: "open request updated" }],
    });
  });

  it("waits for a completed assistant before snapshotting an open V2 span", async () => {
    const sessionId = "active-v2-sweep-session";
    const inactiveSessionId = "inactive-open-v2-session";
    const activeMessages = projectionMessages(sessionId);
    const inactiveMessages: OpenCodeMessage[] = [
      {
        info: {
          id: `${inactiveSessionId}-user`,
          sessionID: inactiveSessionId,
          role: "user",
          model: { providerID: "provider", modelID: "model" },
        },
        parts: [{ type: "text", text: "x".repeat(25_000) }],
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
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          submittedBodies.push(JSON.parse(String(init.body)));
        }
        return emptyListing(url, init);
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const idle = {
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never;

    await hooks.event?.(idle);
    expect(
      submittedBodies.filter((body) => body.session_id === inactiveSessionId),
    ).toHaveLength(0);

    inactiveMessages.push({
      info: {
        id: `${inactiveSessionId}-assistant`,
        sessionID: inactiveSessionId,
        role: "assistant",
        parentID: `${inactiveSessionId}-user`,
        time: { created: 1, completed: 2 },
      },
      parts: [{ type: "text", text: "done" }],
    });
    await hooks.event?.(idle);

    expect(
      submittedBodies.filter((body) => body.session_id === inactiveSessionId),
    ).toMatchObject([
      {
        source_boundary_version: 2,
        end_source_message_id: `${inactiveSessionId}-assistant`,
      },
    ]);
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
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          submittedBodies.push(JSON.parse(String(init.body)));
        }
        return emptyListing(url, init);
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
    await vi.waitFor(() =>
      expect(
        submittedBodies.filter((body) => body.session_id === inactiveSessionId),
      ).toHaveLength(1),
    );

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
    expect(client.session.get).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: inactiveSessionId },
        query: { directory: "/tmp" },
        signal: expect.any(AbortSignal),
      }),
    );
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
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
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
          return acceptedSegment(init);
        }
        summaryGets += 1;
        if (String(url).includes(encodeURIComponent(activeSessionId))) {
          return ok({
            session_id: activeSessionId,
            segments: [],
            boundaries: [],
            targets: [],
          });
        }
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
          boundaries: [
            {
              id: "closed-summary",
              start_user_message_id: `${inactiveSessionId}-old-user`,
              end_user_message_id: `${inactiveSessionId}-old-user`,
              projection_version: 1,
              source_eligible: true,
              source_fingerprint: segmentFingerprint(
                inactiveSessionId,
                inactiveMessages,
                `${inactiveSessionId}-old-user`,
              ),
            },
          ],
          targets: [],
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
    await vi.waitFor(() => expect(openAttempts).toBe(1));
    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: activeSessionId },
      },
    } as never);
    await vi.waitFor(() => expect(openAttempts).toBe(2));
    const output = { messages: structuredClone(inactiveMessages) };

    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    const context = output.messages
      .flatMap((message) => message.parts)
      .find((part) => part.synthetic === true)?.text;
    expect(summaryGets).toBe(6);
    expect(openAttempts).toBe(2);
    expect(context).toContain("Closed segment summary");
    expect(context).not.toContain(PROJECTION_LOSS_WARNING);
  });

  it("registers the target barrier before idle message capture", async () => {
    const sessionId = "capture-barrier-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    let releaseMessages: (() => void) | undefined;
    client.session.messages
      .mockResolvedValue({ data: messages })
      .mockImplementationOnce(
        async () =>
          new Promise<{ data: OpenCodeMessage[] }>((resolve) => {
            releaseMessages = () => resolve({ data: messages });
          }),
      );
    let summaryGets = 0;
    const submittedBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          submittedBodies.push(JSON.parse(String(init.body)));
          return acceptedSegment(init);
        }
        summaryGets += 1;
        return ok({
          session_id: sessionId,
          segments: [],
          boundaries: [],
          targets: [],
        });
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
    expect(submittedBodies).toHaveLength(0);
    releaseMessages?.();
    await Promise.all([idle, projection]);
    expect(submittedBodies.map((body) => body.processing_priority)).toEqual([
      50, 100,
    ]);
    expect(summaryGets).toBe(3);
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
    const submittedBodies: Array<Record<string, unknown>> = [];
    let summaryGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          submittedBodies.push(JSON.parse(String(init.body)));
          if (blockPosts) {
            await new Promise<void>((resolve) => postResolvers.push(resolve));
          }
          return acceptedSegment(init);
        }
        summaryGets += 1;
        return ok({
          session_id: sessionId,
          segments: [],
          boundaries: [],
          targets: [],
        });
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
    expect(summaryGets).toBe(1);

    releaseList?.();
    for (let index = 0; index < 3; index += 1) {
      await vi.waitFor(() => expect(postResolvers).toHaveLength(1));
      postResolvers.shift()?.();
    }
    await Promise.all([firstIdle, overlappingIdle, projection]);
    expect(client.session.messages).toHaveBeenCalledTimes(3);
    expect(submittedBodies.map((body) => body.processing_priority)).toEqual([
      50, 50, 100, 100,
    ]);
    expect(submittedBodies.map((body) => body.start_user_message_id)).toEqual([
      `${sessionId}-old-user`,
      `${sessionId}-current`,
      `${sessionId}-old-user`,
      `${sessionId}-current`,
    ]);
    expect(summaryGets).toBe(4);
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
        if (init?.method === "POST") return acceptedSegment(init);
        summaryGets += 1;
        if (summaryGets === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirstGet = () =>
              resolve(
                ok({
                  session_id: sessionId,
                  segments: [],
                  boundaries: [],
                  targets: [],
                }),
              );
          });
        }
        return ok({
          session_id: sessionId,
          segments: [],
          boundaries: [],
          targets: [],
        });
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

    expect(summaryGets).toBe(3);
  });

  it("ignores an observed failure replaced by a successful queued update", async () => {
    const sessionId = "superseded-target-failure-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    let releaseFirstGet: (() => void) | undefined;
    let releaseFirstPost: (() => void) | undefined;
    let summaryGets = 0;
    let targetPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          targetPosts += 1;
          if (targetPosts === 1) {
            return new Promise<Response>((resolve) => {
              releaseFirstPost = () =>
                resolve(new Response("failed", { status: 500 }));
            });
          }
          return acceptedSegment(init);
        }
        summaryGets += 1;
        if (summaryGets === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirstGet = () => resolve(emptyListing(_url));
          });
        }
        return emptyListing(_url);
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const output = { messages: structuredClone(messages) };
    const projection = hooks["experimental.chat.messages.transform"]?.(
      {},
      output as never,
    );
    await vi.waitFor(() => expect(summaryGets).toBe(1));

    const firstIdle = hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);
    await vi.waitFor(() => expect(targetPosts).toBe(1));
    const overlappingIdle = hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);
    releaseFirstGet?.();
    releaseFirstPost?.();

    await expect(
      Promise.all([projection, firstIdle, overlappingIdle]),
    ).resolves.toBeDefined();
    expect(targetPosts).toBeGreaterThanOrEqual(2);
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
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method !== "POST") return emptyListing(url);
        submittedBodies.push(JSON.parse(String(init.body)));
        await new Promise<void>((resolve) => postResolvers.push(resolve));
        return acceptedSegment(init);
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
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method !== "POST") return emptyListing(url);
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

  it("aborts in-flight projection SDK reads when a session is deleted", async () => {
    const sessionId = "deleted-projection-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    let providerSignal: AbortSignal | undefined;
    client.provider.list.mockImplementation(async (...args: unknown[]) => {
      providerSignal = (args[0] as { signal?: AbortSignal }).signal;
      return new Promise<never>((_resolve, reject) => {
        providerSignal?.addEventListener(
          "abort",
          () => reject(providerSignal?.reason),
          { once: true },
        );
      });
    });
    const hooks = await Reflection(pluginInput(client));
    const projection = hooks["experimental.chat.messages.transform"]?.({}, {
      messages: structuredClone(messages),
    } as never);
    await vi.waitFor(() => expect(providerSignal).toBeDefined());

    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: sessionId } },
      },
    } as never);

    await expect(projection).rejects.toThrow("was deleted");
    expect(providerSignal?.aborted).toBe(true);
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
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          submittedSessions.push(JSON.parse(String(init.body)).session_id);
        }
        return emptyListing(url, init);
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

  it("bounds each inactive sweep instead of scanning every unchanged session", async () => {
    const activeSessionId = "bounded-sweep-active";
    const inactiveIds = Array.from(
      { length: 100 },
      (_, index) => `bounded-sweep-${index}`,
    );
    const activeMessages = projectionMessages(activeSessionId);
    const client = clientFor(activeMessages);
    client.session.list.mockResolvedValue({
      data: inactiveIds.map((id) => ({ id, time: { updated: 0 } })),
    });
    client.session.messages.mockImplementation(async (input) => {
      const id = input?.path.id ?? activeSessionId;
      return { data: projectionMessages(id) };
    });
    const postedPriorities = new Map<string, number>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          postedPriorities.set(body.session_id, body.processing_priority);
        }
        return emptyListing(url, init);
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const idle = {
      event: {
        type: "session.idle",
        properties: { sessionID: activeSessionId },
      },
    } as never;

    await hooks.event?.(idle);
    await vi.waitFor(() => expect(postedPriorities.size).toBe(21));
    expect(postedPriorities.get(activeSessionId)).toBe(50);
    expect(
      [...postedPriorities]
        .filter(([sessionId]) => sessionId !== activeSessionId)
        .every(([, priority]) => priority === 0),
    ).toBe(true);
    await hooks.event?.(idle);
    await vi.waitFor(() => expect(postedPriorities.size).toBe(41));

    const loadedInactiveSessions = new Set(
      client.session.messages.mock.calls
        .map(([input]) => input?.path.id)
        .filter((id): id is string => Boolean(id && id !== activeSessionId)),
    );
    expect(loadedInactiveSessions.size).toBe(40);
  });

  it("detaches and cancels a blocked inactive history read", async () => {
    const activeSessionId = "detached-sweep-active";
    const inactiveSessionId = "detached-sweep-inactive";
    const activeMessages = projectionMessages(activeSessionId);
    const client = clientFor(activeMessages);
    client.session.list.mockResolvedValue({
      data: [{ id: inactiveSessionId, time: { updated: 0 } }],
    });
    let inactiveSignal: AbortSignal | undefined;
    client.session.messages.mockImplementation(async (input) => {
      if (input?.path.id !== inactiveSessionId) {
        return { data: activeMessages };
      }
      inactiveSignal = (input as { signal?: AbortSignal }).signal;
      return new Promise<{ data: OpenCodeMessage[] }>((_resolve, reject) => {
        inactiveSignal?.addEventListener(
          "abort",
          () => reject(inactiveSignal?.reason),
          { once: true },
        );
      });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
        emptyListing(url, init),
      ),
    );
    const hooks = await Reflection(pluginInput(client));

    const idle = hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: activeSessionId },
      },
    } as never);
    await vi.waitFor(() => expect(inactiveSignal).toBeDefined());
    await expect(idle).resolves.toBeUndefined();

    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: inactiveSessionId } },
      },
    } as never);
    await vi.waitFor(() => expect(inactiveSignal?.aborted).toBe(true));
  });

  it("cancels detached inactive work during plugin disposal", async () => {
    const activeSessionId = "disposed-sweep-active";
    const inactiveSessionId = "disposed-sweep-inactive";
    const activeMessages = projectionMessages(activeSessionId);
    const client = clientFor(activeMessages);
    client.session.list.mockResolvedValue({
      data: [{ id: inactiveSessionId, time: { updated: 0 } }],
    });
    let inactiveSignal: AbortSignal | undefined;
    client.session.messages.mockImplementation(async (input) => {
      if (input?.path.id !== inactiveSessionId) return { data: activeMessages };
      inactiveSignal = (input as { signal?: AbortSignal }).signal;
      return new Promise<{ data: OpenCodeMessage[] }>((_resolve, reject) => {
        inactiveSignal?.addEventListener(
          "abort",
          () => reject(inactiveSignal?.reason),
          { once: true },
        );
      });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
        emptyListing(url, init),
      ),
    );
    const hooks = await Reflection(pluginInput(client));
    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: activeSessionId },
      },
    } as never);
    await vi.waitFor(() => expect(inactiveSignal).toBeDefined());

    await hooks.dispose?.();

    expect(inactiveSignal?.aborted).toBe(true);
  });

  it("drains an active projection and prevents post-disposal commits", async () => {
    const sessionId = "disposed-active-projection";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    let releaseProvider!: () => void;
    let providerSignal: AbortSignal | undefined;
    client.provider.list.mockImplementation(async (...args: unknown[]) => {
      providerSignal = (args[0] as { signal?: AbortSignal }).signal;
      await new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      return {
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
      };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
        emptyListing(url, init),
      ),
    );
    const hooks = await Reflection(pluginInput(client));
    const output = { messages: structuredClone(messages) };
    const projection = hooks["experimental.chat.messages.transform"]?.(
      {},
      output as never,
    );
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    let disposed = false;
    const disposal = hooks.dispose?.().then(() => {
      disposed = true;
    });
    await Promise.resolve();

    expect(disposed).toBe(false);
    releaseProvider();
    await expect(projection).rejects.toThrow("disposed");
    await disposal;

    expect(output.messages).toEqual(messages);
    expect(
      existsSync(
        join(
          paths.home,
          ".local",
          "state",
          "reflection",
          "projection",
          `${encodeURIComponent(sessionId)}.json`,
        ),
      ),
    ).toBe(false);
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
                resolve(acceptedSegment(init));
              };
            });
          }
          return acceptedSegment(init);
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
          boundaries: [
            {
              id: synced ? "fresh-summary" : "stale-summary",
              start_user_message_id: `${sessionId}-old-user`,
              end_user_message_id: `${sessionId}-old-user`,
              projection_version: 1,
              source_eligible: true,
              source_fingerprint:
                synced && submittedBodies[1]
                  ? sourceFingerprint(
                      submittedBodies[1] as Parameters<
                        typeof sourceFingerprint
                      >[0],
                    )
                  : "stale-fingerprint",
            },
          ],
          targets: [],
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
    expect(summaryGets).toBe(2);

    releaseRestartSync?.();
    await projection;
    const context = output.messages[0]?.parts[0]?.text;
    expect(summaryGets).toBe(3);
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
    expect(summaryGets).toBe(5);
  });

  it("invalidates a checkpoint when persisted source provenance changes", async () => {
    const sessionId = "checkpoint-source-provenance";
    const messages = projectionMessages(sessionId);
    const closed = segmentMessages(messages)[0]!;
    const client = clientFor(messages);
    let sourceChanged = false;
    let currentTargetPresent = false;
    let targetPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          targetPosts += 1;
          return acceptedSegment(init);
        }
        return ok({
          session_id: sessionId,
          segments: [segmentSummary(sessionId, closed, "Stable summary")],
          boundaries: [
            segmentBoundary(
              sessionId,
              closed,
              sourceChanged
                ? "f".repeat(64)
                : submissionSourceFingerprint(sessionId, closed),
            ),
          ],
          targets: currentTargetPresent
            ? [segmentTarget(sessionId, closed)]
            : [],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));

    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: structuredClone(messages),
    } as never);
    sourceChanged = true;
    currentTargetPresent = true;
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: structuredClone(messages),
    } as never);
    expect(targetPosts).toBe(1);

    currentTargetPresent = false;
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: structuredClone(messages),
    } as never);

    expect(targetPosts).toBe(2);
  });

  it("recovers available listing summaries when initial closed sync fails", async () => {
    const sessionId = "reset-sync-failure-session";
    const messages = projectionMessages(sessionId);
    const closed = segmentMessages(messages)[0]!;
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
        return ok({
          session_id: sessionId,
          segments: [segmentSummary(sessionId, closed, "Recovered summary")],
          boundaries: [segmentBoundary(sessionId, closed)],
          targets: [],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const output = { messages: structuredClone(messages) };

    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    expect(summaryGets).toBe(2);
    expect(submittedBodies).toHaveLength(1);
    expect(submittedBodies[0]).toMatchObject({
      start_user_message_id: `${sessionId}-old-user`,
    });
    expect(submittedBodies).not.toContainEqual(
      expect.objectContaining({
        start_user_message_id: `${sessionId}-current`,
      }),
    );
    expect(output.messages[0]?.parts[0]?.text).toContain("Recovered summary");
    expect(output.messages[0]?.parts[0]?.text).not.toContain(
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
        return ok({
          session_id: sessionId,
          segments: [],
          boundaries: [],
          targets: [],
        });
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

    expect(summaryGets).toBe(2);
    expect(submittedBodies).not.toContainEqual(
      expect.objectContaining({
        start_user_message_id: `${sessionId}-current`,
      }),
    );
    expect(output.messages[0]?.parts[0]?.text).toContain(
      "archived closed segments had no exact committed Reflection summary",
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
        return ok({
          session_id: sessionId,
          segments: [],
          boundaries: [],
          targets: [],
        });
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
    expect(summaryGets).toBe(3);
    expect(output.messages[0]?.parts[0]?.text).toContain(
      "archived closed segments had no exact committed Reflection summary",
    );
  });

  it("fails closed when the authoritative raw message snapshot is unavailable", async () => {
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
          boundaries: [
            {
              id: "stale-summary",
              start_user_message_id: `${sessionId}-old-user`,
              end_user_message_id: `${sessionId}-old-user`,
              projection_version: 1,
              source_eligible: true,
              source_fingerprint: "fingerprint",
            },
          ],
          targets: [],
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
    await expect(
      hooks["experimental.chat.messages.transform"]?.({}, output as never),
    ).rejects.toThrow(`could not load messages for ${sessionId}`);

    expect(targetPosts).toBe(1);
    expect(summaryGets).toBe(2);
    expect(client.session.messages).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: sessionId },
        query: { directory: "/tmp" },
        signal: expect.any(AbortSignal),
        throwOnError: true,
      }),
    );
  });

  it("does not transfer a failure to unrelated history reusing a user ID", async () => {
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
    const submittedBodies: Array<Record<string, unknown>> = [];
    let summaryGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          submittedBodies.push(JSON.parse(String(init.body)));
          return submittedBodies.length === 1
            ? new Response("failed", { status: 500 })
            : acceptedSegment(init);
        }
        summaryGets += 1;
        return ok({
          session_id: sessionId,
          segments: [],
          boundaries: [],
          targets: [],
        });
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

    expect(submittedBodies.map((body) => body.processing_priority)).toEqual([
      50, 50, 100,
    ]);
    expect(submittedBodies.map((body) => body.start_user_message_id)).toEqual([
      failedSegmentKey,
      newClosedKey,
      newClosedKey,
    ]);
    expect(summaryGets).toBe(4);
    expect(output.messages[0]?.parts[0]?.text).not.toContain(
      "Reflection summaries were unavailable",
    );
    expect(output.messages[0]?.parts[0]?.text).toContain(
      "archived closed segments had no exact committed Reflection summary",
    );
  });

  it("retries a failed closed segment and caches the successful submission", async () => {
    const sessionId = "failed-segment-retry-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    const submittedBodies: Array<Record<string, unknown>> = [];
    let summaryGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          submittedBodies.push(JSON.parse(String(init.body)));
          return submittedBodies.length === 1
            ? new Response("failed", { status: 500 })
            : acceptedSegment(init);
        }
        summaryGets += 1;
        return ok({
          session_id: sessionId,
          segments: [],
          boundaries: [],
          targets: [],
        });
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

    expect(submittedBodies.map((body) => body.processing_priority)).toEqual([
      50, 50, 100,
    ]);
    expect(summaryGets).toBe(5);
  });

  it("retries an exact failed target only once per source", async () => {
    const sessionId = "failed-target-endpoint-session";
    const messages = projectionMessages(sessionId);
    const closed = segmentMessages(messages)[0]!;
    const client = clientFor(messages);
    let submitted: Parameters<typeof sourceFingerprint>[0] | undefined;
    let segmentPosts = 0;
    let retryPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/retry")) {
          retryPosts += 1;
          if (!submitted) throw new Error("missing submitted source");
          return ok(segmentJob(submitted, "pending"));
        }
        if (init?.method === "POST") {
          segmentPosts += 1;
          submitted = JSON.parse(String(init.body));
          return ok(segmentJob(submitted!, "failed"));
        }
        return ok({
          session_id: sessionId,
          segments: [],
          boundaries: [],
          targets: submitted
            ? [{ ...segmentTarget(sessionId, closed), status: "failed" }]
            : [],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const idle = {
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never;

    await hooks.event?.(idle);
    await hooks.event?.(idle);

    expect(segmentPosts).toBe(2);
    expect(retryPosts).toBe(1);
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
            : acceptedSegment(init);
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
          boundaries: [
            {
              id: "replacement-summary",
              start_user_message_id: replacementUserId,
              end_user_message_id: replacementUserId,
              projection_version: 1,
              source_eligible: true,
              source_fingerprint: "fingerprint",
            },
          ],
          targets: [],
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
    expect(targetPosts).toBe(3);
    expect(summaryGets).toBe(4);
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
            : acceptedSegment(init);
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
          boundaries: [
            {
              id: "post-rewind-summary",
              start_user_message_id: `${sessionId}-replacement-user`,
              end_user_message_id: `${sessionId}-replacement-user`,
              projection_version: 1,
              source_eligible: true,
              source_fingerprint: "fingerprint",
            },
          ],
          targets: [],
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
    currentMessages = replacement;
    const output = { messages: structuredClone(replacement) };
    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    expect(targetPosts).toBe(2);
    expect(summaryGets).toBe(4);
    expect(output.messages[0]?.parts[0]?.text).toContain("Post-rewind summary");
  });

  it("never rejects when queued idle finish work fails", async () => {
    const sessionId = "detached-finish-failure-session";
    const client = clientFor(projectionMessages(sessionId));
    client.session.list.mockRejectedValue(new Error("list failed"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
        emptyListing(url, init),
      ),
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
          "inactive-session sweep failed: list failed",
        ),
      },
      signal: expect.any(AbortSignal),
    });
  });

  it("returns direct listing immediately after foreground sync without polling when exact summaries are pending and retains available summaries", async () => {
    const sessionId = "summary-immediate-direct-listing";
    const raw = siblingProjectionMessages(sessionId);
    const segments = segmentMessages(raw);
    const firstSegment = segments[0]!;
    const secondSegment = segments[1]!;
    const visibleAssistant = raw.find(
      (message) => message.info.id === `${sessionId}-step-2`,
    );
    visibleAssistant!.info.tokens = {
      input: 100_000,
      output: 1_000,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    };
    const client = clientFor(raw);
    let gets = 0;
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          posted.push(JSON.parse(String(init.body)));
          return acceptedSegment(init);
        }
        gets += 1;
        if (gets === 1) {
          return ok({
            session_id: sessionId,
            segments: [],
            boundaries: [
              segmentBoundary(sessionId, firstSegment),
              segmentBoundary(sessionId, secondSegment),
            ],
            targets: [],
          });
        }
        return ok({
          session_id: sessionId,
          segments: [
            segmentSummary(sessionId, firstSegment, "Available summary 1"),
          ],
          boundaries: [
            segmentBoundary(sessionId, firstSegment),
            segmentBoundary(sessionId, secondSegment),
          ],
          targets: [segmentTarget(sessionId, secondSegment)],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const output = { messages: structuredClone(raw) };

    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    expect(gets).toBe(2);
    expect(posted.length).toBeGreaterThan(0);
    expect(output.messages[0]?.parts[0]?.text).toContain("Available summary 1");
    expect(output.messages[0]?.parts[0]?.text).not.toContain(
      "Reflection summaries were unavailable",
    );
  });

  it("does not poll a superseded target as pending work", async () => {
    const sessionId = "superseded-summary-target";
    const messages = projectionMessages(sessionId);
    const required = segmentMessages(messages)[0]!;
    const client = clientFor(messages);
    let summaryGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") return acceptedSegment(init);
        summaryGets += 1;
        return ok({
          session_id: sessionId,
          segments: [],
          boundaries: [],
          targets: [
            { ...segmentTarget(sessionId, required), status: "superseded" },
          ],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const output = { messages: structuredClone(messages) };

    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    expect(summaryGets).toBeLessThanOrEqual(2);
    expect(output.messages[0]?.parts[0]?.text).toContain(
      "had no exact committed Reflection summary",
    );
  });

  it("does not poll when a target is pending after foreground sync and projects available state immediately", async () => {
    const sessionId = "summary-poll-timeout-session";
    const messages = projectionMessages(sessionId);
    const required = segmentMessages(messages)[0]!;
    const client = clientFor(messages);
    let gets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") return acceptedSegment(init);
        gets += 1;
        return ok({
          session_id: sessionId,
          segments: [],
          boundaries: [],
          targets: gets === 1 ? [] : [segmentTarget(sessionId, required)],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const output = { messages: structuredClone(messages) };

    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    expect(gets).toBe(2);
    expect(output.messages[0]?.parts[0]?.text).toContain(
      "archived closed segments had no exact committed Reflection summary",
    );
  });

  it("falls back lossily when direct recovery GET fails with service unavailable", async () => {
    const sessionId = "summary-poll-service-failure";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    let gets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") return acceptedSegment(init);
        gets += 1;
        return gets === 1
          ? ok({
              session_id: sessionId,
              segments: [],
              boundaries: [],
              targets: [],
            })
          : new Response("service unavailable", { status: 503 });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const output = { messages: structuredClone(messages) };

    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    expect(gets).toBe(2);
    expect(output.messages[0]?.parts[0]?.text).toContain(
      "had no exact committed Reflection summary",
    );
  });

  it("falls back without submitting an unanchored plan when the manifest is unavailable", async () => {
    const sessionId = "initial-manifest-service-failure";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts += 1;
          return acceptedSegment(init);
        }
        return new Response("service unavailable", { status: 503 });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const output = { messages: structuredClone(messages) };

    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    expect(posts).toBe(0);
    expect(client.session.messages).toHaveBeenCalledOnce();
    expect(output.messages[0]?.parts[0]?.text).toContain(
      "Reflection summaries were unavailable",
    );
  });

  it("treats an internal manifest timeout as service unavailability", async () => {
    vi.useFakeTimers();
    const sessionId = "initial-manifest-timeout";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
      ),
    );
    const hooks = await Reflection(pluginInput(client));
    const output = { messages: structuredClone(messages) };
    const projection = hooks["experimental.chat.messages.transform"]?.(
      {},
      output as never,
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await projection;

    expect(output.messages[0]?.parts[0]?.text).toContain(
      "Reflection summaries were unavailable",
    );
  });

  it("bounds serialized idle and foreground target waits", async () => {
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
        return ok({
          session_id: sessionId,
          segments: [],
          boundaries: [],
          targets: [],
        });
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

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([idle, projection]);

    expect(summaryGets).toBe(3);
    expect(output.messages[0]?.parts[0]?.text).toContain(
      "archived closed segments had no exact committed Reflection summary",
    );
  });

  it("shows a non-persisted toast for a lossy projection", async () => {
    const sessionId = "warning-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
        init?.method === "POST"
          ? ok()
          : ok({
              session_id: sessionId,
              segments: [],
              boundaries: [],
              targets: [],
            }),
      ),
    );
    const hooks = await Reflection(pluginInput(client));

    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: structuredClone(messages),
    } as never);
    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: sessionId } },
    } as never);

    expect(client.tui.showToast).toHaveBeenCalledOnce();
    expect(client.tui.showToast).toHaveBeenCalledWith({
      query: { directory: "/tmp" },
      body: {
        title: "Reflection context warning",
        message: PROJECTION_LOSS_WARNING,
        variant: "warning",
        duration: 10_000,
      },
    });
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("does not fail projection when the warning toast is unavailable", async () => {
    const sessionId = "warning-failure-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    client.tui.showToast.mockRejectedValue(new Error("TUI disconnected"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
        init?.method === "POST"
          ? ok()
          : ok({
              session_id: sessionId,
              segments: [],
              boundaries: [],
              targets: [],
            }),
      ),
    );
    const hooks = await Reflection(pluginInput(client));

    await expect(
      hooks["experimental.chat.messages.transform"]?.({}, {
        messages: structuredClone(messages),
      } as never),
    ).resolves.toBeUndefined();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it.each(["failed", "superseded"] as const)(
    "does not invalidate or rebuild a checkpoint when a matching target is %s",
    async (status) => {
      const sessionId = `${status}-target-reuse-session`;
      const messages = projectionMessages(sessionId);
      const closed = segmentMessages(messages)[0]!;
      const client = clientFor(messages);
      let targetPosts = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
          if (init?.method === "POST") {
            targetPosts += 1;
            return acceptedSegment(init);
          }
          return ok({
            session_id: sessionId,
            segments: [],
            boundaries: [],
            targets: [
              {
                id: segmentId(sessionId, closed),
                start_user_message_id: closed.startUserMessageId,
                end_user_message_id: closed.endUserMessageId,
                ...segmentWireBoundary(closed),
                projection_version: 1,
                status,
                source_fingerprint: submissionSourceFingerprint(
                  sessionId,
                  closed,
                ),
              },
            ],
          });
        }),
      );
      const hooks = await Reflection(pluginInput(client));

      // Turn 1: initial projection creates checkpoint
      await hooks["experimental.chat.messages.transform"]?.({}, {
        messages: structuredClone(messages),
      } as never);
      expect(targetPosts).toBe(1);
      expect(client.session.messages).toHaveBeenCalledOnce();

      // Turn 2: new user turn with different user message ID
      const turn2Messages = structuredClone(messages);
      turn2Messages.push({
        info: {
          id: `${sessionId}-turn-2`,
          sessionID: sessionId,
          role: "user",
          agent: "build",
          model: { providerID: "provider", modelID: "model" },
        },
        parts: [{ type: "text", text: "next turn" }],
      });

      await hooks["experimental.chat.messages.transform"]?.({}, {
        messages: turn2Messages,
      } as never);

      // Should NOT rebuild (targetPosts remains 1)
      expect(targetPosts).toBe(1);
      expect(client.session.messages).toHaveBeenCalledOnce();

      // Turn 3: another user turn
      const turn3Messages = structuredClone(turn2Messages);
      turn3Messages.push({
        info: {
          id: `${sessionId}-turn-3`,
          sessionID: sessionId,
          role: "user",
          agent: "build",
          model: { providerID: "provider", modelID: "model" },
        },
        parts: [{ type: "text", text: "third turn" }],
      });

      await hooks["experimental.chat.messages.transform"]?.({}, {
        messages: turn3Messages,
      } as never);

      // Checkpoint still reused without rebuild
      expect(targetPosts).toBe(1);
      expect(client.session.messages).toHaveBeenCalledOnce();
    },
  );

  it("validates listing and prefix only once per user turn during tool loops", async () => {
    const sessionId = "tool-loop-single-validation";
    const messages = projectionMessages(sessionId);
    const closed = segmentMessages(messages)[0]!;
    const client = clientFor(messages);
    let summaryGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") return acceptedSegment(init);
        summaryGets += 1;
        return ok({
          session_id: sessionId,
          segments: [segmentSummary(sessionId, closed, "Summary 1")],
          boundaries: [segmentBoundary(sessionId, closed)],
          targets: [],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));

    // Initial transform (turn 1 creation)
    const turn1UserMessages = structuredClone(messages);
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: turn1UserMessages,
    } as never);
    const getsAfterTurn1Start = summaryGets;
    expect(getsAfterTurn1Start).toBe(2);

    // Turn 1 first tool loop step: assistant with tool call added
    const turn1Step1 = structuredClone(turn1UserMessages);
    turn1Step1.push({
      info: {
        id: `${sessionId}-assistant-tool-1`,
        sessionID: sessionId,
        role: "assistant",
        parentID: `${sessionId}-current`,
        providerID: "provider",
        modelID: "model",
        time: { created: 10, completed: 11 },
        finish: "tool-calls",
      },
      parts: [
        {
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "file.txt",
          },
        },
      ],
    });

    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: turn1Step1,
    } as never);

    // Fast path: no listing GET performed during tool loop continuation
    expect(summaryGets).toBe(getsAfterTurn1Start);

    // Turn 1 second tool loop step: another assistant message added
    const turn1Step2 = structuredClone(turn1Step1);
    turn1Step2.push({
      info: {
        id: `${sessionId}-assistant-tool-2`,
        sessionID: sessionId,
        role: "assistant",
        parentID: `${sessionId}-current`,
        providerID: "provider",
        modelID: "model",
        time: { created: 12, completed: 13 },
        finish: "tool-calls",
      },
      parts: [
        {
          type: "tool",
          tool: "read",
          state: {
            status: "completed",
            input: { file: "file.txt" },
            output: "hello",
          },
        },
      ],
    });

    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: turn1Step2,
    } as never);

    // Still no additional GET during tool loop
    expect(summaryGets).toBe(getsAfterTurn1Start);

    // Now a new user turn starts
    const turn2Messages = structuredClone(turn1Step2);
    turn2Messages.push({
      info: {
        id: `${sessionId}-turn-2`,
        sessionID: sessionId,
        role: "user",
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
      },
      parts: [{ type: "text", text: "continue with next task" }],
    });

    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: turn2Messages,
    } as never);

    // Validated once for new user turn (listing GET called 1 time)
    expect(summaryGets).toBe(getsAfterTurn1Start + 1);
  });

  it("invalidates an all-zero source-valid checkpoint once when its first exact summary appears, then reuses", async () => {
    const sessionId = "all-zero-checkpoint-recovery-session";
    const messages = projectionMessages(sessionId);
    const closed = segmentMessages(messages)[0]!;
    const client = clientFor(messages);
    let summaryPresent = false;
    let targetPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          targetPosts += 1;
          return acceptedSegment(init);
        }
        return ok({
          session_id: sessionId,
          segments: summaryPresent
            ? [segmentSummary(sessionId, closed, "Newly ready summary")]
            : [],
          boundaries: [segmentBoundary(sessionId, closed)],
          targets: [],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));

    // Turn 1: all summaries missing, creates all-zero checkpoint
    const output1 = { messages: structuredClone(messages) };
    await hooks["experimental.chat.messages.transform"]?.({}, output1 as never);
    expect(targetPosts).toBe(1);
    expect(client.session.messages).toHaveBeenCalledOnce();
    expect(output1.messages[0]?.parts[0]?.text).not.toContain(
      "Newly ready summary",
    );
    expect(output1.messages[0]?.parts[0]?.text).toContain(
      "archived closed segments had no exact committed Reflection summary",
    );

    // Turn 2: first exact summary appears; all-zero checkpoint invalidates once
    summaryPresent = true;
    const turn2Messages = structuredClone(messages);
    turn2Messages.push({
      info: {
        id: `${sessionId}-user-turn-2`,
        sessionID: sessionId,
        role: "user",
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
      },
      parts: [{ type: "text", text: "second prompt" }],
    });
    const output2 = { messages: structuredClone(turn2Messages) };
    await hooks["experimental.chat.messages.transform"]?.({}, output2 as never);
    expect(targetPosts).toBe(1);
    expect(client.session.messages).toHaveBeenCalledTimes(2);
    expect(output2.messages[0]?.parts[0]?.text).toContain(
      "Newly ready summary",
    );
    expect(output2.messages[0]?.parts[0]?.text).not.toContain(
      "archived closed segments had no exact committed Reflection summary",
    );

    // Turn 3: same summary present; now nonzero checkpoint reuses without rebuild
    const turn3Messages = structuredClone(turn2Messages);
    turn3Messages.push({
      info: {
        id: `${sessionId}-user-turn-3`,
        sessionID: sessionId,
        role: "user",
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
      },
      parts: [{ type: "text", text: "third prompt" }],
    });
    const output3 = { messages: structuredClone(turn3Messages) };
    await hooks["experimental.chat.messages.transform"]?.({}, output3 as never);
    expect(targetPosts).toBe(1);
    expect(client.session.messages).toHaveBeenCalledTimes(2);
    expect(output3.messages[0]?.parts[0]?.text).toContain(
      "Newly ready summary",
    );
  });

  it("reuses a nonzero source-valid checkpoint when another missing summary appears and included summary content changes, while source mismatch invalidates", async () => {
    const sessionId = "nonzero-checkpoint-reuse-session";
    const messages1 = projectionMessages(`${sessionId}-1`).slice(0, 2);
    const messages2 = projectionMessages(`${sessionId}-2`).slice(0, 2);
    const messages3 = projectionMessages(`${sessionId}-3`).slice(0, 2);
    const current = projectionMessages(`${sessionId}-current`).slice(0, 1);
    const raw = [...messages1, ...messages2, ...messages3, ...current];
    for (const message of raw) message.info.sessionID = sessionId;
    const closed = segmentMessages(raw).filter((segment) => segment.closed);
    expect(closed).toHaveLength(3);
    const firstSegment = closed[0]!;
    const secondSegment = closed[1]!;
    const thirdSegment = closed[2]!;
    const client = clientFor(raw);
    let firstSummaryText = "Initial summary 1";
    let secondSummaryPresent = false;
    let targetPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          targetPosts += 1;
          return acceptedSegment(init);
        }
        return ok({
          session_id: sessionId,
          segments: [
            segmentSummary(sessionId, firstSegment, firstSummaryText),
            ...(secondSummaryPresent
              ? [
                  segmentSummary(
                    sessionId,
                    secondSegment,
                    "Newly ready summary 2",
                  ),
                ]
              : []),
          ],
          boundaries: [
            segmentBoundary(sessionId, firstSegment),
            segmentBoundary(sessionId, secondSegment),
            segmentBoundary(sessionId, thirdSegment),
          ],
          targets: secondSummaryPresent
            ? []
            : [segmentTarget(sessionId, secondSegment)],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));

    // Turn 1: first segment has summary, second segment is missing -> creates nonzero checkpoint
    const output1 = { messages: structuredClone(raw) };
    await hooks["experimental.chat.messages.transform"]?.({}, output1 as never);
    expect(targetPosts).toBe(3);
    expect(client.session.messages).toHaveBeenCalledOnce();
    expect(output1.messages[0]?.parts[0]?.text).toContain("Initial summary 1");

    // Turn 2: second summary appears and first summary changes, but source is unchanged
    firstSummaryText = "Updated summary 1";
    secondSummaryPresent = true;
    const turn2Messages = structuredClone(raw);
    turn2Messages.push({
      info: {
        id: `${sessionId}-user-turn-2`,
        sessionID: sessionId,
        role: "user",
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
      },
      parts: [{ type: "text", text: "turn 2" }],
    });
    const output2 = { messages: structuredClone(turn2Messages) };
    await hooks["experimental.chat.messages.transform"]?.({}, output2 as never);
    // Nonzero source-valid checkpoint is reused without rebuilding
    expect(targetPosts).toBe(3);
    expect(client.session.messages).toHaveBeenCalledOnce();
    expect(output2.messages[0]?.parts[0]?.text).toContain("Initial summary 1");
    expect(output2.messages[0]?.parts[0]?.text).not.toContain(
      "Newly ready summary 2",
    );

    // Turn 3: source message modified (source fingerprint mismatch)
    const turn3Messages = structuredClone(turn2Messages);
    turn3Messages[0]!.parts[0]!.text = "modified archived message text";
    client.session.messages.mockImplementation(async () => ({
      data: structuredClone(turn3Messages),
    }));
    turn3Messages.push({
      info: {
        id: `${sessionId}-user-turn-3`,
        sessionID: sessionId,
        role: "user",
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
      },
      parts: [{ type: "text", text: "turn 3" }],
    });
    const output3 = { messages: structuredClone(turn3Messages) };
    await hooks["experimental.chat.messages.transform"]?.({}, output3 as never);
    // Source mismatch invalidates and triggers a rebuild incorporating both updated summaries
    expect(targetPosts).toBe(5);
    expect(client.session.messages).toHaveBeenCalledTimes(2);
    expect(output3.messages[0]?.parts[0]?.text).toContain("Updated summary 1");
    expect(output3.messages[0]?.parts[0]?.text).toContain(
      "Newly ready summary 2",
    );
  });

  it("preserves completed summaries when foreground sync fails and does not report total unavailable", async () => {
    const sessionId = "partial-summary-recovery-session";
    const raw = siblingProjectionMessages(sessionId);
    const segments = segmentMessages(raw);
    const firstSegment = segments[0]!;
    const secondSegment = segments[1]!;
    const visibleAssistant = raw.find(
      (message) => message.info.id === `${sessionId}-step-2`,
    );
    visibleAssistant!.info.tokens = {
      input: 100_000,
      output: 1_000,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    };
    const client = clientFor(raw);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response("failed", { status: 500 });
        }
        return ok({
          session_id: sessionId,
          segments: [
            segmentSummary(sessionId, firstSegment, "First completed summary"),
          ],
          boundaries: [segmentBoundary(sessionId, firstSegment)],
          targets: [
            {
              id: segmentId(sessionId, secondSegment),
              start_user_message_id: secondSegment.startUserMessageId,
              end_user_message_id: secondSegment.endUserMessageId,
              ...segmentWireBoundary(secondSegment),
              projection_version: 1,
              status: "failed",
              source_fingerprint: submissionSourceFingerprint(
                sessionId,
                secondSegment,
              ),
            },
          ],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const output = { messages: structuredClone(raw) };

    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    expect(output.messages[0]?.parts[0]?.text).toContain(
      "First completed summary",
    );
    expect(output.messages[0]?.parts[0]?.text).not.toContain(
      "Reflection summaries were unavailable",
    );
  });

  it("falls back to canonical plan validation when manifest lacks authoritative entries for an archived segment", async () => {
    const sessionId = "fallback-canonical-manifest-session";
    const messages = projectionMessages(sessionId);
    const closed = segmentMessages(messages)[0]!;
    const client = clientFor(messages);
    let targetPosts = 0;
    let manifestHasBoundaries = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          targetPosts += 1;
          return acceptedSegment(init);
        }
        return ok({
          session_id: sessionId,
          segments: [segmentSummary(sessionId, closed, "Summary text")],
          boundaries: manifestHasBoundaries
            ? [segmentBoundary(sessionId, closed)]
            : [],
          targets: [],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));

    // Turn 1: create checkpoint
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: structuredClone(messages),
    } as never);
    expect(targetPosts).toBe(1);
    expect(client.session.messages).toHaveBeenCalledOnce();

    // Turn 2: manifest lacks boundaries/targets
    manifestHasBoundaries = false;
    client.session.messages.mockClear();

    const turn2Messages = structuredClone(messages);
    turn2Messages.push({
      info: {
        id: `${sessionId}-user-turn-2`,
        sessionID: sessionId,
        role: "user",
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
      },
      parts: [{ type: "text", text: "turn 2" }],
    });

    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: turn2Messages,
    } as never);

    // Falls back to canonical plan loading
    expect(client.session.messages).toHaveBeenCalledOnce();
    expect(targetPosts).toBe(1);
  });

  it("clears per-turn validation state on session.deleted", async () => {
    const sessionId = "session-deleted-turn-cache";
    const messages = projectionMessages(sessionId);
    const closed = segmentMessages(messages)[0]!;
    const client = clientFor(messages);
    let summaryGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") return acceptedSegment(init);
        summaryGets += 1;
        return ok({
          session_id: sessionId,
          segments: [segmentSummary(sessionId, closed, "Summary")],
          boundaries: [segmentBoundary(sessionId, closed)],
          targets: [],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));

    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: structuredClone(messages),
    } as never);
    expect(summaryGets).toBe(2);

    // Delete session
    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: sessionId } },
      },
    } as never);

    // Verify transform on deleted session throws
    await expect(
      hooks["experimental.chat.messages.transform"]?.({}, {
        messages: structuredClone(messages),
      } as never),
    ).rejects.toThrow("was deleted");
  });

  it("caps aggregate serial sync at 5s when a successful POST is followed by a blocked POST and recovers fresh summaries", async () => {
    vi.useFakeTimers();
    const sessionId = "aggregate-sync-cap-session";
    const messages = projectionMessages(sessionId);
    const current = messages.pop()!;
    const additionalTurn = projectionMessages(`${sessionId}-additional`).slice(
      0,
      2,
    );
    for (const message of additionalTurn) message.info.sessionID = sessionId;
    messages.push(...additionalTurn, current);
    const closed = segmentMessages(messages).filter(
      (segment) => segment.closed,
    );
    expect(closed).toHaveLength(2);
    const client = clientFor(messages);
    let postCount = 0;
    let summaryGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          postCount += 1;
          if (postCount === 1) {
            await new Promise((resolve) => setTimeout(resolve, 4_000));
            return acceptedSegment(init);
          }
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          });
        }
        summaryGets += 1;
        return ok({
          session_id: sessionId,
          segments: closed.map((segment, index) =>
            segmentSummary(sessionId, segment, `Available summary ${index}`),
          ),
          boundaries: closed.map((segment) =>
            segmentBoundary(sessionId, segment),
          ),
          targets: [],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const output = { messages: structuredClone(messages) };
    const projection = hooks["experimental.chat.messages.transform"]?.(
      {},
      output as never,
    );
    let settled = false;
    void projection?.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(postCount).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(true);
    await projection;

    expect(postCount).toBe(2);
    expect(summaryGets).toBe(2);
    expect(output.messages[0]?.parts[0]?.text).toContain("Available summary 0");
    expect(output.messages[0]?.parts[0]?.text).not.toContain(
      "Reflection summaries were unavailable",
    );
  });

  it("falls back to initial listing summaries when direct recovery GET fails", async () => {
    const sessionId = "recovery-get-fallback-session";
    const messages = projectionMessages(sessionId);
    const closed = segmentMessages(messages)[0]!;
    const client = clientFor(messages);
    let gets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response("sync failed", { status: 500 });
        }
        gets += 1;
        if (gets === 1) {
          return ok({
            session_id: sessionId,
            segments: [
              segmentSummary(sessionId, closed, "Initial listing summary"),
            ],
            boundaries: [segmentBoundary(sessionId, closed)],
            targets: [],
          });
        }
        return new Response("service unavailable", { status: 503 });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const output = { messages: structuredClone(messages) };

    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    expect(gets).toBe(2);
    expect(output.messages[0]?.parts[0]?.text).toContain(
      "Initial listing summary",
    );
    expect(output.messages[0]?.parts[0]?.text).not.toContain(
      "Reflection summaries were unavailable",
    );
  });

  it("throws when session is deleted while foreground sync is in flight", async () => {
    const sessionId = "session-deleted-during-sync";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    let postStarted: (() => void) | undefined;
    const postStartedPromise = new Promise<void>((resolve) => {
      postStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          postStarted?.();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          });
        }
        return ok({
          session_id: sessionId,
          segments: [],
          boundaries: [],
          targets: [],
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const output = { messages: structuredClone(messages) };
    const transformPromise = hooks["experimental.chat.messages.transform"]?.(
      {},
      output as never,
    );

    await postStartedPromise;
    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: sessionId } },
      },
    } as never);

    await expect(transformPromise).rejects.toThrow("was deleted");
  });

  it("throws when session is deleted while direct recovery GET is in flight", async () => {
    const sessionId = "session-deleted-during-direct-get";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    let getCount = 0;
    let directGetStarted: (() => void) | undefined;
    const directGetPromise = new Promise<void>((resolve) => {
      directGetStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response("failed", { status: 500 });
        }
        getCount += 1;
        if (getCount === 1) {
          return ok({
            session_id: sessionId,
            segments: [],
            boundaries: [],
            targets: [],
          });
        }
        directGetStarted?.();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const output = { messages: structuredClone(messages) };
    const transformPromise = hooks["experimental.chat.messages.transform"]?.(
      {},
      output as never,
    );

    await directGetPromise;
    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: sessionId } },
      },
    } as never);

    await expect(transformPromise).rejects.toThrow("was deleted");
  });
});
