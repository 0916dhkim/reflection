import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ContractValidationError,
  type SegmentBoundary,
  type SegmentCreate,
  type SegmentTargetBoundary,
} from "@reflection/shared/contracts";
import {
  segmentIdForRequest,
  sourceFingerprint,
} from "@reflection/shared/domain";
import {
  segmentMessages,
  type CommittedSegmentBoundary,
  type OpenCodeMessage,
  type ReflectionSegment,
} from "@reflection/shared/segmentation";

import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MESSAGE_QUERY,
  PART_QUERY,
  SESSION_QUERY,
  ReflectionHttpError,
  SessionRevisionChangedError,
  SupersededJobError,
  acquireLock,
  cleanupLaunchAgentCommand,
  completeJob,
  createDryRunSummary,
  createInitialState,
  createReflectionService,
  fetchJson,
  hydrateSessionMessages,
  parsePriorityJobIds,
  planSessionSegments,
  processPriorityJobs,
  processSession,
  recordFailureInState,
  releaseLock,
  resolveBackfillOptions,
  runBackfill,
  segmentSubmission,
  serializeState,
  sessionRemainsStable,
  stableSessionSnapshot,
  validateJobForSubmission,
  validatedJob,
  validateSegmentManifest,
  type BackfillState,
  type PlannedSegment,
  type ProcessingContext,
  type ReflectionJob,
  type ReflectionService,
  type SegmentManifest,
  type SessionStore,
} from "../src/backfill.js";

const SESSION_ID = "session-1";

function user(id: string, text: string): OpenCodeMessage {
  return {
    info: { id, role: "user" },
    parts: [{ type: "text", text }],
  };
}

function assistant(
  id: string,
  parentID: string,
  text: string,
): OpenCodeMessage {
  return {
    info: {
      id,
      role: "assistant",
      parentID,
      time: { completed: 1 },
    },
    parts: [{ type: "text", text }],
  };
}

function emptyManifest(sessionId = SESSION_ID): SegmentManifest {
  return {
    manifest_version: 2,
    session_id: sessionId,
    segments: [],
    boundaries: [],
    targets: [],
  };
}

function boundaryFor(
  sessionId: string,
  segment: ReflectionSegment,
  overrides: Partial<SegmentBoundary> = {},
): SegmentBoundary {
  const submission = segmentSubmission(sessionId, segment);
  return {
    id: segmentIdForRequest(submission),
    start_user_message_id: submission.start_user_message_id,
    end_user_message_id: submission.end_user_message_id,
    source_boundary_version: submission.source_boundary_version,
    start_source_message_id: submission.start_source_message_id,
    end_source_message_id: submission.end_source_message_id,
    projection_version: submission.projection_version,
    source_eligible: true,
    source_fingerprint: sourceFingerprint(submission),
    ...overrides,
  } as SegmentBoundary;
}

function targetFor(
  sessionId: string,
  segment: ReflectionSegment,
  status: SegmentTargetBoundary["status"],
  overrides: Partial<SegmentTargetBoundary> = {},
): SegmentTargetBoundary {
  const submission = segmentSubmission(sessionId, segment);
  return {
    id: segmentIdForRequest(submission),
    start_user_message_id: submission.start_user_message_id,
    end_user_message_id: submission.end_user_message_id,
    source_boundary_version: submission.source_boundary_version,
    start_source_message_id: submission.start_source_message_id,
    end_source_message_id: submission.end_source_message_id,
    projection_version: submission.projection_version,
    status,
    source_fingerprint: sourceFingerprint(submission),
    ...overrides,
  } as SegmentTargetBoundary;
}

function manifestWith(
  boundaries: SegmentBoundary[] = [],
  targets: SegmentTargetBoundary[] = [],
  sessionId = SESSION_ID,
): SegmentManifest {
  return validateSegmentManifest(
    {
      manifest_version: 2,
      session_id: sessionId,
      segments: [],
      boundaries,
      targets,
    },
    sessionId,
  );
}

function jobFor(
  submission: SegmentCreate,
  overrides: Partial<ReflectionJob> = {},
): ReflectionJob {
  const common = {
    id: 12,
    segment_id: segmentIdForRequest(submission),
    start_user_message_id: submission.start_user_message_id,
    end_user_message_id: submission.end_user_message_id,
    source_fingerprint: sourceFingerprint(submission),
    projection_version: submission.projection_version,
    status: "failed" as const,
    attempts: 1,
    error: "failed",
    created_at: "2026-08-22T00:00:00.000Z",
    started_at: null,
    finished_at: "2026-08-22T00:00:01.000Z",
    next_attempt_at: "2026-08-22T00:00:02.000Z",
  };
  const boundary =
    submission.source_boundary_version === 1
      ? {
          source_boundary_version: 1 as const,
          start_source_message_id: null,
          end_source_message_id: null,
        }
      : {
          source_boundary_version: 2 as const,
          start_source_message_id: submission.start_source_message_id,
          end_source_message_id: submission.end_source_message_id,
        };
  return { ...common, ...boundary, ...overrides } as ReflectionJob;
}

