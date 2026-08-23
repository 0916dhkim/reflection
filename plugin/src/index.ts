import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { tool, type Plugin } from "@opencode-ai/plugin";
import {
  parseSegmentResponse,
  parseSessionSegmentsResponse,
  type JobStatus,
  type SegmentCreate,
  type SegmentResponse,
  type SegmentSummary,
  type SessionSegmentsResponse,
} from "@reflection/shared/contracts";
import { segmentIdForRequest } from "@reflection/shared/domain";
import {
  PROJECTION_LOSS_WARNING,
  PROJECTION_LOSS_WARNING_METADATA,
  type CommittedSegmentBoundary,
  isNormalUserMessage,
  isSafeSegmentSnapshot,
  readSegmentMessages,
  segmentMessages,
  submissionSourceFingerprint,
  type OpenCodeMessage,
  type ReflectionSegment,
} from "@reflection/shared/segmentation";

import { requestSignal, safeErrorDetail } from "./http.js";
import {
  activeModel,
  projectMessages,
  type StoredSegmentSummary,
} from "./projection.js";
import { ProjectionStateStore } from "./projection-state.js";

const CONFIG_PATH = join(homedir(), ".config", "opencode", "reflection.json");
const PROJECTION_STATE_PATH = join(
  homedir(),
  ".local",
  "state",
  "reflection",
  "projection",
);
const INACTIVE_MS = 10 * 60 * 1000;
const PROJECTION_REQUEST_TIMEOUT_MS = 5_000;
const TARGET_POST_TIMEOUT_MS = 5_000;
const TARGET_WAIT_TIMEOUT_MS = 5_000;
const SUMMARY_WAIT_TIMEOUT_MS = 90_000;
const SUMMARY_POLL_INTERVAL_MS = 1_000;
const PROJECTION_VERSION = 1;
const DEFAULT_OUTPUT_TOKEN_MAX = 32_000;

interface ReflectionConfig {
  url: string;
  apiKey: string;
  contextProjection: boolean;
}

interface ApiResult {
  ok: boolean;
  status: number;
  data: unknown;
  detail: string;
}

type StoredSegment = SegmentResponse;

interface SegmentListing {
  summaries: StoredSegmentSummary[];
  boundaries: CommittedSegmentBoundary[];
  targets: Array<CommittedSegmentBoundary & { status: JobStatus }>;
}

function segmentAnchors(listing: SegmentListing): CommittedSegmentBoundary[] {
  return [...listing.boundaries, ...listing.targets];
}

interface ProviderListData {
  all: Array<{
    id: string;
    models: Record<
      string,
      { limit: { context: number; input?: number; output?: number } }
    >;
  }>;
}

interface ModelLimits {
  contextLimit: number;
  inputLimit?: number;
  outputLimit?: number;
}

interface TargetUpdateState {
  tail: Promise<void>;
  failure?: Error;
  failedSegmentKey?: string;
}

interface IdlePassState {
  promise: Promise<void>;
  dirty: boolean;
}

interface IngestionResult {
  messages: OpenCodeMessage[] | null;
  fresh: boolean;
  successfulSegmentKeys: string[];
  observedSegmentKeys?: string[];
}

interface PendingProjectionWarning {
  checkpointKey: string;
  agent: string;
  variant?: string;
  model: {
    providerID: string;
    modelID: string;
  };
}

interface RuntimePromptBody {
  agent: string;
  model: {
    providerID: string;
    modelID: string;
  };
  variant?: string;
  noReply: true;
  parts: [
    {
      type: "text";
      text: string;
      synthetic: false;
      ignored: false;
      metadata: typeof PROJECTION_LOSS_WARNING_METADATA;
    },
  ];
}

class SegmentSubmissionError extends Error {
  constructor(
    message: string,
    readonly segmentKey: string,
  ) {
    super(message);
    this.name = "SegmentSubmissionError";
  }
}

class SegmentListingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SegmentListingUnavailableError";
  }
}

function loadConfig(): ReflectionConfig | null {
  try {
    const value: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "url" in value &&
      typeof value.url === "string" &&
      value.url.length > 0 &&
      "apiKey" in value &&
      typeof value.apiKey === "string" &&
      value.apiKey.length > 0
    ) {
      const projection =
        "contextProjection" in value &&
        typeof value.contextProjection === "object" &&
        value.contextProjection !== null &&
        "enabled" in value.contextProjection &&
        value.contextProjection.enabled === true;
      return {
        url: value.url.replace(/\/$/, ""),
        apiKey: value.apiKey,
        contextProjection: projection,
      };
    }
  } catch {}
  return null;
}

