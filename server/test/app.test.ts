import { randomUUID } from "node:crypto";

import {
  parseSegmentCreate,
  parseSegmentResponse,
  type JobResponse,
  type QueueStatusResponse,
  type SegmentResponse,
  type SegmentSummary,
} from "@reflection/shared/contracts";
import {
  segmentIdForRequest,
  sourceFingerprint,
} from "@reflection/shared/domain";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  REQUEST_BODY_LIMIT_BYTES,
  apiKeysMatch,
  createApp,
  type AppDatabase,
  type AppDependencies,
  type AppSearchService,
  type AppWorker,
  type ReflectionApp,
} from "../src/app.js";
import { UpstreamRequestError, UpstreamResponseError } from "../src/clients.js";
import { loadSettings, type Settings } from "../src/config.js";
import {
  JobNotRetryableError,
  failedTargetMatchesJob,
} from "../src/database.js";

const API_HEADERS = { "x-api-key": "test-key" };
const openApps = new Set<ReflectionApp>();

function settings(): Settings {
  return loadSettings({
    DATABASE_URL: "postgresql://unused",
    REFLECTION_API_KEY: "test-key",
    OPENROUTER_API_KEY: "test",
    VOYAGE_API_KEY: "test",
  });
}

function jobResponse(status: JobResponse["status"] = "pending"): JobResponse {
  const now = "2026-08-22T12:00:00Z";
  return {
    id: 1,
    segment_id: randomUUID(),
    start_user_message_id: "start",
    end_user_message_id: "end",
    source_boundary_version: 1,
    start_source_message_id: null,
    end_source_message_id: null,
    source_fingerprint: null,
    projection_version: 0,
    status,
    attempts: 0,
    error: null,
    created_at: now,
    started_at: null,
    finished_at: null,
    next_attempt_at: now,
  };
}

function queueStatusResponse(): QueueStatusResponse {
  const counts = {
    total: 4,
    pending: 1,
    running: 1,
    succeeded: 1,
    failed: 1,
    superseded: 0,
  };
  return {
    observed_at: "2026-08-31T17:30:00Z",
    job_counts: counts,
    target_counts: counts,
    pending_due: 1,
    pending_delayed: 0,
    oldest_due_job: {
      id: 1,
      attempts: 0,
      processing_priority: 50,
      due_at: "2026-08-31T17:29:00Z",
      age_seconds: 60,
    },
    running_jobs: [
      {
        id: 2,
        attempts: 1,
        processing_priority: 100,
        started_at: "2026-08-31T17:28:00Z",
        age_seconds: 120,
      },
    ],
    running_jobs_truncated: false,
    failure_categories: [
      {
        category: "UpstreamHttp429",
        count: 1,
        pending: 0,
        failed: 1,
        latest_finished_at: "2026-08-31T17:27:00Z",
      },
    ],
    failure_categories_truncated: false,
    recent_terminal_jobs: [
      { window_seconds: 300, succeeded: 1, failed: 1 },
      { window_seconds: 3_600, succeeded: 1, failed: 1 },
      { window_seconds: 86_400, succeeded: 1, failed: 1 },
    ],
  };
}

function dependencies(
  overrides: {
    database?: Partial<AppDatabase>;
    worker?: Partial<AppWorker>;
    searchService?: Partial<AppSearchService>;
  } = {},
): AppDependencies {
  const database = {
    open: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    healthcheck: vi.fn(async () => undefined),
    queueStatus: vi.fn(async () => queueStatusResponse()),
    enqueue: vi.fn(async () => jobResponse()),
    getJob: vi.fn(async () => null),
    retryFailedJob: vi.fn(async () => null),
    supersedeFailedJob: vi.fn(async () => null),
    getSegment: vi.fn(async () => null),
    sessionSegmentListing: vi.fn(async () => [[], [], []] as const),
    ...overrides.database,
  } as AppDatabase;
  const worker = {
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    wake: vi.fn(),
    ...overrides.worker,
  } as AppWorker;
  const searchService = {
    search: vi.fn(async () => ({ claims: [] })),
    ...overrides.searchService,
  } as AppSearchService;
  return { database, worker, searchService };
}