function v1Submission(id = "u1"): SegmentCreate {
  return {
    session_id: SESSION_ID,
    start_user_message_id: id,
    end_user_message_id: id,
    source_boundary_version: 1,
    start_source_message_id: null,
    end_source_message_id: null,
    projection_version: 1,
    processing_priority: 0,
    messages: [{ role: "user", text: id }],
  };
}

function state(): BackfillState {
  return createInitialState({}, () => "2026-08-22T00:00:00.000Z");
}

function processingContext(
  service: ReflectionService,
  options: {
    store?: SessionStore;
    priorityJobIds?: readonly number[];
    currentState?: BackfillState;
    nowMs?: number;
  } = {},
): ProcessingContext {
  const store =
    options.store ??
    ({
      sessions: [],
      sessionUpdatedAt: () => 100,
      sessionMessages: () => [],
    } satisfies SessionStore);
  return {
    state: options.currentState ?? state(),
    sessions: store.sessions,
    store,
    service,
    saveState: vi.fn(),
    log: vi.fn(),
    sleep: vi.fn(async () => undefined),
    clock: {
      nowIso: () => "2026-08-22T00:00:00.000Z",
      nowMs: () => options.nowMs ?? 1_000_000,
    },
    providerPollMs: 5_000,
    jobPollMs: 10,
    priorityJobIds: options.priorityJobIds ?? [],
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
    scheduleLaunchAgentCleanup: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SQLite hydration", () => {
  it("preserves query ordering and exact stored message identities", () => {
    expect(SESSION_QUERY).toContain("ORDER BY time_created DESC, id DESC");
    expect(MESSAGE_QUERY).toContain("ORDER BY m.time_created, m.id");
    expect(PART_QUERY).toContain("ORDER BY message_id, id");

    const messages = hydrateSessionMessages(
      SESSION_ID,
      [
        {
          id: "message-1",
          data: JSON.stringify({
            id: "stale-message-id",
            sessionID: "stale-session-id",
            role: "user",
            custom: "kept",
          }),
        },
        {
          id: "message-2",
          data: JSON.stringify({ role: "assistant", parentID: "message-1" }),
        },
      ],
      [
        {
          id: "part-1",
          messageId: "message-1",
          data: JSON.stringify({
            id: "stale-part-id",
            messageID: "stale-message-id",
            sessionID: "stale-session-id",
            type: "text",
            text: "request",
          }),
        },
        {
          id: "part-2",
          messageId: "message-2",
          data: JSON.stringify({ type: "text", text: "response" }),
        },
      ],
    );

    expect(messages).toEqual([
      {
        info: {
          id: "message-1",
          sessionID: SESSION_ID,
          role: "user",
          custom: "kept",
        },
        parts: [
          {
            id: "part-1",
            messageID: "message-1",
            sessionID: SESSION_ID,
            type: "text",
            text: "request",
          },
        ],
      },
      {
        info: {
          id: "message-2",
          sessionID: SESSION_ID,
          role: "assistant",
          parentID: "message-1",
        },
        parts: [
          {
            id: "part-2",
            messageID: "message-2",
            sessionID: SESSION_ID,
            type: "text",
            text: "response",
          },
        ],
      },
    ]);
  });
});

