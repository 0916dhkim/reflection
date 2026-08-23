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
  segmentMessages,
  submissionSourceFingerprint,
  type OpenCodeMessage,
  type ReflectionSegment,
} from "@reflection/shared/segmentation";
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

const SUMMARY_WAIT_TIMEOUT_MS = 90_000;
const SUMMARY_POLL_INTERVAL_MS = 1_000;

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
    projection_version: 1,
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
    projection_version: 1,
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
    projection_version: 1,
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

function emptyListing(url: string | URL | Request): Response {
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
          return ok();
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
      0, 100,
    ]);
    expect(summaryGets).toBe(4);
    expect(client.session.messages).toHaveBeenCalledTimes(3);
    expect(client.session.status).toHaveBeenCalledTimes(4);
    expect(output.messages[1]?.parts[0]?.text).toContain(
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
        return emptyListing(url);
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
      processing_priority: 0,
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
      processing_priority: 0,
    });
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
          return ok();
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
    expect(posted.map((body) => body.processing_priority)).toEqual([0, 0]);
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

  it("promotes an idle submission once for foreground processing", async () => {
    const sessionId = "priority-promotion-session";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    const submittedBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          submittedBodies.push(JSON.parse(String(init.body)));
          return ok();
        }
        return emptyListing(url);
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
      0, 100,
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
      0, 100,
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
          return ok();
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
    expect(postedPriorities).toEqual([0, 0, 100]);
    expect(output.messages[1]?.parts[0]?.text).toContain("Retained summary");
    expect(output.messages[1]?.parts[0]?.text).not.toContain(
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
          return ok();
        }
        return emptyListing(url);
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
        return emptyListing(url);
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
        return emptyListing(url);
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
        return emptyListing(url);
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
          return ok();
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
          return ok();
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
      0, 100,
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
          return ok();
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
      0, 0, 100, 100,
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
        if (init?.method === "POST") return ok();
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
          return ok();
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
        return emptyListing(url);
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
    const context = output.messages[1]?.parts[0]?.text;
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

    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    expect(summaryGets).toBe(1);
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

    expect(summaryGets).toBe(1);
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
    expect(summaryGets).toBe(2);
    expect(output.messages[1]?.parts[0]?.text).toContain(
      "Reflection summaries were unavailable",
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
    expect(client.session.messages).toHaveBeenCalledWith({
      path: { id: sessionId },
      query: { directory: "/tmp" },
      throwOnError: true,
    });
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
            : ok();
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
      0, 0, 100,
    ]);
    expect(submittedBodies.map((body) => body.start_user_message_id)).toEqual([
      failedSegmentKey,
      newClosedKey,
      newClosedKey,
    ]);
    expect(summaryGets).toBe(4);
    expect(output.messages[1]?.parts[0]?.text).not.toContain(
      "Reflection summaries were unavailable",
    );
    expect(output.messages[1]?.parts[0]?.text).toContain(
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
            : ok();
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
      0, 0, 100,
    ]);
    expect(summaryGets).toBe(5);
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
    expect(output.messages[1]?.parts[0]?.text).toContain("Post-rewind summary");
  });

  it("never rejects when queued idle finish work fails", async () => {
    const sessionId = "detached-finish-failure-session";
    const client = clientFor(projectionMessages(sessionId));
    client.session.list.mockRejectedValue(new Error("list failed"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => emptyListing(url)),
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

  it("waits for an exact required staged summary to appear", async () => {
    vi.useFakeTimers();
    const sessionId = "summary-poll-session";
    const messages = projectionMessages(sessionId);
    const required = segmentMessages(messages)[0]!;
    const client = clientFor(messages);
    let gets = 0;
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          posted.push(JSON.parse(String(init.body)));
          return ok();
        }
        gets += 1;
        if (gets === 1) {
          return ok({
            session_id: sessionId,
            segments: [],
            boundaries: [],
            targets: [],
          });
        }
        if (gets === 2) {
          return ok({
            session_id: sessionId,
            segments: [],
            boundaries: [],
            targets: [segmentTarget(sessionId, required)],
          });
        }
        return ok({
          session_id: sessionId,
          segments: [
            segmentSummary(sessionId, required, "Summary became available"),
          ],
          boundaries: [],
          targets: [segmentTarget(sessionId, required)],
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
    expect(gets).toBe(2);
    await vi.advanceTimersByTimeAsync(SUMMARY_POLL_INTERVAL_MS - 1);
    expect(gets).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await projection;

    expect(gets).toBe(3);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.processing_priority).toBe(100);
    expect(output.messages[1]?.parts[0]?.text).toContain(
      "Summary became available",
    );
    expect(output.messages[1]?.parts[0]?.text).not.toContain(
      PROJECTION_LOSS_WARNING,
    );
  });

  it("bounds summary polling and falls back to explicit lossy projection", async () => {
    vi.useFakeTimers();
    const sessionId = "summary-poll-timeout-session";
    const messages = projectionMessages(sessionId);
    const required = segmentMessages(messages)[0]!;
    const client = clientFor(messages);
    let gets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") return ok();
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
    const projection = hooks["experimental.chat.messages.transform"]?.(
      {},
      output as never,
    );

    await vi.advanceTimersByTimeAsync(
      SUMMARY_WAIT_TIMEOUT_MS + SUMMARY_POLL_INTERVAL_MS,
    );
    await projection;

    expect(gets).toBeGreaterThan(2);
    expect(output.messages[1]?.parts[0]?.text).toContain(
      "Reflection summaries were unavailable",
    );
  });

  it("falls back lossily when summary polling loses the service", async () => {
    const sessionId = "summary-poll-service-failure";
    const messages = projectionMessages(sessionId);
    const client = clientFor(messages);
    let gets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") return ok();
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
    expect(output.messages[1]?.parts[0]?.text).toContain(
      "Reflection summaries were unavailable",
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
          return ok();
        }
        return new Response("service unavailable", { status: 503 });
      }),
    );
    const hooks = await Reflection(pluginInput(client));
    const output = { messages: structuredClone(messages) };

    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    expect(posts).toBe(0);
    expect(client.session.messages).toHaveBeenCalledOnce();
    expect(output.messages[1]?.parts[0]?.text).toContain(
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

    expect(summaryGets).toBe(2);
    expect(output.messages[1]?.parts[0]?.text).toContain(
      "Reflection summaries were unavailable",
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
});