function appWith(injected: AppDependencies = dependencies()): {
  app: ReflectionApp;
  injected: AppDependencies;
} {
  const app = createApp({
    settings: settings(),
    dependencies: injected,
    logger: false,
  });
  openApps.add(app);
  return { app, injected };
}

afterEach(async () => {
  await Promise.all(
    [...openApps].map(async (app) => {
      await app.close();
      openApps.delete(app);
    }),
  );
  vi.restoreAllMocks();
});

describe("API key authentication", () => {
  test("always compares fixed-length digests, including a missing key", () => {
    const compared: Array<[Buffer, Buffer]> = [];
    const compare = (left: Buffer, right: Buffer) => {
      compared.push([left, right]);
      return left.equals(right);
    };

    expect(apiKeysMatch("expected", "expected", compare)).toBe(true);
    expect(apiKeysMatch(undefined, "expected", compare)).toBe(false);
    expect(compared).toHaveLength(2);
    expect(
      compared.every(
        ([left, right]) => left.length === 32 && right.length === 32,
      ),
    ).toBe(true);
  });

  test("protects every v1 route while health and documentation stay public", async () => {
    const { app } = appWith();

    const health = await app.inject({ method: "GET", url: "/healthz" });
    const missing = await app.inject({ method: "GET", url: "/v1/jobs/1" });
    const wrong = await app.inject({
      method: "GET",
      url: "/v1/jobs/1",
      headers: { "x-api-key": "wrong" },
    });
    const malformedWithoutKey = await app.inject({
      method: "POST",
      url: "/v1/segments",
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    const openapi = await app.inject({ method: "GET", url: "/openapi.json" });

    expect(health).toMatchObject({ statusCode: 200 });
    expect(missing.json()).toEqual({ detail: "invalid API key" });
    expect(wrong.statusCode).toBe(401);
    expect(malformedWithoutKey.statusCode).toBe(401);
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json()).toMatchObject({
      info: { title: "Reflection", version: "0.1.0" },
    });
  });
});

describe("lifecycle and health", () => {
  test("opens before serving, starts the worker, and stops it before closing", async () => {
    const events: string[] = [];
    const injected = dependencies({
      database: {
        open: vi.fn(async () => {
          events.push("open");
        }),
        close: vi.fn(async () => {
          events.push("close");
        }),
      },
      worker: {
        start: vi.fn(() => events.push("start")),
        stop: vi.fn(async () => {
          events.push("stop");
        }),
      },
    });
    const { app } = appWith(injected);

    await app.ready();
    expect(events).toEqual(["open", "start"]);
    await app.close();
    openApps.delete(app);

    expect(events).toEqual(["open", "start", "stop", "close"]);
  });

  test("reports database failures without exposing their error", async () => {
    const injected = dependencies({
      database: {
        healthcheck: vi.fn(async () => {
          throw new Error("database credentials and host");
        }),
      },
    });
    const { app } = appWith(injected);

    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unhealthy" });
    expect(response.body).not.toContain("credentials");
  });

  test("trusts forwarded client addresses like the previous proxy-aware server", async () => {
    const { app } = appWith();
    app.get("/_test/ip", async (request) => ({ ip: request.ip }));

    const response = await app.inject({
      method: "GET",
      url: "/_test/ip",
      headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.2" },
    });

    expect(response.json()).toEqual({ ip: "203.0.113.10" });
  });
});

describe("queue diagnostics", () => {
  test("returns authenticated bounded queue state and documents the route", async () => {
    const status = queueStatusResponse();
    const queueStatus = vi.fn<AppDatabase["queueStatus"]>(async () => status);
    const { app } = appWith(dependencies({ database: { queueStatus } }));

    const unauthorized = await app.inject({
      method: "GET",
      url: "/v1/queue",
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/queue",
      headers: API_HEADERS,
    });
    const openapi = await app.inject({ method: "GET", url: "/openapi.json" });

    expect(unauthorized.statusCode).toBe(401);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(status);
    expect(response.body).not.toContain("payload");
    expect(queueStatus).toHaveBeenCalledOnce();
    const queueOperation = openapi.json().paths["/v1/queue"].get;
    expect(queueOperation.parameters).toContainEqual(
      expect.objectContaining({
        name: "x-api-key",
        in: "header",
        required: true,
      }),
    );
  });
});

describe("segment API", () => {
  test("accepts empty text and a one-million-character turn without truncation", async () => {
    const enqueue = vi.fn<AppDatabase["enqueue"]>(async () => jobResponse());
    const injected = dependencies({ database: { enqueue } });
    const { app } = appWith(injected);

    const empty = await app.inject({
      method: "POST",
      url: "/v1/segments",
      headers: API_HEADERS,
      payload: {
        session_id: " session ",
        start_user_message_id: "start",
        end_user_message_id: "end",
        messages: [{ role: "assistant", text: "" }],
      },
    });
    const largeText = "x".repeat(1_000_000);
    const large = await app.inject({
      method: "POST",
      url: "/v1/segments",
      headers: API_HEADERS,
      payload: {
        session_id: "session",
        start_user_message_id: "large",
        end_user_message_id: "large-end",
        messages: [{ role: "user", text: largeText }],
      },
    });

    expect(empty.statusCode).toBe(202);
    expect(large.statusCode).toBe(202);
    const first = enqueue.mock.calls[0]?.[0];
    const second = enqueue.mock.calls[1]?.[0];
    expect(first).toMatchObject({
      session_id: "session",
      projection_version: 0,
      processing_priority: 0,
      source_boundary_version: 1,
      start_source_message_id: null,
      end_source_message_id: null,
    });
    expect(first?.messages).toEqual([{ role: "assistant", text: "" }]);
    expect(second?.messages[0]?.text).toBe(largeText);
    expect(injected.worker.wake).toHaveBeenCalledTimes(2);
    expect(REQUEST_BODY_LIMIT_BYTES).toBeGreaterThan(8 * 1024 * 1024);
  });

  test("returns 422 for aggregate limits and strict nested validation", async () => {
    const { app, injected } = appWith();
    const base = {
      session_id: "session",
      start_user_message_id: "start",
      end_user_message_id: "end",
    };

    const tooLarge = await app.inject({
      method: "POST",
      url: "/v1/segments",
      headers: API_HEADERS,
      payload: {
        ...base,
        messages: [
          { role: "user", text: "x".repeat(1_000_000) },
          { role: "assistant", text: "y".repeat(1_000_000) },
          { role: "user", text: "z" },
        ],
      },
    });
    const extra = await app.inject({
      method: "POST",
      url: "/v1/segments",
      headers: API_HEADERS,
      payload: {
        ...base,
        messages: [{ role: "user", text: "text", unexpected: true }],
      },
    });

    expect(tooLarge.statusCode).toBe(422);
    expect(tooLarge.body).toContain("combined message text");
    expect(extra.statusCode).toBe(422);
    expect(injected.database.enqueue).not.toHaveBeenCalled();
  });

  test("accepts canonical v2 spans and rejects malformed mixed spans", async () => {
    const enqueue = vi.fn<AppDatabase["enqueue"]>(async () => jobResponse());
    const { app } = appWith(dependencies({ database: { enqueue } }));
    const base = {
      session_id: "session",
      start_user_message_id: "turn",
      end_user_message_id: "turn",
      source_boundary_version: 2,
      start_source_message_id: "message-a",
      end_source_message_id: "message-b",
      processing_priority: 100,
      messages: [{ role: "user", text: "text" }],
    };

    const accepted = await app.inject({
      method: "POST",
      url: "/v1/segments",
      headers: API_HEADERS,
      payload: base,
    });
    const missingCursor = await app.inject({
      method: "POST",
      url: "/v1/segments",
      headers: API_HEADERS,
      payload: { ...base, end_source_message_id: undefined },
    });
    const crossingTurns = await app.inject({
      method: "POST",
      url: "/v1/segments",
      headers: API_HEADERS,
      payload: { ...base, end_user_message_id: "other-turn" },
    });

    expect(accepted.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining(base));
    expect(missingCursor.statusCode).toBe(422);
    expect(crossingTurns.statusCode).toBe(422);
  });

  test("accepts JSON without a content type and validates unsupported media as input", async () => {
    const enqueue = vi.fn<AppDatabase["enqueue"]>(async () => jobResponse());
    const { app } = appWith(dependencies({ database: { enqueue } }));
    const body = JSON.stringify({
      session_id: "session",
      start_user_message_id: "start",
      end_user_message_id: "end",
      messages: [{ role: "user", text: "text" }],
    });

    const noContentType = await app.inject({
      method: "POST",
      url: "/v1/segments",
      headers: { "x-api-key": "test-key" },
      payload: body,
    });
    const plainText = await app.inject({
      method: "POST",
      url: "/v1/segments",
      headers: {
        ...API_HEADERS,
        "content-type": "text/plain",
      },
      payload: body,
    });
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/segments",
      headers: {
        ...API_HEADERS,
        "content-type": "application/json",
      },
      payload: "{",
    });

    expect(noContentType.statusCode).toBe(202);
    expect(plainText.statusCode).toBe(422);
    expect(malformed.statusCode).toBe(422);
    expect(enqueue).toHaveBeenCalledOnce();
  });
});