describe("stable session revisions", () => {
  it("discards hydration when the revision changes", () => {
    const updates = [100, 101];
    const sessionMessages = vi.fn(() => [user("u1", "request")]);
    const store: Pick<SessionStore, "sessionUpdatedAt" | "sessionMessages"> = {
      sessionUpdatedAt: () => updates.shift(),
      sessionMessages,
    };

    expect(
      stableSessionSnapshot(
        { id: SESSION_ID },
        store,
        { nowMs: () => 1_000 },
        100,
      ),
    ).toEqual({ ready: false, retryAt: 201 });
    expect(sessionMessages).toHaveBeenCalledOnce();
  });

  it("requires the same revision and a complete inactivity window", () => {
    const store = { sessionUpdatedAt: vi.fn(() => 100) };
    expect(
      sessionRemainsStable(SESSION_ID, 100, store, { nowMs: () => 200 }, 100),
    ).toBe(true);
    expect(
      sessionRemainsStable(SESSION_ID, 100, store, { nowMs: () => 199 }, 100),
    ).toBe(false);
    store.sessionUpdatedAt.mockReturnValue(101);
    expect(
      sessionRemainsStable(SESSION_ID, 100, store, { nowMs: () => 200 }, 100),
    ).toBe(false);
  });

  it("defers a dry-run session changed after manifest planning", async () => {
    const updates = [100, 100, 101];
    const session = { id: SESSION_ID, title: "test", timeUpdated: 100 };
    const store: SessionStore = {
      sessions: [session],
      sessionUpdatedAt: vi.fn(() => updates.shift() ?? 101),
      sessionMessages: () => [user("u1", "request")],
    };
    const request = vi.fn(async () => emptyManifest());

    const summary = await createDryRunSummary(
      [session],
      store,
      { request },
      { nowMs: () => 1_000_000 },
    );

    expect(request).toHaveBeenCalledOnce();
    expect(summary).toMatchObject({
      stableSessions: 0,
      deferredSessions: 1,
      invalidSessions: 0,
      segments: 0,
    });
  });

  it("reports a stable mutable source span as deferred work", async () => {
    const session = { id: SESSION_ID, title: "test", timeUpdated: 100 };
    const store: SessionStore = {
      sessions: [session],
      sessionUpdatedAt: () => 100,
      sessionMessages: () => [user("u1", "x".repeat(25_000))],
    };

    const summary = await createDryRunSummary(
      [session],
      store,
      { request: vi.fn(async () => emptyManifest()) },
      { nowMs: () => 1_000_000 },
    );

    expect(summary).toMatchObject({
      stableSessions: 0,
      deferredSessions: 1,
      segments: 1,
      statuses: { new: 1 },
      dispositions: { ready: 0, deferred_mutable_source: 1 },
    });
  });

  it("reports a malformed manifest explicitly without planning through it", async () => {
    const session = { id: SESSION_ID, title: "test", timeUpdated: 100 };
    const store: SessionStore = {
      sessions: [session],
      sessionUpdatedAt: () => 100,
      sessionMessages: () => [user("u1", "request")],
    };

    const summary = await createDryRunSummary(
      [session],
      store,
      {
        request: vi.fn(async () => ({
          ...emptyManifest(),
          manifest_version: 1,
        })),
      },
      { nowMs: () => 1_000_000 },
    );

    expect(summary).toMatchObject({
      invalidSessions: 1,
      segments: 0,
      statuses: { invalid: 1 },
    });
    expect(summary.planningFailures[0]).toMatchObject({
      sessionId: SESSION_ID,
    });
  });

  it("records an invalid session plan and continues the backfill", async () => {
    const invalid = { id: "invalid", title: "invalid", timeUpdated: 100 };
    const valid = { id: "valid", title: "valid", timeUpdated: 100 };
    const store: SessionStore = {
      sessions: [invalid, valid],
      sessionUpdatedAt: () => 100,
      sessionMessages: (sessionId) =>
        sessionId === invalid.id ? [user("u1", "request")] : [],
    };
    const service: ReflectionService = {
      request: vi.fn(async (path) =>
        path.includes(invalid.id)
          ? { ...emptyManifest(invalid.id), manifest_version: 1 }
          : emptyManifest(valid.id),
      ),
      getJob: vi.fn(),
      retryJob: vi.fn(),
      waitForJob: vi.fn(),
    };
    const context = processingContext(service, { store });

    await expect(runBackfill(context)).resolves.toBeUndefined();

    expect(context.state).toMatchObject({
      status: "completed_with_failures",
      sessionsVisited: 2,
      segmentsFailed: 1,
    });
    expect(context.state.failures[0]).toMatchObject({
      sessionId: invalid.id,
      segmentId: null,
    });
    expect(context.state.failures[0]?.error).toContain("invalid segment plan");
    expect(context.scheduleLaunchAgentCleanup).toHaveBeenCalledOnce();
    expect(context.releaseLock).toHaveBeenCalledOnce();
  });

  it("does not complete or schedule cleanup with deferred source work", async () => {
    const session = { id: SESSION_ID, title: "test", timeUpdated: 100 };
    const messages = [user("u1", "x".repeat(25_000))];
    const store: SessionStore = {
      sessions: [session],
      sessionUpdatedAt: () => 100,
      sessionMessages: () => messages,
    };
    const service: ReflectionService = {
      request: vi.fn(async () => emptyManifest()),
      getJob: vi.fn(),
      retryJob: vi.fn(),
      waitForJob: vi.fn(),
    };
    const context = processingContext(service, { store });
    const stop = new Error("stop after deferred wait");
    context.sleep = vi.fn(async () => {
      throw stop;
    });

    await expect(runBackfill(context)).rejects.toBe(stop);

    expect(context.state).toMatchObject({
      status: "waiting_for_session_inactivity",
      sessionsVisited: 0,
      deferredSessions: 1,
    });
    expect(context.scheduleLaunchAgentCleanup).not.toHaveBeenCalled();
    expect(context.releaseLock).toHaveBeenCalledOnce();
  });
});