async function apiCall(
  path: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<ApiResult> {
  const config = loadConfig();
  if (!config) {
    return {
      ok: false,
      status: 0,
      data: null,
      detail: `missing or invalid config at ${CONFIG_PATH}`,
    };
  }

  const request = requestSignal(init.signal, timeoutMs);
  try {
    const headers = new Headers(init.headers);
    headers.set("X-Api-Key", config.apiKey);
    const response = await fetch(`${config.url}${path}`, {
      ...init,
      headers,
      signal: request.signal,
    });
    const body = await response.text();
    let data: unknown = body;
    if (body.length > 0) {
      try {
        data = JSON.parse(body);
      } catch {}
    } else {
      data = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      data,
      detail: response.ok ? "" : safeErrorDetail(body, config.apiKey),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      detail: safeErrorDetail(String(error), config.apiKey),
    };
  } finally {
    request.dispose();
  }
}

function parseStoredSegment(data: unknown): StoredSegment | null {
  try {
    return parseSegmentResponse(data);
  } catch {
    return null;
  }
}

function submissionBody(
  sessionId: string,
  segment: ReflectionSegment,
  processingPriority: number,
): SegmentCreate {
  const common = {
    session_id: sessionId,
    start_user_message_id: segment.startUserMessageId,
    end_user_message_id: segment.endUserMessageId,
    projection_version: PROJECTION_VERSION as 1,
    processing_priority: processingPriority,
    messages: segment.messages,
  };
  if (segment.sourceBoundaryVersion === 1) {
    return {
      ...common,
      source_boundary_version: 1,
      start_source_message_id: null,
      end_source_message_id: null,
    };
  }
  if (
    segment.startSourceMessageId === null ||
    segment.endSourceMessageId === null
  ) {
    throw new Error("V2 segments require complete source boundaries");
  }
  return {
    ...common,
    source_boundary_version: 2,
    start_source_message_id: segment.startSourceMessageId,
    end_source_message_id: segment.endSourceMessageId,
  };
}

function toCommittedBoundary(
  value: SessionSegmentsResponse["boundaries"][number],
): CommittedSegmentBoundary {
  const common = {
    id: value.id,
    startUserMessageId: value.start_user_message_id,
    endUserMessageId: value.end_user_message_id,
    projectionVersion: value.projection_version,
    sourceEligible: value.source_eligible,
    sourceFingerprint: value.source_fingerprint ?? undefined,
  };
  return value.source_boundary_version === 1
    ? {
        ...common,
        sourceBoundaryVersion: 1,
        startSourceMessageId: null,
        endSourceMessageId: null,
      }
    : {
        ...common,
        sourceBoundaryVersion: 2,
        startSourceMessageId: value.start_source_message_id,
        endSourceMessageId: value.end_source_message_id,
      };
}

function toTargetBoundary(
  value: SessionSegmentsResponse["targets"][number],
): SegmentListing["targets"][number] {
  const common = {
    id: value.id,
    startUserMessageId: value.start_user_message_id,
    endUserMessageId: value.end_user_message_id,
    projectionVersion: value.projection_version,
    sourceEligible: false,
    sourceFingerprint: value.source_fingerprint,
    status: value.status,
  };
  return value.source_boundary_version === 1
    ? {
        ...common,
        sourceBoundaryVersion: 1,
        startSourceMessageId: null,
        endSourceMessageId: null,
      }
    : {
        ...common,
        sourceBoundaryVersion: 2,
        startSourceMessageId: value.start_source_message_id,
        endSourceMessageId: value.end_source_message_id,
      };
}

function parseSegmentListing(
  data: unknown,
  sessionId: string,
): SegmentListing | null {
  try {
    const parsed = parseSessionSegmentsResponse(data);
    if (parsed.session_id !== sessionId) return null;
    return {
      summaries: parsed.segments,
      boundaries: parsed.boundaries.map(toCommittedBoundary),
      targets: parsed.targets.map(toTargetBoundary),
    };
  } catch {
    return null;
  }
}

function formatData(data: unknown): string {
  return JSON.stringify(data, null, 2) ?? "null";
}

function formatApiFailure(operation: string, response: ApiResult): string {
  const detail = response.detail ? `: ${response.detail}` : "";
  return `${operation} failed (${response.status})${detail}`;
}

export const Reflection: Plugin = async ({ client, directory }) => {
  const initialConfig = loadConfig();
  const projectionEnabled = initialConfig?.contextProjection === true;
  const projectionState = new ProjectionStateStore(PROJECTION_STATE_PATH);
  const modelLimits = new Map<string, ModelLimits>();
  const compactingSessions = new Map<string, number>();
  const sessionGenerations = new Map<string, number>();
  const targetUpdates = new Map<string, TargetUpdateState>();
  const targetRevisions = new Map<string, number>();
  const targetUpdateAborts = new Map<string, Set<AbortController>>();
  const idlePasses = new Map<string, IdlePassState>();
  const successfulSegmentFingerprints = new Map<
    string,
    Map<string, { fingerprint: string; processingPriority: number }>
  >();
  const deletedSessions = new Set<string>();
  const pendingProjectionWarnings = new Map<string, PendingProjectionWarning>();
  const projectionWarningsInFlight = new Map<string, Promise<void>>();
  const synchronizeSuccessfulFingerprints = (
    sessionId: string,
    listing: SegmentListing,
  ): void => {
    const cached = successfulSegmentFingerprints.get(sessionId);
    if (!cached) return;
    const authoritative = new Map(
      [...listing.boundaries, ...listing.targets].flatMap((boundary) =>
        boundary.id && boundary.sourceFingerprint
          ? [[boundary.id, boundary.sourceFingerprint] as const]
          : [],
      ),
    );
    for (const [segmentId, submission] of cached) {
      const current = authoritative.get(segmentId);
      if (current !== undefined && current !== submission.fingerprint) {
        cached.delete(segmentId);
      }
    }
  };
  const log = async (message: string) => {
    try {
      await client.app.log({
        body: { service: "reflection", level: "warn", message },
      });
    } catch {
      console.error(message);
    }
  };

  const getSessionMessages = async (
    sessionId: string,
  ): Promise<OpenCodeMessage[]> => {
    const response = await client.session.messages({
      path: { id: sessionId },
      query: { directory },
      throwOnError: true,
    });
    if (!Array.isArray(response.data)) {
      throw new Error(`Reflection could not load messages for ${sessionId}`);
    }
    return response.data as OpenCodeMessage[];
  };

  const serializeTargetUpdate = (
    sessionId: string,
    operation: () => Promise<IngestionResult>,
  ): Promise<IngestionResult> => {
    targetRevisions.set(sessionId, (targetRevisions.get(sessionId) ?? 0) + 1);
    const state = targetUpdates.get(sessionId) ?? {
      tail: Promise.resolve(),
    };
    const current = state.tail.then(operation);
    const settled = current.then(
      (result) => {
        const failedBoundaryRemoved =
          state.failedSegmentKey !== undefined &&
          result.observedSegmentKeys !== undefined &&
          !result.observedSegmentKeys.includes(state.failedSegmentKey);
        const failedBoundarySucceeded =
          state.failedSegmentKey !== undefined &&
          result.successfulSegmentKeys.includes(state.failedSegmentKey);
        if (
          failedBoundaryRemoved ||
          failedBoundarySucceeded ||
          (state.failedSegmentKey === undefined && result.fresh)
        ) {
          state.failure = undefined;
          state.failedSegmentKey = undefined;
        }
      },
      (error: unknown) => {
        state.failure =
          error instanceof Error ? error : new Error(String(error));
        if (error instanceof SegmentSubmissionError) {
          state.failedSegmentKey = error.segmentKey;
        }
      },
    );
    state.tail = settled;
    targetUpdates.set(sessionId, state);
    void settled.then(() => {
      if (
        !state.failure &&
        targetUpdates.get(sessionId) === state &&
        state.tail === settled
      ) {
        targetUpdates.delete(sessionId);
      }
    });
    return current;
  };

  const submitSegments = async (
    sessionId: string,
    segments: readonly ReflectionSegment[],
    includeOpenSegment: boolean,
    processingPriority: number,
    messages: readonly OpenCodeMessage[] | null,
    signal: AbortSignal,
  ): Promise<string[]> => {
    const fingerprints =
      successfulSegmentFingerprints.get(sessionId) ??
      new Map<string, { fingerprint: string; processingPriority: number }>();
    successfulSegmentFingerprints.set(sessionId, fingerprints);
    const successful: string[] = [];
    for (const segment of segments) {
      if (!segment.closed && !includeOpenSegment) continue;
      if (!segment.closed && !isSafeSegmentSnapshot(segment, messages ?? [])) {
        continue;
      }
      const body = submissionBody(sessionId, segment, processingPriority);
      const segmentKey = segmentIdForRequest(body);
      const fingerprint = submissionSourceFingerprint(sessionId, segment);
      const previous = fingerprints.get(segmentKey);
      if (
        previous?.fingerprint === fingerprint &&
        previous.processingPriority >= processingPriority
      ) {
        successful.push(segmentKey);
        continue;
      }
      const response = await apiCall(
        "/v1/segments",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        },
        TARGET_POST_TIMEOUT_MS,
      );
      if (!response.ok) {
        const failure = formatApiFailure(
          `segment submission for ${sessionId}`,
          response,
        );
        await log(failure);
        if (!segment.closed) continue;
        throw new SegmentSubmissionError(failure, segmentKey);
      }
      fingerprints.set(segmentKey, { fingerprint, processingPriority });
      successful.push(segmentKey);
    }
    return successful;
  };

  const waitWithin = async (promise: Promise<void>, timeoutMs: number) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(`target updates timed out after ${timeoutMs}ms`),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const waitForTargetUpdates = async (
    sessionId: string,
    deadline = Date.now() + TARGET_WAIT_TIMEOUT_MS,
  ): Promise<void> => {
    while (true) {
      const state = targetUpdates.get(sessionId);
      const idle = idlePasses.get(sessionId);
      const dirtyIdle = idle?.dirty ? idle.promise : undefined;
      if (!state && !dirtyIdle) return;
      const observed = state?.tail;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `target updates timed out after ${TARGET_WAIT_TIMEOUT_MS}ms`,
        );
      }
      await waitWithin(
        Promise.all([observed, dirtyIdle].filter(Boolean)).then(() => {}),
        remaining,
      );
      if (dirtyIdle) continue;
      if (
        state &&
        targetUpdates.get(sessionId) === state &&
        observed === state.tail
      ) {
        if (state.failure) throw state.failure;
        return;
      }
    }
  };

  const insertPendingProjectionWarning = (sessionId: string): Promise<void> => {
    const pending = pendingProjectionWarnings.get(sessionId);
    if (!pending) return Promise.resolve();
    const existing = projectionWarningsInFlight.get(sessionId);
    if (existing) return existing;

    let insertion: Promise<void>;
    insertion = (async () => {
      try {
        const body: RuntimePromptBody = {
          agent: pending.agent,
          model: pending.model,
          ...(pending.variant === undefined
            ? {}
            : { variant: pending.variant }),
          noReply: true,
          parts: [
            {
              type: "text",
              text: PROJECTION_LOSS_WARNING,
              synthetic: false,
              ignored: false,
              metadata: {
                reflection: {
                  ...PROJECTION_LOSS_WARNING_METADATA.reflection,
                },
              },
            },
          ],
        };
        const response = await client.session.prompt({
          path: { id: sessionId },
          query: { directory },
          body,
          throwOnError: true,
        });
        if (
          response.data !== undefined &&
          !("error" in response) &&
          pendingProjectionWarnings.get(sessionId) === pending
        ) {
          pendingProjectionWarnings.delete(sessionId);
        }
      } catch {}
    })().finally(() => {
      if (projectionWarningsInFlight.get(sessionId) === insertion) {
        projectionWarningsInFlight.delete(sessionId);
      }
    });
    projectionWarningsInFlight.set(sessionId, insertion);
    return insertion;
  };

  const getModelLimits = async (
    providerId: string,
    modelId: string,
  ): Promise<ModelLimits> => {
    const key = `${providerId}/${modelId}`;
    const cached = modelLimits.get(key);
    if (cached) return cached;
    const response = await client.provider.list({ query: { directory } });
    const data = response.data as ProviderListData | undefined;
    const limit = data?.all.find((provider) => provider.id === providerId)
      ?.models[modelId]?.limit;
    if (!limit?.context || !Number.isFinite(limit.context)) {
      throw new Error(`Reflection could not resolve context limit for ${key}`);
    }
    const configuredOutputTokenMax = Number(
      process.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX,
    );
    const outputTokenMax =
      Number.isInteger(configuredOutputTokenMax) && configuredOutputTokenMax > 0
        ? configuredOutputTokenMax
        : DEFAULT_OUTPUT_TOKEN_MAX;
    const result = {
      contextLimit: limit.context,
      inputLimit: limit.input,
      outputLimit:
        Math.min(limit.output ?? 0, outputTokenMax) || outputTokenMax,
    };
    modelLimits.set(key, result);
    return result;
  };

  const getSegmentListing = async (
    sessionId: string,
  ): Promise<SegmentListing> => {
    const response = await apiCall(
      `/v1/sessions/${encodeURIComponent(sessionId)}/segments`,
      { method: "GET" },
      PROJECTION_REQUEST_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new SegmentListingUnavailableError(
        formatApiFailure("context projection", response),
      );
    }
    const listing = parseSegmentListing(response.data, sessionId);
    if (!listing) {
      throw new Error("context projection failed: invalid segment summaries");
    }
    synchronizeSuccessfulFingerprints(sessionId, listing);
    return listing;
  };

  const getFreshSegmentListing = async (
    sessionId: string,
    deadline = Date.now() + TARGET_WAIT_TIMEOUT_MS,
  ): Promise<SegmentListing> => {
    while (true) {
      await waitForTargetUpdates(sessionId, deadline);
      const revision = targetRevisions.get(sessionId) ?? 0;
      const listing = await getSegmentListing(sessionId);
      await waitForTargetUpdates(sessionId, deadline);
      if ((targetRevisions.get(sessionId) ?? 0) === revision) return listing;
      if (Date.now() >= deadline) {
        throw new Error(
          `target updates timed out after ${TARGET_WAIT_TIMEOUT_MS}ms`,
        );
      }
    }
  };

  const exactSummaryForSegment = (
    sessionId: string,
    summaries: readonly SegmentSummary[],
    segment: ReflectionSegment,
  ): SegmentSummary | undefined => {
    const body = submissionBody(sessionId, segment, 100);
    const segmentId = segmentIdForRequest(body);
    return summaries.find(
      (summary) =>
        summary.id === segmentId &&
        summary.start_user_message_id === body.start_user_message_id &&
        summary.end_user_message_id === body.end_user_message_id &&
        summary.source_boundary_version === body.source_boundary_version &&
        summary.start_source_message_id === body.start_source_message_id &&
        summary.end_source_message_id === body.end_source_message_id,
    );
  };

  const hasPendingExactTarget = (
    sessionId: string,
    listing: SegmentListing,
    segment: ReflectionSegment,
  ): boolean => {
    const body = submissionBody(sessionId, segment, 100);
    const segmentId = segmentIdForRequest(body);
    const fingerprint = submissionSourceFingerprint(sessionId, segment);
    return listing.targets.some(
      (target) =>
        target.id === segmentId &&
        target.status !== "failed" &&
        target.status !== "succeeded" &&
        target.startUserMessageId === body.start_user_message_id &&
        target.endUserMessageId === body.end_user_message_id &&
        target.sourceBoundaryVersion === body.source_boundary_version &&
        target.startSourceMessageId === body.start_source_message_id &&
        target.endSourceMessageId === body.end_source_message_id &&
        target.sourceFingerprint === fingerprint,
    );
  };

  const waitForRequiredSummaries = async (
    sessionId: string,
    requiredSegments: readonly ReflectionSegment[],
    deadline = Date.now() + SUMMARY_WAIT_TIMEOUT_MS,
  ): Promise<readonly StoredSegmentSummary[]> => {
    while (true) {
      const listing = await getFreshSegmentListing(sessionId, deadline);
      const missing = requiredSegments.filter(
        (segment) =>
          exactSummaryForSegment(sessionId, listing.summaries, segment) ===
          undefined,
      );
      if (missing.length === 0) return listing.summaries;
      if (
        !missing.some((segment) =>
          hasPendingExactTarget(sessionId, listing, segment),
        )
      ) {
        return listing.summaries;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `segment summaries timed out after ${SUMMARY_WAIT_TIMEOUT_MS}ms`,
        );
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(SUMMARY_POLL_INTERVAL_MS, remaining)),
      );
    }
  };

  const isSessionIdle = async (sessionId: string): Promise<boolean> => {
    const response = await client.session.status({
      query: { directory },
      throwOnError: true,
    });
    const statuses = response.data as
      | Record<string, { type?: string }>
      | undefined;
    const status = statuses?.[sessionId];
    return status === undefined || status.type === "idle";
  };

  const captureIdleMessages = async (
    sessionId: string,
  ): Promise<OpenCodeMessage[] | null> => {
    if (!(await isSessionIdle(sessionId))) return null;
    const messages = await getSessionMessages(sessionId);
    if (!(await isSessionIdle(sessionId))) return null;
    return messages;
  };

  const isStillInactive = async (sessionId: string): Promise<boolean> => {
    try {
      const response = await client.session.get({
        path: { id: sessionId },
        query: { directory },
      });
      const updated = response.data?.time.updated;
      return typeof updated === "number" && updated < Date.now() - INACTIVE_MS;
    } catch {
      return false;
    }
  };

  const submitSegmentSnapshot = async (
    sessionId: string,
    segments: readonly ReflectionSegment[],
    includeOpenSegment: boolean,
    processingPriority: number,
    generation: number,
    messages: OpenCodeMessage[] | null,
  ): Promise<IngestionResult> => {
    if (
      deletedSessions.has(sessionId) ||
      (sessionGenerations.get(sessionId) ?? 0) !== generation
    ) {
      return { messages: null, fresh: false, successfulSegmentKeys: [] };
    }
    const controller = new AbortController();
    const controllers = targetUpdateAborts.get(sessionId) ?? new Set();
    controllers.add(controller);
    targetUpdateAborts.set(sessionId, controllers);
    try {
      const successfulSegmentKeys = await submitSegments(
        sessionId,
        segments,
        includeOpenSegment,
        processingPriority,
        messages,
        controller.signal,
      );
      if (
        deletedSessions.has(sessionId) ||
        (sessionGenerations.get(sessionId) ?? 0) !== generation
      ) {
        return { messages: null, fresh: false, successfulSegmentKeys: [] };
      }
      return {
        messages,
        fresh: successfulSegmentKeys.length > 0,
        successfulSegmentKeys,
        observedSegmentKeys: segments.map((segment) =>
          segmentIdForRequest(
            submissionBody(sessionId, segment, processingPriority),
          ),
        ),
      };
    } finally {
      controllers.delete(controller);
      if (
        controllers.size === 0 &&
        targetUpdateAborts.get(sessionId) === controllers
      ) {
        targetUpdateAborts.delete(sessionId);
      }
    }
  };

  const enqueueClosedTargetSync = (
    sessionId: string,
    segments: readonly ReflectionSegment[],
    generation: number,
  ): Promise<IngestionResult> =>
    serializeTargetUpdate(sessionId, () =>
      submitSegmentSnapshot(sessionId, segments, false, 100, generation, null),
    );

  const ingestIdleSession = async (
    sessionId: string,
    revalidateInactiveOpen = false,
  ): Promise<IngestionResult> => {
    if (deletedSessions.has(sessionId)) {
      return { messages: null, fresh: false, successfulSegmentKeys: [] };
    }
    const generation = sessionGenerations.get(sessionId) ?? 0;
    return serializeTargetUpdate(sessionId, async () => {
      if (deletedSessions.has(sessionId)) {
        return { messages: null, fresh: false, successfulSegmentKeys: [] };
      }
      if ((sessionGenerations.get(sessionId) ?? 0) !== generation) {
        return { messages: null, fresh: false, successfulSegmentKeys: [] };
      }
      const messages = await captureIdleMessages(sessionId);
      if (!messages) {
        return { messages: null, fresh: false, successfulSegmentKeys: [] };
      }
      if ((sessionGenerations.get(sessionId) ?? 0) !== generation) {
        return { messages: null, fresh: false, successfulSegmentKeys: [] };
      }
      const listing = await getSegmentListing(sessionId);
      const segments = segmentMessages(
        messages,
        undefined,
        segmentAnchors(listing),
      );
      const includeOpenSegment =
        revalidateInactiveOpen && (await isStillInactive(sessionId));
      return submitSegmentSnapshot(
        sessionId,
        segments,
        includeOpenSegment,
        0,
        generation,
        messages,
      );
    });
  };

  const finishIdle = async (sessionId: string): Promise<void> => {
    const response = await client.session.list({ query: { directory } });
    const cutoff = Date.now() - INACTIVE_MS;
    for (const session of response.data ?? []) {
      if (
        session.id === sessionId ||
        deletedSessions.has(session.id) ||
        session.time.updated >= cutoff
      ) {
        continue;
      }
      await ingestIdleSession(session.id, true);
    }
  };

  const runIdle = (sessionId: string): Promise<void> => {
    if (deletedSessions.has(sessionId)) return Promise.resolve();
    const existing = idlePasses.get(sessionId);
    if (existing) {
      existing.dirty = true;
      return existing.promise;
    }
    const state: IdlePassState = {
      promise: Promise.resolve(),
      dirty: false,
    };
    state.promise = (async () => {
      let shouldFinish = false;
      do {
        state.dirty = false;
        try {
          const result = await ingestIdleSession(sessionId);
          shouldFinish ||= result.messages !== null;
        } catch (error) {
          await log(`idle ingestion failed: ${String(error)}`);
        }
        if (state.dirty) continue;
        if (shouldFinish) {
          shouldFinish = false;
          try {
            await finishIdle(sessionId);
          } catch (error) {
            await log(`idle hook failed: ${String(error)}`);
          }
        }
      } while (state.dirty && !deletedSessions.has(sessionId));
      if (idlePasses.get(sessionId) === state) idlePasses.delete(sessionId);
    })()
      .catch(async (error) => {
        await log(`idle hook failed: ${String(error)}`);
      })
      .finally(() => {
        if (idlePasses.get(sessionId) === state) idlePasses.delete(sessionId);
      });
    idlePasses.set(sessionId, state);
    return state.promise;
  };

  return {
    config: async (config) => {
      if (!projectionEnabled) return;
      const mutable = config as typeof config & {
        compaction?: { auto?: boolean; [key: string]: unknown };
      };
      mutable.compaction = { ...mutable.compaction, auto: false };
    },

    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        const sessionId = event.properties.info.id;
        deletedSessions.add(sessionId);
        sessionGenerations.set(
          sessionId,
          (sessionGenerations.get(sessionId) ?? 0) + 1,
        );
        compactingSessions.delete(sessionId);
        for (const controller of targetUpdateAborts.get(sessionId) ?? []) {
          controller.abort(
            new Error(`Reflection session ${sessionId} was deleted`),
          );
        }
        targetUpdateAborts.delete(sessionId);
        targetUpdates.delete(sessionId);
        targetRevisions.delete(sessionId);
        idlePasses.delete(sessionId);
        successfulSegmentFingerprints.delete(sessionId);
        pendingProjectionWarnings.delete(sessionId);
        projectionWarningsInFlight.delete(sessionId);
        projectionState.delete(sessionId);
        return;
      }
      const sessionId =
        event.type === "session.idle"
          ? event.properties.sessionID
          : event.type === "session.status" &&
              event.properties.status.type === "idle"
            ? event.properties.sessionID
            : null;
      if (!sessionId) return;
      await insertPendingProjectionWarning(sessionId);
      await runIdle(sessionId);
    },

    "experimental.session.compacting": async ({ sessionID }) => {
      if (projectionEnabled) {
        compactingSessions.set(sessionID, Date.now() + 60_000);
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      if (!projectionEnabled || output.messages.length === 0) return;
      const messages = output.messages as OpenCodeMessage[];
      const model = activeModel(messages);
      if (!model) {
        throw new Error(
          "Reflection context projection could not identify the active session model",
        );
      }
      const activeUser = [...messages].reverse().find(isNormalUserMessage);
      if (deletedSessions.has(model.sessionId)) {
        throw new Error(
          `Reflection session ${model.sessionId} was deleted before context projection`,
        );
      }
      const compactionDeadline = compactingSessions.get(model.sessionId);
      if (compactionDeadline !== undefined) {
        compactingSessions.delete(model.sessionId);
        if (compactionDeadline >= Date.now()) return;
      }
      const generation = sessionGenerations.get(model.sessionId) ?? 0;
      try {
        const previous = projectionState.get(model.sessionId);
        const limits = await getModelLimits(model.providerId, model.modelId);
        let initialListing: Promise<SegmentListing | null> | undefined;
        const listing = () =>
          (initialListing ??= getSegmentListing(model.sessionId).catch(
            (error: unknown) => {
              if (error instanceof SegmentListingUnavailableError) return null;
              throw error;
            },
          ));
        let rawSnapshot: Promise<OpenCodeMessage[]> | undefined;
        const rawMessages = () =>
          (rawSnapshot ??= getSessionMessages(model.sessionId));
        let canonicalPlan: Promise<readonly ReflectionSegment[]> | undefined;
        const loadCanonicalPlan = () =>
          (canonicalPlan ??= Promise.all([rawMessages(), listing()]).then(
            ([raw, current]) =>
              segmentMessages(
                raw,
                undefined,
                current ? segmentAnchors(current) : [],
              ),
          ));
        let foregroundSync: Promise<IngestionResult> | undefined;
        const result = await projectMessages({
          messages,
          ...limits,
          previous,
          loadCanonicalSegments: loadCanonicalPlan,
          loadSummaries: async (requiredSegments) => {
            const current = await listing();
            if (!current) {
              throw new SegmentListingUnavailableError(
                "context projection failed: segment manifest unavailable",
              );
            }
            const deadline = Date.now() + SUMMARY_WAIT_TIMEOUT_MS;
            const plan = await loadCanonicalPlan();
            foregroundSync ??= enqueueClosedTargetSync(
              model.sessionId,
              plan,
              generation,
            );
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              throw new Error(
                `segment summaries timed out after ${SUMMARY_WAIT_TIMEOUT_MS}ms`,
              );
            }
            await waitWithin(
              foregroundSync.then(() => {}),
              remaining,
            );
            return waitForRequiredSummaries(
              model.sessionId,
              requiredSegments,
              deadline,
            );
          },
        });
        if (
          deletedSessions.has(model.sessionId) ||
          (sessionGenerations.get(model.sessionId) ?? 0) !== generation
        ) {
          throw new Error(
            `Reflection session ${model.sessionId} was deleted during context projection`,
          );
        }
        if (JSON.stringify(previous) !== JSON.stringify(result.state)) {
          projectionState.set(model.sessionId, result.state);
        }
        output.messages.splice(
          0,
          output.messages.length,
          ...(result.messages as typeof output.messages),
        );
        if (result.reset) {
          if (result.diagnostic?.lossy) {
            const agent = activeUser?.info.agent;
            const variant = activeUser?.info.model?.variant;
            const checkpoint = result.state.checkpoint;
            if (typeof agent === "string" && checkpoint) {
              const checkpointKey = `${checkpoint.tailStartMessageId}:${checkpoint.createdAtMessageId}`;
              if (
                pendingProjectionWarnings.get(model.sessionId)
                  ?.checkpointKey !== checkpointKey
              ) {
                pendingProjectionWarnings.set(model.sessionId, {
                  checkpointKey,
                  agent,
                  ...(typeof variant === "string" ? { variant } : {}),
                  model: {
                    providerID: model.providerId,
                    modelID: model.modelId,
                  },
                });
              }
            } else {
              await log(
                `projection warning not queued for ${model.sessionId}: active agent unavailable`,
              );
            }
          }
          try {
            await client.app.log({
              body: {
                service: "reflection",
                level: "info",
                message: "context projection reset",
                extra: {
                  ...result.diagnostic,
                  estimatedTokens: result.estimatedTokens,
                  thresholdTokens: result.thresholdTokens,
                  hardLimitTokens: result.hardLimitTokens,
                  contextLimit: limits.contextLimit,
                },
              },
            });
          } catch {}
        }
      } catch (error) {
        await log(`context projection failed: ${String(error)}`);
        throw error;
      }
    },

    tool: {
      memory_search: tool({
        description:
          "Search Reflection memory. Returns structured claims and the source segment IDs that support them.",
        args: {
          query: tool.schema
            .string()
            .min(1)
            .describe("What to recall from prior OpenCode sessions"),
        },
        async execute({ query }, context) {
          const response = await apiCall("/v1/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query }),
            signal: context.abort,
          });
          if (!response.ok) return formatApiFailure("memory_search", response);
          return formatData(response.data);
        },
      }),

      memory_read_segment: tool({
        description:
          "Read the original ordered user and assistant text for a Reflection source segment.",
        args: {
          segment_id: tool.schema
            .string()
            .min(1)
            .describe("Reflection source segment ID"),
        },
        async execute({ segment_id }, context) {
          const response = await apiCall(
            `/v1/segments/${encodeURIComponent(segment_id)}`,
            {
              method: "GET",
              signal: context.abort,
            },
          );
          if (!response.ok)
            return formatApiFailure("memory_read_segment", response);

          const segment = parseStoredSegment(response.data);
          if (!segment || segment.id !== segment_id)
            return "memory_read_segment failed: invalid segment metadata";

          try {
            const boundary: CommittedSegmentBoundary =
              segment.source_boundary_version === 1
                ? {
                    id: segment.id,
                    startUserMessageId: segment.start_user_message_id,
                    endUserMessageId: segment.end_user_message_id,
                    sourceBoundaryVersion: 1,
                    startSourceMessageId: null,
                    endSourceMessageId: null,
                  }
                : {
                    id: segment.id,
                    startUserMessageId: segment.start_user_message_id,
                    endUserMessageId: segment.end_user_message_id,
                    sourceBoundaryVersion: 2,
                    startSourceMessageId: segment.start_source_message_id,
                    endSourceMessageId: segment.end_source_message_id,
                  };
            const messages = readSegmentMessages(
              await getSessionMessages(segment.session_id),
              boundary,
            );
            return formatData({
              segment_id,
              session_id: segment.session_id,
              start_user_message_id: segment.start_user_message_id,
              end_user_message_id: segment.end_user_message_id,
              source_boundary_version: segment.source_boundary_version,
              start_source_message_id: segment.start_source_message_id,
              end_source_message_id: segment.end_source_message_id,
              messages,
            });
          } catch (error) {
            return `memory_read_segment failed: ${String(error)}`;
          }
        },
      }),
    },
  };
};

export default Reflection;