describe("jobs and committed segments", () => {
  test("returns jobs, missing resources, validation errors, and retry conflicts", async () => {
    const existing = jobResponse("failed");
    const getJob = vi
      .fn<AppDatabase["getJob"]>()
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(null);
    const retryFailedJob = vi
      .fn<AppDatabase["retryFailedJob"]>()
      .mockResolvedValueOnce(existing)
      .mockRejectedValueOnce(
        new JobNotRetryableError("only terminal failed jobs can be retried"),
      )
      .mockResolvedValueOnce(null);
    const { app, injected } = appWith(
      dependencies({ database: { getJob, retryFailedJob } }),
    );

    const found = await app.inject({
      method: "GET",
      url: "/v1/jobs/1",
      headers: API_HEADERS,
    });
    const missing = await app.inject({
      method: "GET",
      url: "/v1/jobs/2",
      headers: API_HEADERS,
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/v1/jobs/not-an-int",
      headers: API_HEADERS,
    });
    const retried = await app.inject({
      method: "POST",
      url: "/v1/jobs/1/retry",
      headers: API_HEADERS,
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/v1/jobs/1/retry",
      headers: API_HEADERS,
    });
    const retryMissing = await app.inject({
      method: "POST",
      url: "/v1/jobs/2/retry",
      headers: API_HEADERS,
    });

    expect(found.json()).toEqual(existing);
    expect(missing).toMatchObject({ statusCode: 404 });
    expect(missing.json()).toEqual({ detail: "job not found" });
    expect(invalid.statusCode).toBe(422);
    expect(retried.statusCode).toBe(202);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      detail: "only terminal failed jobs can be retried",
    });
    expect(retryMissing.statusCode).toBe(404);
    expect(injected.worker.wake).toHaveBeenCalledOnce();
  });

  test("restarts failed extraction, supersedes obsolete targets, and enforces worker wake policies", async () => {
    const existing = jobResponse("failed");
    const superseded: JobResponse = {
      ...existing,
      status: "superseded",
      error: "snapshot was superseded",
      finished_at: "2026-08-22T12:00:00Z",
    };
    const retryFailedJob = vi
      .fn<AppDatabase["retryFailedJob"]>()
      .mockResolvedValueOnce(existing)
      .mockRejectedValueOnce(
        new JobNotRetryableError(
          "job cannot be retried because a newer snapshot exists for the segment",
        ),
      )
      .mockResolvedValueOnce(null);
    const supersedeFailedJob = vi
      .fn<AppDatabase["supersedeFailedJob"]>()
      .mockResolvedValueOnce(superseded)
      .mockRejectedValueOnce(
        new JobNotRetryableError("only terminal failed jobs can be retried"),
      )
      .mockResolvedValueOnce(null);
    const { app, injected } = appWith(
      dependencies({ database: { retryFailedJob, supersedeFailedJob } }),
    );

    const restartOk = await app.inject({
      method: "POST",
      url: "/v1/jobs/1/restart",
      headers: API_HEADERS,
    });
    expect(restartOk.statusCode).toBe(202);
    expect(restartOk.json()).toEqual(existing);
    expect(retryFailedJob).toHaveBeenLastCalledWith(1, {
      restartExtraction: true,
    });
    expect(injected.worker.wake).toHaveBeenCalledTimes(1);

    const restartConflict = await app.inject({
      method: "POST",
      url: "/v1/jobs/1/restart",
      headers: API_HEADERS,
    });
    expect(restartConflict.statusCode).toBe(409);
    expect(restartConflict.json()).toEqual({
      detail:
        "job cannot be retried because a newer snapshot exists for the segment",
    });

    const restartMissing = await app.inject({
      method: "POST",
      url: "/v1/jobs/2/restart",
      headers: API_HEADERS,
    });
    expect(restartMissing.statusCode).toBe(404);
    expect(restartMissing.json()).toEqual({ detail: "job not found" });

    const restartInvalid = await app.inject({
      method: "POST",
      url: "/v1/jobs/not-an-int/restart",
      headers: API_HEADERS,
    });
    expect(restartInvalid.statusCode).toBe(422);

    const restartUnauthorized = await app.inject({
      method: "POST",
      url: "/v1/jobs/1/restart",
    });
    expect(restartUnauthorized.statusCode).toBe(401);

    const supersedeOk = await app.inject({
      method: "POST",
      url: "/v1/jobs/1/supersede",
      headers: API_HEADERS,
    });
    expect(supersedeOk.statusCode).toBe(200);
    expect(supersedeOk.json()).toEqual(superseded);
    expect(supersedeFailedJob).toHaveBeenLastCalledWith(1);
    expect(injected.worker.wake).toHaveBeenCalledTimes(1);

    const supersedeConflict = await app.inject({
      method: "POST",
      url: "/v1/jobs/1/supersede",
      headers: API_HEADERS,
    });
    expect(supersedeConflict.statusCode).toBe(409);
    expect(supersedeConflict.json()).toEqual({
      detail: "only terminal failed jobs can be retried",
    });

    const supersedeMissing = await app.inject({
      method: "POST",
      url: "/v1/jobs/2/supersede",
      headers: API_HEADERS,
    });
    expect(supersedeMissing.statusCode).toBe(404);
    expect(supersedeMissing.json()).toEqual({ detail: "job not found" });

    const supersedeInvalid = await app.inject({
      method: "POST",
      url: "/v1/jobs/not-an-int/supersede",
      headers: API_HEADERS,
    });
    expect(supersedeInvalid.statusCode).toBe(422);

    const supersedeUnauthorized = await app.inject({
      method: "POST",
      url: "/v1/jobs/1/supersede",
    });
    expect(supersedeUnauthorized.statusCode).toBe(401);
  });

  test("validates failed target matching pure logic", () => {
    const payload = parseSegmentCreate({
      session_id: "ses_1",
      start_user_message_id: "msg_user_1",
      end_user_message_id: "msg_user_1",
      source_boundary_version: 1,
      start_source_message_id: null,
      end_source_message_id: null,
      projection_version: 1,
      processing_priority: 0,
      messages: [{ role: "user", text: "" }],
    });
    const segmentId = segmentIdForRequest(payload);
    const fingerprint = sourceFingerprint(payload);
    const validJob = {
      id: 1,
      segment_id: segmentId,
      session_id: "ses_1",
      start_user_message_id: "msg_user_1",
      status: "failed",
      lease_id: null,
      source_generation: 1n,
      source_fingerprint: fingerprint,
      projection_version: 1,
      end_user_message_id: "msg_user_1",
      source_boundary_version: 1,
      start_source_message_id: null,
      end_source_message_id: null,
    };
    const validTarget = {
      job_id: 1,
      end_user_message_id: "msg_user_1",
      source_boundary_version: 1,
      start_source_message_id: null,
      end_source_message_id: null,
      projection_version: 1,
      payload,
      source_generation: 1n,
      source_fingerprint: fingerprint,
      extraction_result: null,
      extraction_validation_version: null,
      extraction_validation_fingerprint: null,
      summary_commit_fingerprint: null,
      processing_priority: 0,
    };

    expect(failedTargetMatchesJob(undefined, validJob)).toBe(false);
    expect(failedTargetMatchesJob(validTarget, validJob)).toBe(true);
    expect(
      failedTargetMatchesJob({ ...validTarget, job_id: 2 }, validJob),
    ).toBe(false);
    expect(
      failedTargetMatchesJob(
        { ...validTarget, source_generation: 2n },
        validJob,
      ),
    ).toBe(false);
    expect(
      failedTargetMatchesJob(
        { ...validTarget, source_fingerprint: "other" },
        validJob,
      ),
    ).toBe(false);
    expect(
      failedTargetMatchesJob(
        { ...validTarget, projection_version: 2 },
        validJob,
      ),
    ).toBe(false);
    expect(
      failedTargetMatchesJob(
        { ...validTarget, payload: "invalid-json" },
        validJob,
      ),
    ).toBe(false);
    expect(
      failedTargetMatchesJob(
        {
          ...validTarget,
          payload: { ...payload, session_id: "other_ses" },
        },
        validJob,
      ),
    ).toBe(false);
  });

  test("returns a segment and rejects invalid or missing UUIDs", async () => {
    const segmentId = randomUUID();
    const segment: SegmentResponse = {
      id: segmentId,
      session_id: "session",
      start_user_message_id: "start",
      end_user_message_id: "end",
      source_boundary_version: 1,
      start_source_message_id: null,
      end_source_message_id: null,
      summary: "What happened",
      claims: [],
      created_at: "2026-08-22T12:00:00Z",
      updated_at: "2026-08-22T12:00:00Z",
    };
    const getSegment = vi
      .fn<AppDatabase["getSegment"]>()
      .mockResolvedValueOnce(segment)
      .mockResolvedValueOnce(null);
    const { app } = appWith(dependencies({ database: { getSegment } }));

    const found = await app.inject({
      method: "GET",
      url: `/v1/segments/${segmentId}`,
      headers: API_HEADERS,
    });
    const missing = await app.inject({
      method: "GET",
      url: `/v1/segments/${randomUUID()}`,
      headers: API_HEADERS,
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/v1/segments/not-a-uuid",
      headers: API_HEADERS,
    });

    expect(found.json()).toEqual(segment);
    expect(missing.json()).toEqual({ detail: "segment not found" });
    expect(invalid.statusCode).toBe(422);
  });

  test("reports invalid persisted response data as an internal error", async () => {
    const segmentId = randomUUID();
    const getSegment = vi.fn<AppDatabase["getSegment"]>(async () =>
      parseSegmentResponse({}),
    );
    const { app } = appWith(dependencies({ database: { getSegment } }));

    const response = await app.inject({
      method: "GET",
      url: `/v1/segments/${segmentId}`,
      headers: API_HEADERS,
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe("Internal Server Error");
  });

  test("returns ordered session summary metadata", async () => {
    const id = randomUUID();
    const summary: SegmentSummary = {
      id,
      start_user_message_id: "start",
      end_user_message_id: "end",
      source_boundary_version: 1,
      start_source_message_id: null,
      end_source_message_id: null,
      projection_version: 0,
      summary: "What happened",
    };
    const listing: Awaited<ReturnType<AppDatabase["sessionSegmentListing"]>> = [
      [summary],
      [
        {
          id,
          start_user_message_id: "start",
          end_user_message_id: "end",
          source_boundary_version: 1,
          start_source_message_id: null,
          end_source_message_id: null,
          projection_version: 0,
          source_eligible: true,
          source_fingerprint: "abc123",
        },
      ],
      [],
    ];
    const { app } = appWith(
      dependencies({
        database: { sessionSegmentListing: vi.fn(async () => listing) },
      }),
    );

    const response = await app.inject({
      method: "GET",
      url: "/v1/sessions/session/segments",
      headers: API_HEADERS,
    });

    expect(response.json()).toEqual({
      manifest_version: 2,
      session_id: "session",
      segments: [summary],
      boundaries: [
        {
          id,
          start_user_message_id: "start",
          end_user_message_id: "end",
          source_boundary_version: 1,
          start_source_message_id: null,
          end_source_message_id: null,
          projection_version: 0,
          source_eligible: true,
          source_fingerprint: "abc123",
        },
      ],
      targets: [],
    });
  });
});