describe("strict manifest planning", () => {
  it("requires manifest version 2 and exact v2 cursor fields", () => {
    expect(() =>
      validateSegmentManifest(
        { ...emptyManifest(), manifest_version: 1 },
        SESSION_ID,
      ),
    ).toThrow(ContractValidationError);

    const local = segmentMessages(
      [user("u1", "1234"), assistant("a1", "u1", "5678")],
      5,
    )[0]!;
    const target = targetFor(SESSION_ID, local, "pending");
    expect(() =>
      validateSegmentManifest(
        {
          ...emptyManifest(),
          targets: [{ ...target, end_source_message_id: null }],
        },
        SESSION_ID,
      ),
    ).toThrow(ContractValidationError);
    expect(() =>
      validateSegmentManifest({ ...emptyManifest(), extra: true }, SESSION_ID),
    ).toThrow(ContractValidationError);
  });

  it("rejects syntactically valid anchors with a non-deterministic id", () => {
    const segment = segmentMessages([user("u1", "request")])[0]!;
    const boundary = boundaryFor(SESSION_ID, segment, {
      id: "11111111-1111-4111-8111-111111111111",
    });
    expect(() => manifestWith([boundary])).toThrow(
      "non-deterministic identity",
    );
  });

  it("preserves same-user v2 siblings without a whole-turn follow-up", () => {
    const messages = [
      user("u1", "1234"),
      assistant("a1", "u1", "5678"),
      assistant("a2", "u1", "9012"),
    ];
    const initial = segmentMessages(messages, 10);
    expect(initial).toHaveLength(2);
    const manifest = manifestWith(
      [],
      [
        targetFor(SESSION_ID, initial[0]!, "pending"),
        targetFor(SESSION_ID, initial[1]!, "failed"),
      ],
    );

    const planned = planSessionSegments(SESSION_ID, messages, manifest, 10);

    expect(planned.map((segment) => segment.status)).toEqual([
      "target_pending",
      "target_failed",
    ]);
    expect(planned.map((segment) => segment.segmentId)).toHaveLength(2);
    expect(new Set(planned.map((segment) => segment.segmentId)).size).toBe(2);
    expect(planned.map((segment) => segment.sourceMessageIds)).toEqual([
      ["u1", "a1"],
      ["a2"],
    ]);
    expect(planned.flatMap((segment) => segment.sourceMessageIds)).toEqual([
      "u1",
      "a1",
      "a2",
    ]);
    expect(
      planned.every((segment) => segment.sourceBoundaryVersion === 2),
    ).toBe(true);
    expect(planned[0]!.sourceFingerprint).not.toBe(
      planned[1]!.sourceFingerprint,
    );
  });

  it("defers a mutable open V2 span before its assistant completes", () => {
    const messages = [user("u1", "x".repeat(25_000))];
    expect(
      planSessionSegments(SESSION_ID, messages, emptyManifest()),
    ).toMatchObject([
      {
        sourceBoundaryVersion: 2,
        status: "new",
        disposition: "deferred_mutable_source",
      },
    ]);

    messages.push({
      info: {
        id: "a1",
        role: "assistant",
        parentID: "u1",
        time: { created: 1, completed: 2 },
      },
      parts: [{ type: "text", text: "done" }],
    });
    expect(
      planSessionSegments(SESSION_ID, messages, emptyManifest()),
    ).toMatchObject([
      {
        sourceBoundaryVersion: 2,
        endSourceMessageId: "a1",
        disposition: "ready",
      },
    ]);
  });

  it("retains existing target state for a deferred mutable span", () => {
    const messages = [user("u1", "x".repeat(25_000))];
    const local = segmentMessages(messages)[0]!;
    const manifest = manifestWith(
      [],
      [targetFor(SESSION_ID, local, "running")],
    );

    expect(planSessionSegments(SESSION_ID, messages, manifest)).toMatchObject([
      {
        status: "target_running",
        targetStatus: "running",
        disposition: "deferred_mutable_source",
      },
    ]);
  });

  it("reconciles mixed v1 and exact v2 anchors in one canonical plan", () => {
    const messages = [
      user("u1", "1"),
      assistant("a1", "u1", "1"),
      user("u2", "1234"),
      assistant("a2", "u2", "5678"),
      assistant("a3", "u2", "9012"),
    ];
    const local = segmentMessages(messages, 10);
    expect(local.map((segment) => segment.sourceBoundaryVersion)).toEqual([
      1, 2, 2,
    ]);
    const manifest = manifestWith(
      [
        boundaryFor(SESSION_ID, local[0]!),
        boundaryFor(SESSION_ID, local[2]!, { source_eligible: false }),
      ],
      [targetFor(SESSION_ID, local[1]!, "running")],
    );

    const planned = planSessionSegments(SESSION_ID, messages, manifest, 10);

    expect(planned.map((segment) => segment.status)).toEqual([
      "eligible_committed",
      "target_running",
      "stale_committed",
    ]);
    expect(planned.map((segment) => segment.sourceMessageIds)).toEqual([
      ["u1", "a1"],
      ["u2", "a2"],
      ["a3"],
    ]);
  });

  it("classifies committed, target-only, and genuinely new snapshots distinctly", () => {
    const messages = [
      user("u1", "1"),
      user("u2", "2"),
      user("u3", "3"),
      user("u4", "4"),
    ];
    const local = segmentMessages(messages, 1);
    const manifest = manifestWith(
      [
        boundaryFor(SESSION_ID, local[0]!),
        boundaryFor(SESSION_ID, local[1]!, { source_eligible: false }),
      ],
      [targetFor(SESSION_ID, local[2]!, "running")],
    );

    const planned = planSessionSegments(SESSION_ID, messages, manifest, 1);
    expect(planned.map((segment) => segment.status)).toEqual([
      "eligible_committed",
      "stale_committed",
      "target_running",
      "new",
    ]);
    expect(planned[2]).toMatchObject({
      targetStatus: "running",
      manifestSourceFingerprint: planned[2]!.sourceFingerprint,
      drifts: [],
    });
  });

  it("reports target fingerprint drift as a conflict instead of new work", () => {
    const messages = [user("u1", "request")];
    const local = segmentMessages(messages)[0]!;
    const manifest = manifestWith(
      [],
      [
        targetFor(SESSION_ID, local, "failed", {
          source_fingerprint: "stale-fingerprint",
        }),
      ],
    );

    const planned = planSessionSegments(SESSION_ID, messages, manifest);
    expect(planned[0]).toMatchObject({
      status: "conflicting",
      targetStatus: "failed",
      manifestSourceFingerprint: "stale-fingerprint",
      drifts: ["source_fingerprint_mismatch"],
    });
  });
});

