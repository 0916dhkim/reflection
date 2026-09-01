import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { tool, type Plugin } from "@opencode-ai/plugin";
import {
  parseSegmentResponse,
  parseJobResponse,
  parseSegmentCreate,
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
  type CommittedSegmentBoundary,
  isSafeSegmentSnapshot,
  readSegmentMessages,
  segmentMessages,
  submissionSourceFingerprint,
  type OpenCodeMessage,
  type ReflectionSegment,
} from "@reflection/shared/segmentation";

import {
  boundedErrorText,
  combineAbortSignals,
  requestSignal,
  safeErrorDetail,
} from "./http.js";
import {
  activeModel,
  isNewUserTurn,
  latestUserMessage,
  projectMessages,
  projectionSourcesFingerprint,
  projectionSummaryFingerprint,
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
const MAX_INACTIVE_SESSIONS_PER_SWEEP = 20;
const INACTIVE_SESSION_RECHECK_MS = 10 * 60_000;
const SDK_REQUEST_TIMEOUT_MS = 30_000;
const INACTIVE_SWEEP_TIMEOUT_MS = 60_000;
const PROJECTION_REQUEST_TIMEOUT_MS = 5_000;
const TARGET_POST_TIMEOUT_MS = 5_000;
const TARGET_WAIT_TIMEOUT_MS = 5_000;
const PROJECTION_VERSION = 1;
const DEFAULT_OUTPUT_TOKEN_MAX = 32_000;
const BACKGROUND_PROCESSING_PRIORITY = 0;
const ACTIVE_IDLE_PROCESSING_PRIORITY = 50;
const FOREGROUND_PROCESSING_PRIORITY = 100;

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
    const body = response.ok
      ? await response.text()
      : await boundedErrorText(response);
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
    if (init.signal?.aborted) {
      throw init.signal.reason ?? error;
    }
    return {
      ok: false,
      status: 0,
      data: null,
      detail: safeErrorDetail(
        String(request.signal.aborted ? request.signal.reason : error),
        config.apiKey,
      ),
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
    projection_version: (segment.projectionVersion ?? PROJECTION_VERSION) as
      | 1
      | 2,
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

async function waitForDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export const Reflection: Plugin = async ({ client, directory }) => {
  const initialConfig = loadConfig();
  const projectionEnabled = initialConfig?.contextProjection === true;
  const projectionState = new ProjectionStateStore(PROJECTION_STATE_PATH);
  const modelLimits = new Map<string, ModelLimits>();
  const compactingSessions = new Map<string, number>();
  const sessionGenerations = new Map<string, number>();
  const targetUpdates = new Map<string, TargetUpdateState>();
  const targetUpdateAborts = new Map<string, Set<AbortController>>();
  const automaticRetries = new Map<string, Map<string, string>>();
  const lifecycleAbort = new AbortController();
  const activeProjections = new Set<Promise<void>>();
  const registerSessionOperation = (
    sessionId: string,
    parentSignal: AbortSignal = lifecycleAbort.signal,
  ) => {
    const controller = new AbortController();
    const controllers = targetUpdateAborts.get(sessionId) ?? new Set();
    controllers.add(controller);
    targetUpdateAborts.set(sessionId, controllers);
    const combined = combineAbortSignals([controller.signal, parentSignal]);
    return {
      signal: combined.signal,
      dispose() {
        combined.dispose();
        controllers.delete(controller);
        if (
          controllers.size === 0 &&
          targetUpdateAborts.get(sessionId) === controllers
        ) {
          targetUpdateAborts.delete(sessionId);
        }
      },
    };
  };
  const idlePasses = new Map<string, IdlePassState>();
  const inactiveSessionChecks = new Map<
    string,
    { revision: number; checkedAt: number }
  >();
  let inactiveSweepCursor = 0;
  let inactiveSweep: Promise<void> | null = null;
  let pendingInactiveSweepSessionId: string | null = null;
  const successfulSegmentFingerprints = new Map<
    string,
    Map<string, { fingerprint: string; processingPriority: number }>
  >();
  const deletedSessions = new Set<string>();
  const sessionTurnValidations = new Map<
    string,
    {
      latestUserMessageId: string;
      tailStartMessageId: string;
      archivedPrefixFingerprint: string;
      canonicalSourceFingerprint: string;
    }
  >();
  const synchronizeSuccessfulFingerprints = (
    sessionId: string,
    listing: SegmentListing,
  ): void => {
    const cached = successfulSegmentFingerprints.get(sessionId);
    if (!cached) return;
    const authoritative = new Map<
      string,
      { fingerprint: string; terminalFailure: boolean }
    >();
    for (const boundary of listing.boundaries) {
      if (boundary.id && boundary.sourceFingerprint) {
        authoritative.set(boundary.id, {
          fingerprint: boundary.sourceFingerprint,
          terminalFailure: false,
        });
      }
    }
    for (const target of listing.targets) {
      if (target.id && target.sourceFingerprint) {
        authoritative.set(target.id, {
          fingerprint: target.sourceFingerprint,
          terminalFailure:
            target.status === "failed" || target.status === "superseded",
        });
      }
    }
    for (const [segmentId, submission] of cached) {
      const current = authoritative.get(segmentId);
      if (
        current !== undefined &&
        (current.fingerprint !== submission.fingerprint ||
          current.terminalFailure)
      ) {
        cached.delete(segmentId);
      }
    }
  };
  const log = async (message: string) => {
    const request = requestSignal(
      lifecycleAbort.signal,
      SDK_REQUEST_TIMEOUT_MS,
    );
    try {
      await client.app.log({
        body: { service: "reflection", level: "warn", message },
        signal: request.signal,
      });
    } catch {
      if (request.signal.aborted) return;
      console.error(message);
    } finally {
      request.dispose();
    }
  };

  const getSessionMessages = async (
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeMessage[]> => {
    const request = requestSignal(signal, SDK_REQUEST_TIMEOUT_MS);
    try {
      const response = await client.session.messages({
        path: { id: sessionId },
        query: { directory },
        signal: request.signal,
        throwOnError: true,
      });
      if (!Array.isArray(response.data)) {
        throw new Error(`Reflection could not load messages for ${sessionId}`);
      }
      return response.data as OpenCodeMessage[];
    } finally {
      request.dispose();
    }
  };

  const serializeTargetUpdate = (
    sessionId: string,
    operation: () => Promise<IngestionResult>,
  ): Promise<IngestionResult> => {
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
      const rawBody = submissionBody(sessionId, segment, processingPriority);
      const segmentKey = segmentIdForRequest(rawBody);
      const fingerprint = submissionSourceFingerprint(sessionId, segment);
      const fail = async (failure: string): Promise<void> => {
        await log(failure);
        if (segment.closed) {
          throw new SegmentSubmissionError(failure, segmentKey);
        }
      };
      let body: SegmentCreate;
      try {
        body = parseSegmentCreate(rawBody);
      } catch (error) {
        await fail(
          `segment submission for ${sessionId} failed local validation: ${String(error)}`,
        );
        continue;
      }
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
        await fail(failure);
        continue;
      }
      let job;
      try {
        job = parseJobResponse(response.data);
      } catch (error) {
        await fail(
          `segment submission for ${sessionId} returned an invalid job: ${String(error)}`,
        );
        continue;
      }
      if (
        job.segment_id !== segmentKey ||
        job.source_fingerprint !== fingerprint
      ) {
        await fail(
          `segment submission for ${sessionId} returned a mismatched job`,
        );
        continue;
      }
      if (job.status === "failed") {
        const sessionRetries = automaticRetries.get(sessionId) ?? new Map();
        automaticRetries.set(sessionId, sessionRetries);
        if (sessionRetries.get(segmentKey) === fingerprint) {
          await fail(
            `segment submission for ${sessionId} remained failed after its automatic retry`,
          );
          continue;
        }
        sessionRetries.set(segmentKey, fingerprint);
        const retry = await apiCall(
          `/v1/jobs/${job.id}/retry`,
          { method: "POST", signal },
          TARGET_POST_TIMEOUT_MS,
        );
        if (!retry.ok) {
          await fail(formatApiFailure(`segment retry for ${sessionId}`, retry));
          continue;
        }
        try {
          job = parseJobResponse(retry.data);
        } catch (error) {
          await fail(
            `segment retry for ${sessionId} returned an invalid job: ${String(error)}`,
          );
          continue;
        }
      }
      if (
        job.segment_id !== segmentKey ||
        job.source_fingerprint !== fingerprint
      ) {
        await fail(`segment retry for ${sessionId} returned a mismatched job`);
        continue;
      }
      if (job.status === "failed" || job.status === "superseded") {
        await fail(
          `segment submission for ${sessionId} ended as ${job.status}`,
        );
        continue;
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

  const getModelLimits = async (
    providerId: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<ModelLimits> => {
    const key = `${providerId}/${modelId}`;
    const cached = modelLimits.get(key);
    if (cached) return cached;
    const request = requestSignal(signal, SDK_REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await client.provider.list({
        query: { directory },
        signal: request.signal,
        throwOnError: true,
      });
    } finally {
      request.dispose();
    }
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
    signal?: AbortSignal,
    timeoutMs = PROJECTION_REQUEST_TIMEOUT_MS,
  ): Promise<SegmentListing> => {
    const response = await apiCall(
      `/v1/sessions/${encodeURIComponent(sessionId)}/segments`,
      { method: "GET", signal },
      timeoutMs,
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

  const isSessionIdle = async (
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const request = requestSignal(signal, SDK_REQUEST_TIMEOUT_MS);
    try {
      const response = await client.session.status({
        query: { directory },
        signal: request.signal,
        throwOnError: true,
      });
      const statuses = response.data as
        | Record<string, { type?: string }>
        | undefined;
      const status = statuses?.[sessionId];
      return status === undefined || status.type === "idle";
    } finally {
      request.dispose();
    }
  };

  const captureIdleMessages = async (
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeMessage[] | null> => {
    if (!(await isSessionIdle(sessionId, signal))) return null;
    const messages = await getSessionMessages(sessionId, signal);
    if (!(await isSessionIdle(sessionId, signal))) return null;
    return messages;
  };

  const isStillInactive = async (
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const request = requestSignal(signal, SDK_REQUEST_TIMEOUT_MS);
    try {
      const response = await client.session.get({
        path: { id: sessionId },
        query: { directory },
        signal: request.signal,
      });
      const updated = response.data?.time.updated;
      return typeof updated === "number" && updated < Date.now() - INACTIVE_MS;
    } catch {
      return false;
    } finally {
      request.dispose();
    }
  };

  const submitSegmentSnapshot = async (
    sessionId: string,
    segments: readonly ReflectionSegment[],
    includeOpenSegment: boolean,
    processingPriority: number,
    generation: number,
    messages: OpenCodeMessage[] | null,
    parentSignal: AbortSignal = lifecycleAbort.signal,
  ): Promise<IngestionResult> => {
    if (
      deletedSessions.has(sessionId) ||
      (sessionGenerations.get(sessionId) ?? 0) !== generation
    ) {
      return { messages: null, fresh: false, successfulSegmentKeys: [] };
    }
    const operation = registerSessionOperation(sessionId, parentSignal);
    try {
      const successfulSegmentKeys = await submitSegments(
        sessionId,
        segments,
        includeOpenSegment,
        processingPriority,
        messages,
        operation.signal,
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
      operation.dispose();
    }
  };

  const enqueueClosedTargetSync = (
    sessionId: string,
    segments: readonly ReflectionSegment[],
    generation: number,
    parentSignal: AbortSignal = lifecycleAbort.signal,
  ): Promise<IngestionResult> =>
    serializeTargetUpdate(sessionId, () =>
      submitSegmentSnapshot(
        sessionId,
        segments,
        false,
        FOREGROUND_PROCESSING_PRIORITY,
        generation,
        null,
        parentSignal,
      ),
    );

  const ingestIdleSession = async (
    sessionId: string,
    processingPriority: number,
    revalidateInactiveOpen = false,
    parentSignal: AbortSignal = lifecycleAbort.signal,
  ): Promise<IngestionResult> => {
    if (deletedSessions.has(sessionId)) {
      return { messages: null, fresh: false, successfulSegmentKeys: [] };
    }
    const generation = sessionGenerations.get(sessionId) ?? 0;
    const operation = registerSessionOperation(sessionId, parentSignal);
    try {
      return await serializeTargetUpdate(sessionId, async () => {
        if (deletedSessions.has(sessionId)) {
          return { messages: null, fresh: false, successfulSegmentKeys: [] };
        }
        if ((sessionGenerations.get(sessionId) ?? 0) !== generation) {
          return { messages: null, fresh: false, successfulSegmentKeys: [] };
        }
        const messages = await captureIdleMessages(sessionId, operation.signal);
        if (!messages) {
          return { messages: null, fresh: false, successfulSegmentKeys: [] };
        }
        if ((sessionGenerations.get(sessionId) ?? 0) !== generation) {
          return { messages: null, fresh: false, successfulSegmentKeys: [] };
        }
        const listing = await getSegmentListing(sessionId, operation.signal);
        const segments = segmentMessages(
          messages,
          undefined,
          segmentAnchors(listing),
        );
        const includeOpenSegment =
          revalidateInactiveOpen &&
          (await isStillInactive(sessionId, operation.signal));
        return submitSegmentSnapshot(
          sessionId,
          segments,
          includeOpenSegment,
          processingPriority,
          generation,
          messages,
          operation.signal,
        );
      });
    } finally {
      operation.dispose();
    }
  };

  const sweepInactiveSessions = async (
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const request = requestSignal(signal, SDK_REQUEST_TIMEOUT_MS);
    let sessions: Array<{ id: string; time: { updated: number } }> = [];
    try {
      const response = await client.session.list({
        query: { directory },
        signal: request.signal,
        throwOnError: true,
      });
      sessions = response.data ?? [];
    } finally {
      request.dispose();
    }
    const cutoff = Date.now() - INACTIVE_MS;
    const candidates = sessions.filter(
      (candidate) =>
        candidate.id !== sessionId &&
        !deletedSessions.has(candidate.id) &&
        candidate.time.updated < cutoff,
    );
    if (candidates.length === 0) return;
    const limit = Math.min(MAX_INACTIVE_SESSIONS_PER_SWEEP, candidates.length);
    const start = inactiveSweepCursor % candidates.length;
    inactiveSweepCursor = (start + limit) % candidates.length;
    for (let offset = 0; offset < limit; offset += 1) {
      const candidate = candidates[(start + offset) % candidates.length]!;
      const cached = inactiveSessionChecks.get(candidate.id);
      if (
        cached?.revision === candidate.time.updated &&
        Date.now() - cached.checkedAt < INACTIVE_SESSION_RECHECK_MS
      ) {
        continue;
      }
      try {
        const result = await ingestIdleSession(
          candidate.id,
          BACKGROUND_PROCESSING_PRIORITY,
          true,
          signal,
        );
        if (
          result.messages === null ||
          result.observedSegmentKeys?.every((key) =>
            result.successfulSegmentKeys.includes(key),
          )
        ) {
          inactiveSessionChecks.set(candidate.id, {
            revision: candidate.time.updated,
            checkedAt: Date.now(),
          });
        }
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        await log(
          `Reflection inactive-session ingestion failed for ${candidate.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  const finishIdle = (sessionId: string): void => {
    if (inactiveSweep) {
      pendingInactiveSweepSessionId = sessionId;
      return;
    }
    const request = requestSignal(
      lifecycleAbort.signal,
      INACTIVE_SWEEP_TIMEOUT_MS,
    );
    const sweep = sweepInactiveSessions(sessionId, request.signal)
      .catch((error) => {
        if (lifecycleAbort.signal.aborted) return;
        return log(
          `Reflection inactive-session sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(request.dispose);
    inactiveSweep = sweep;
    void sweep.then(() => {
      if (inactiveSweep !== sweep) return;
      inactiveSweep = null;
      const pending = pendingInactiveSweepSessionId;
      pendingInactiveSweepSessionId = null;
      if (pending) finishIdle(pending);
    });
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
          const result = await ingestIdleSession(
            sessionId,
            ACTIVE_IDLE_PROCESSING_PRIORITY,
          );
          shouldFinish ||= result.messages !== null;
        } catch (error) {
          if (lifecycleAbort.signal.aborted || deletedSessions.has(sessionId)) {
            return;
          }
          await log(`idle ingestion failed: ${String(error)}`);
        }
        if (state.dirty) continue;
        if (shouldFinish) {
          shouldFinish = false;
          finishIdle(sessionId);
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
    dispose: async () => {
      lifecycleAbort.abort(new Error("Reflection plugin disposed"));
      for (const controllers of targetUpdateAborts.values()) {
        for (const controller of controllers) {
          controller.abort(new Error("Reflection plugin disposed"));
        }
      }
      const pending = [
        inactiveSweep,
        ...[...idlePasses.values()].map((state) => state.promise),
        ...[...targetUpdates.values()].map((state) => state.tail),
        ...activeProjections,
      ].filter((value): value is Promise<void> => value !== null);
      await Promise.allSettled(pending);
    },

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
        idlePasses.delete(sessionId);
        successfulSegmentFingerprints.delete(sessionId);
        automaticRetries.delete(sessionId);
        inactiveSessionChecks.delete(sessionId);
        projectionState.delete(sessionId);
        sessionTurnValidations.delete(sessionId);
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
      const operation = registerSessionOperation(model.sessionId);
      let completeProjection!: () => void;
      const projectionCompletion = new Promise<void>((resolve) => {
        completeProjection = resolve;
      });
      activeProjections.add(projectionCompletion);
      try {
        const latestUser = latestUserMessage(messages);
        const currentTurnUserMessageId = latestUser?.info.id;
        const previous = projectionState.get(model.sessionId);
        const limits = await getModelLimits(
          model.providerId,
          model.modelId,
          operation.signal,
        );
        let initialListing: Promise<SegmentListing | null> | undefined;
        const listing = () =>
          (initialListing ??= getSegmentListing(
            model.sessionId,
            operation.signal,
          ).catch((error: unknown) => {
            if (error instanceof SegmentListingUnavailableError) return null;
            throw error;
          }));
        let rawSnapshot: Promise<OpenCodeMessage[]> | undefined;
        const rawMessages = () =>
          (rawSnapshot ??= getSessionMessages(
            model.sessionId,
            operation.signal,
          ));
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

        const validatedTurn = currentTurnUserMessageId
          ? sessionTurnValidations.get(model.sessionId)
          : undefined;
        const isSameTurnAsValidated =
          !isNewUserTurn(messages) &&
          validatedTurn !== undefined &&
          currentTurnUserMessageId !== undefined &&
          validatedTurn.latestUserMessageId === currentTurnUserMessageId &&
          previous?.checkpoint !== undefined &&
          validatedTurn.tailStartMessageId ===
            previous.checkpoint.tailStartMessageId &&
          validatedTurn.archivedPrefixFingerprint ===
            previous.checkpoint.archivedPrefixFingerprint &&
          validatedTurn.canonicalSourceFingerprint ===
            previous.checkpoint.canonicalSourceFingerprint;

        const result = await projectMessages({
          messages,
          ...limits,
          previous,
          skipPrefixFingerprint: isSameTurnAsValidated,
          validateCheckpoint: isSameTurnAsValidated
            ? undefined
            : async (checkpoint) => {
                const current = await listing();
                if (!current) return true;

                const emptySummaryFingerprint = projectionSummaryFingerprint(
                  checkpoint.archivedSegments,
                  [],
                );
                if (checkpoint.summaryFingerprint === emptySummaryFingerprint) {
                  const currentSummaryFingerprint =
                    projectionSummaryFingerprint(
                      checkpoint.archivedSegments,
                      current.summaries,
                    );
                  if (
                    currentSummaryFingerprint !== checkpoint.summaryFingerprint
                  ) {
                    return false;
                  }
                }

                let canUseFastCheck = true;
                for (const seg of checkpoint.archivedSegments) {
                  const target = current.targets.find(
                    (entry) => entry.id === seg.id,
                  );
                  if (target) {
                    if (target.sourceFingerprint !== seg.sourceFingerprint) {
                      return false;
                    }
                    continue;
                  }
                  const knownBoundaries = current.boundaries.filter(
                    (entry) =>
                      entry.id === seg.id &&
                      entry.sourceFingerprint !== undefined,
                  );
                  if (knownBoundaries.length > 0) {
                    if (
                      !knownBoundaries.some(
                        (entry) =>
                          entry.sourceFingerprint === seg.sourceFingerprint,
                      )
                    ) {
                      return false;
                    }
                    continue;
                  }
                  canUseFastCheck = false;
                  break;
                }
                if (canUseFastCheck) {
                  return true;
                }

                const plan = await loadCanonicalPlan();
                const tailSegmentIndex = plan.findIndex(
                  (segment) =>
                    segment.startMessageId === checkpoint.tailStartMessageId,
                );
                if (tailSegmentIndex < 0) return false;
                const archivedSegments = plan.slice(0, tailSegmentIndex);
                if (!archivedSegments.every((segment) => segment.closed)) {
                  return false;
                }
                const expectedSources = new Map(
                  archivedSegments.map((segment) => {
                    const body = submissionBody(model.sessionId, segment, 0);
                    return [
                      segmentIdForRequest(body),
                      submissionSourceFingerprint(model.sessionId, segment),
                    ] as const;
                  }),
                );
                for (const [segmentId, expected] of expectedSources) {
                  const target = current.targets.find(
                    (entry) => entry.id === segmentId,
                  );
                  if (target) {
                    if (target.sourceFingerprint !== expected) {
                      return false;
                    }
                    continue;
                  }
                  const knownBoundaries = current.boundaries.filter(
                    (entry) =>
                      entry.id === segmentId &&
                      entry.sourceFingerprint !== undefined,
                  );
                  if (
                    knownBoundaries.length > 0 &&
                    !knownBoundaries.some(
                      (entry) => entry.sourceFingerprint === expected,
                    )
                  ) {
                    return false;
                  }
                }
                return (
                  projectionSourcesFingerprint({
                    sessionId: model.sessionId,
                    archivedSegments,
                  }) === checkpoint.canonicalSourceFingerprint
                );
              },
          loadCanonicalSegments: loadCanonicalPlan,
          loadSummaries: async () => {
            const current = await listing();
            if (!current) {
              throw new SegmentListingUnavailableError(
                "context projection failed: segment manifest unavailable",
              );
            }
            const plan = await loadCanonicalPlan();
            foregroundSync ??= enqueueClosedTargetSync(
              model.sessionId,
              plan,
              generation,
              operation.signal,
            );
            try {
              await waitWithin(
                foregroundSync.then(() => {}),
                TARGET_WAIT_TIMEOUT_MS,
              );
            } catch (error) {
              if (
                operation.signal.aborted ||
                lifecycleAbort.signal.aborted ||
                deletedSessions.has(model.sessionId) ||
                (sessionGenerations.get(model.sessionId) ?? 0) !== generation
              ) {
                throw error;
              }
              await log(
                `Reflection foreground target sync failed for ${model.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            try {
              const directListing = await getSegmentListing(
                model.sessionId,
                operation.signal,
                PROJECTION_REQUEST_TIMEOUT_MS,
              );
              return directListing.summaries;
            } catch (error) {
              if (
                operation.signal.aborted ||
                lifecycleAbort.signal.aborted ||
                deletedSessions.has(model.sessionId) ||
                (sessionGenerations.get(model.sessionId) ?? 0) !== generation
              ) {
                throw error;
              }
              await log(
                `Reflection direct summary listing failed for ${model.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
              );
              return current.summaries;
            }
          },
        });
        if (
          operation.signal.aborted ||
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
        if (result.state.checkpoint && currentTurnUserMessageId) {
          sessionTurnValidations.set(model.sessionId, {
            latestUserMessageId: currentTurnUserMessageId,
            tailStartMessageId: result.state.checkpoint.tailStartMessageId,
            archivedPrefixFingerprint:
              result.state.checkpoint.archivedPrefixFingerprint,
            canonicalSourceFingerprint:
              result.state.checkpoint.canonicalSourceFingerprint,
          });
        } else {
          sessionTurnValidations.delete(model.sessionId);
        }
        output.messages.splice(
          0,
          output.messages.length,
          ...(result.messages as typeof output.messages),
        );
        if (result.reset) {
          if (result.diagnostic?.lossy) {
            void client.tui
              .showToast({
                query: { directory },
                body: {
                  title: "Reflection context warning",
                  message: PROJECTION_LOSS_WARNING,
                  variant: "warning",
                  duration: 10_000,
                },
              })
              .catch(() => {});
          }
          try {
            const request = requestSignal(
              operation.signal,
              SDK_REQUEST_TIMEOUT_MS,
            );
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
                signal: request.signal,
              });
            } finally {
              request.dispose();
            }
          } catch {}
        }
      } catch (error) {
        if (operation.signal.aborted) {
          throw operation.signal.reason ?? error;
        }
        await log(`context projection failed: ${String(error)}`);
        throw error;
      } finally {
        operation.dispose();
        activeProjections.delete(projectionCompletion);
        completeProjection();
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
              await getSessionMessages(segment.session_id, context.abort),
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
            if (context.abort.aborted) {
              throw context.abort.reason ?? error;
            }
            return `memory_read_segment failed: ${String(error)}`;
          }
        },
      }),
    },
  };
};

export default Reflection;