describe("search and framework compatibility", () => {
  test("trims search queries and maps both upstream failure classes", async () => {
    const search = vi
      .fn<AppSearchService["search"]>()
      .mockResolvedValueOnce({ claims: [] })
      .mockRejectedValueOnce(new UpstreamResponseError("bad shape"))
      .mockRejectedValueOnce(new UpstreamRequestError("network"));
    const { app } = appWith(dependencies({ searchService: { search } }));

    const success = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: API_HEADERS,
      payload: { query: " query " },
    });
    const invalidResponse = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: API_HEADERS,
      payload: { query: "query" },
    });
    const requestFailure = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: API_HEADERS,
      payload: { query: "query" },
    });
    const empty = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: API_HEADERS,
      payload: { query: "   " },
    });

    expect(success.json()).toEqual({ claims: [] });
    expect(search).toHaveBeenNthCalledWith(1, "query");
    expect(invalidResponse.json()).toEqual({
      detail: "invalid upstream response",
    });
    expect(requestFailure.json()).toEqual({
      detail: "upstream request failed",
    });
    expect(empty.statusCode).toBe(422);
  });

  test("preserves trailing-slash redirects, method errors, and public docs paths", async () => {
    const { app } = appWith();

    const redirect = await app.inject({
      method: "GET",
      url: "/v1/jobs/1/?source=test",
    });
    const wrongMethod = await app.inject({
      method: "POST",
      url: "/v1/jobs/1",
    });
    const docs = await app.inject({ method: "GET", url: "/docs" });
    const redoc = await app.inject({ method: "GET", url: "/redoc" });

    expect(redirect.statusCode).toBe(307);
    expect(redirect.headers.location).toBe("/v1/jobs/1?source=test");
    expect(wrongMethod.statusCode).toBe(405);
    expect(wrongMethod.json()).toEqual({ detail: "Method Not Allowed" });
    expect(docs.statusCode).toBeGreaterThanOrEqual(200);
    expect(docs.statusCode).toBeLessThan(400);
    expect(redoc.statusCode).toBe(200);
    expect(redoc.body).toContain("/openapi.json");
  });
});