describe("strict jobs and exact submissions", () => {
  it("uses the shared strict job parser", () => {
    const valid = jobFor(v1Submission());
    expect(validatedJob(valid)).toEqual(valid);
    const { end_source_message_id: _end, ...missing } = valid;
    expect(() => validatedJob(missing)).toThrow(ContractValidationError);
    expect(() => validatedJob({ ...valid, extra: true })).toThrow(
      ContractValidationError,
    );
  });

  it("validates returned identity, full span, and source fingerprint", () => {
    const submission = v1Submission();
    const valid = jobFor(submission);
    expect(validateJobForSubmission(valid, submission)).toBe(valid);
    expect(() =>
      validateJobForSubmission(
        { ...valid, source_fingerprint: "wrong" },
        submission,
      ),
    ).toThrow("does not match submitted segment");
    expect(() =>
      validateJobForSubmission(
        { ...valid, end_user_message_id: "other" },
        submission,
      ),
    ).toThrow("does not match submitted segment");
  });

  it("reuses one byte-identical body for normal POST and projection replay", async () => {
    const messages = [user("u1", "request")];
    const local = segmentMessages(messages)[0]!;
    const submittedBodies: string[] = [];
    let manifestCalls = 0;
    let postCalls = 0;
    const service: ReflectionService = {
      request: vi.fn(async (path, init) => {
        if (path.includes("/sessions/")) {
          manifestCalls += 1;
          if (manifestCalls === 1) return emptyManifest();
          return manifestWith([
            boundaryFor(SESSION_ID, local, {
              projection_version: manifestCalls === 2 ? 0 : 1,
            }),
          ]);
        }
        submittedBodies.push(String(init?.body));
        const submission = JSON.parse(String(init?.body)) as SegmentCreate;
        postCalls += 1;
        return jobFor(submission, {
          status: "succeeded",
          error: null,
          projection_version: postCalls === 1 ? 0 : 1,
        });
      }),
      getJob: vi.fn(),
      retryJob: vi.fn(),
      waitForJob: vi.fn(),
    };
    const store: SessionStore = {
      sessions: [],
      sessionUpdatedAt: () => 100,
      sessionMessages: () => messages,
    };
    const context = processingContext(service, { store });

    await expect(
      processSession(
        context,
        { id: SESSION_ID, title: "test", timeUpdated: 100 },
        messages,
        100,
      ),
    ).resolves.toBe("completed");

    expect(submittedBodies).toHaveLength(2);
    expect(submittedBodies[0]).toBe(submittedBodies[1]);
    expect(JSON.parse(submittedBodies[0]!)).toEqual({
      session_id: SESSION_ID,
      start_user_message_id: "u1",
      end_user_message_id: "u1",
      projection_version: 1,
      processing_priority: 0,
      messages: [{ role: "user", text: "request" }],
      source_boundary_version: 1,
      start_source_message_id: null,
      end_source_message_id: null,
    });
    expect(context.state.currentSegment).toMatchObject({
      segmentId: segmentIdForRequest(segmentSubmission(SESSION_ID, local)),
      sourceBoundaryVersion: 1,
      startSourceMessageId: null,
      endSourceMessageId: null,
      sourceFingerprint: sourceFingerprint(
        segmentSubmission(SESSION_ID, local),
      ),
    });
    expect(context.log).toHaveBeenCalledWith(
      "processing session segment",
      expect.objectContaining({
        sessionId: SESSION_ID,
        sourceBoundaryVersion: 1,
      }),
    );
  });
});

describe("request retries and timeouts", () => {
  it("uses exponential service backoff for retryable responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "unavailable" }), {
          status: 500,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "limited" }), { status: 429 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    const wait = vi.fn(async () => undefined);
    const service = createReflectionService({
      url: "https://reflection.example",
      headers: { "X-Api-Key": "secret" },
      jobPollMs: 10,
      requestTimeoutMs: 100,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleep: wait,
    });

    await expect(service.request("/test")).resolves.toEqual({ ok: true });
    expect(wait).toHaveBeenNthCalledWith(1, 10);
    expect(wait).toHaveBeenNthCalledWith(2, 20);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("aborts a timed-out fetch and clears its timer", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        observedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener(
            "abort",
            () => reject(observedSignal?.reason),
            { once: true },
          );
        });
      },
    );

    const result = fetchJson("https://reflection.example/slow", {}, 1, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      requestTimeoutMs: 50,
    });
    const rejection = expect(result).rejects.toThrow("timed out after 50ms");
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(observedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout after a successful fetch", async () => {
    vi.useFakeTimers();
    await expect(
      fetchJson("https://reflection.example/fast", {}, 1, {
        fetchImpl: vi.fn(
          async () => new Response(JSON.stringify({ ok: true })),
        ) as unknown as typeof fetch,
        requestTimeoutMs: 50,
      }),
    ).resolves.toMatchObject({ body: { ok: true } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a terminal retry 409 as a superseded snapshot", async () => {
    const submission = v1Submission();
    const failed = jobFor(submission);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "newer snapshot" }), {
          status: 409,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(failed)));
    const service = createReflectionService({
      url: "https://reflection.example",
      headers: {},
      jobPollMs: 10,
      requestTimeoutMs: 100,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleep: vi.fn(async () => undefined),
    });

    await expect(service.retryJob(failed.id)).rejects.toBeInstanceOf(
      SupersededJobError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers idempotently when an ambiguous retry is already pending", async () => {
    const submission = v1Submission();
    const pending = jobFor(submission, {
      status: "pending",
      error: null,
      finished_at: null,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "already retried" }), {
          status: 409,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(pending)));
    const service = createReflectionService({
      url: "https://reflection.example",
      headers: {},
      jobPollMs: 10,
      requestTimeoutMs: 100,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleep: vi.fn(async () => undefined),
    });

    await expect(service.retryJob(pending.id)).resolves.toEqual(pending);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries the persisted target without replacing its exact request body", async () => {
    const submission = v1Submission();
    const pending = jobFor(submission, {
      status: "pending",
      error: null,
      finished_at: null,
    });
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(pending), { status: 202 }),
    );
    const service = createReflectionService({
      url: "https://reflection.example",
      headers: { "X-Api-Key": "secret" },
      jobPollMs: 10,
      requestTimeoutMs: 100,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(service.retryJob(pending.id)).resolves.toEqual(pending);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init).toMatchObject({
      method: "POST",
      headers: { "X-Api-Key": "secret" },
    });
    expect(init.body).toBeUndefined();
    expect(validateJobForSubmission(pending, submission)).toBe(pending);
  });
});

describe("job completion fencing", () => {
  it("retries sibling jobs independently", async () => {
    const first = jobFor(v1Submission("u1"), { id: 1 });
    const second = jobFor(v1Submission("u2"), { id: 2 });
    const retried: number[] = [];
    const complete = (job: ReflectionJob) =>
      completeJob(job, {
        state: state(),
        retryJob: vi.fn(async (jobId) => {
          retried.push(jobId);
          return {
            ...job,
            status: "succeeded",
            error: null,
          } as ReflectionJob;
        }),
        waitForJob: vi.fn(async (current) => current),
        saveState: vi.fn(),
        log: vi.fn(),
        sleep: vi.fn(async () => undefined),
        clock: { nowMs: () => 0 },
        providerPollMs: 5_000,
      });

    await complete(first);
    await complete(second);
    expect(retried).toEqual([1, 2]);
  });

  it("cancels a provider wait as soon as the session revision is stale", async () => {
    const providerFailure = jobFor(v1Submission(), {
      error: "upstream returned 402 Payment Required",
    });
    let stable = true;
    const retryJob = vi.fn(async () => providerFailure);
    const wait = vi.fn(async () => {
      stable = false;
    });

    await expect(
      completeJob(providerFailure, {
        state: state(),
        retryJob,
        waitForJob: vi.fn(async (current) => current),
        saveState: vi.fn(),
        log: vi.fn(),
        sleep: wait,
        clock: { nowMs: () => 1_000 },
        providerPollMs: 5_000,
        jobPollMs: 100,
        revalidateSession: () => {
          if (!stable) throw new SessionRevisionChangedError(SESSION_ID);
        },
      }),
    ).rejects.toBeInstanceOf(SessionRevisionChangedError);

    expect(retryJob).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
  });

  it("revalidates the desired target before a repeated provider wait", async () => {
    const providerFailure = jobFor(v1Submission(), {
      error: "upstream returned 402 Payment Required",
    });
    let targetChecks = 0;
    const wait = vi.fn(async () => undefined);

    await expect(
      completeJob(providerFailure, {
        state: state(),
        retryJob: vi.fn(async () => providerFailure),
        waitForJob: vi.fn(async (current) => current),
        saveState: vi.fn(),
        log: vi.fn(),
        sleep: wait,
        clock: { nowMs: () => 1_000 },
        providerPollMs: 5_000,
        revalidateExpectedSnapshot: () => {
          targetChecks += 1;
          if (targetChecks === 2)
            throw new SupersededJobError(providerFailure.id);
        },
      }),
    ).rejects.toBeInstanceOf(SupersededJobError);

    expect(targetChecks).toBe(2);
    expect(wait).not.toHaveBeenCalled();
  });

  it("stops stale sibling processing and returns replan on supersession", async () => {
    const messages = [
      user("u1", "request"),
      assistant("a1", "u1", "first"),
      assistant("a2", "u1", "second"),
    ];
    const anchor: CommittedSegmentBoundary = {
      startUserMessageId: "u1",
      endUserMessageId: "u1",
      sourceBoundaryVersion: 2,
      startSourceMessageId: "u1",
      endSourceMessageId: "a1",
    };
    const local = segmentMessages(messages, 100, [anchor]);
    expect(local).toHaveLength(2);
    const manifest = manifestWith(
      [],
      [targetFor(SESSION_ID, local[0]!, "failed")],
    );
    let postCount = 0;
    const service: ReflectionService = {
      request: vi.fn(async (path, init) => {
        if (path.includes("/sessions/")) return manifest;
        postCount += 1;
        return jobFor(JSON.parse(String(init?.body)) as SegmentCreate);
      }),
      getJob: vi.fn(),
      retryJob: vi.fn(async (jobId) => {
        throw new SupersededJobError(jobId);
      }),
      waitForJob: vi.fn(),
    };
    const store: SessionStore = {
      sessions: [],
      sessionUpdatedAt: () => 100,
      sessionMessages: () => messages,
    };
    const context = processingContext(service, { store });

    await expect(
      processSession(
        context,
        { id: SESSION_ID, title: "test", timeUpdated: 100 },
        messages,
        100,
      ),
    ).resolves.toBe("replan");
    expect(postCount).toBe(1);
    expect(context.state.segmentsFailed).toBe(0);
    expect(context.state.sessionsVisited).toBe(0);
  });
});

describe("configuration and retained recovery jobs", () => {
  it("defaults to no priority jobs and parses an optional de-duplicated list", () => {
    const defaults = resolveBackfillOptions([], {}, "/home/test");
    expect(defaults.priorityJobIds).toEqual([]);
    expect(defaults.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(parsePriorityJobIds("7, 8,7")).toEqual([7, 8]);
    expect(
      resolveBackfillOptions(
        [],
        { REFLECTION_BACKFILL_PRIORITY_JOB_IDS: "4, 9" },
        "/home/test",
      ).priorityJobIds,
    ).toEqual([4, 9]);
  });

  it.each([
    ["REFLECTION_PROVIDER_POLL_MS", "0"],
    ["REFLECTION_JOB_POLL_MS", "NaN"],
    ["REFLECTION_REQUEST_TIMEOUT_MS", "1.5"],
    ["REFLECTION_BACKFILL_PRIORITY_JOB_IDS", "7,nope"],
  ])("rejects invalid %s values", (name, value) => {
    expect(() =>
      resolveBackfillOptions([], { [name]: value }, "/home/test"),
    ).toThrow("positive finite integer");
  });

  it("tolerates a configured priority job that no longer exists", async () => {
    const service = {
      request: vi.fn(),
      getJob: vi.fn(async () => {
        throw new ReflectionHttpError("/v1/jobs/404", 404, {
          detail: "missing",
        });
      }),
      retryJob: vi.fn(),
      waitForJob: vi.fn(),
    } as ReflectionService;
    const context = processingContext(service, { priorityJobIds: [404] });

    await expect(processPriorityJobs(context)).resolves.toBeUndefined();
    expect(context.state.segmentsFailed).toBe(0);
    expect(context.log).toHaveBeenCalledWith(
      "retained priority job is no longer available",
      expect.objectContaining({ jobId: 404 }),
    );
  });
});

describe("state, locking, and cleanup", () => {
  it("resets per-run state and serializes with a trailing newline", () => {
    const timestamps = ["2026-08-22T01:00:00.000Z", "2026-08-22T01:00:00.001Z"];
    const current = createInitialState(
      { runCount: "4", sessionsVisited: 99, failures: [{ error: "old" }] },
      () => timestamps.shift()!,
    );
    expect(current).toMatchObject({
      runCount: 5,
      startedAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T01:00:00.001Z",
      status: "starting",
      sessionsVisited: 0,
      failures: [],
    });
    expect(serializeState(current)).toBe(
      `${JSON.stringify(current, null, 2)}\n`,
    );
  });

  it("retains exact source identity in the latest 100 failures", () => {
    const current = state();
    const planned = planSessionSegments(
      SESSION_ID,
      [user("u1", "request")],
      emptyManifest(),
    )[0]!;
    for (let index = 0; index <= 100; index += 1) {
      recordFailureInState(current, `session-${index}`, planned, {
        id: index,
        error: index === 100 ? "x".repeat(1_100) : String(index),
      });
    }
    expect(current.failures).toHaveLength(100);
    expect(current.failures[0]?.sessionId).toBe("session-1");
    expect(current.failures.at(-1)).toMatchObject({
      segmentId: planned.segmentId,
      sourceBoundaryVersion: planned.sourceBoundaryVersion,
      startSourceMessageId: planned.startSourceMessageId,
      endSourceMessageId: planned.endSourceMessageId,
      sourceFingerprint: planned.sourceFingerprint,
    });
    expect(current.failures.at(-1)?.error).toHaveLength(1_000);
  });

  it("replaces a stale lock but preserves a live owner lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "reflection-backfill-test-"));
    const lockPath = join(directory, "worker.lock");
    try {
      writeFileSync(lockPath, "123\n");
      acquireLock(lockPath, 456, () => {
        throw Object.assign(new Error("missing"), { code: "ESRCH" });
      });
      expect(readFileSync(lockPath, "utf8")).toBe("456\n");
      releaseLock(lockPath, 999);
      expect(readFileSync(lockPath, "utf8")).toBe("456\n");
      releaseLock(lockPath, 456);

      writeFileSync(lockPath, "789\n");
      expect(() => acquireLock(lockPath, 456, () => true)).toThrow(
        "already running as PID 789",
      );
      expect(readFileSync(lockPath, "utf8")).toBe("789\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the cleanup helper path and supervisor arguments stable", () => {
    expect(
      cleanupLaunchAgentCommand(
        "/repo/scripts/src",
        "com.example.reflection",
        "/tmp/reflection.plist",
        "/tmp/state",
      ),
    ).toEqual({
      command: process.execPath,
      arguments: [
        "/repo/scripts/cleanup-launch-agent.mjs",
        "com.example.reflection",
        "/tmp/reflection.plist",
        "/tmp/state/cleanup.json",
      ],
    });
  });
});
