import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { tool, type Plugin } from "@opencode-ai/plugin";

import { requestSignal, safeErrorDetail } from "./http.js";
import {
  activeModel,
  projectMessages,
  type StoredSegmentSummary,
} from "./projection.js";
import { ProjectionStateStore } from "./projection-state.js";
import {
  PROJECTION_LOSS_WARNING,
  PROJECTION_LOSS_WARNING_METADATA,
  type CommittedSegmentBoundary,
  isNormalUserMessage,
  readSegmentMessages,
  segmentMessages,
  submissionSourceFingerprint,
  type OpenCodeMessage,
  type ReflectionSegment,
} from "./segments.js";

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

interface StoredSegment {
  session_id: string;
  start_user_message_id: string;
  end_user_message_id: string;
}

interface SegmentListing {
  summaries: StoredSegmentSummary[];
  boundaries: CommittedSegmentBoundary[];
  targets: Array<CommittedSegmentBoundary & { status: string }>;
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
  if (typeof data !== "object" || data === null) return null;
  const value = data as Record<string, unknown>;
  if (
    typeof value.session_id !== "string" ||
    typeof value.start_user_message_id !== "string" ||
    typeof value.end_user_message_id !== "string"
  ) {
    return null;
  }
  return {
    session_id: value.session_id,
    start_user_message_id: value.start_user_message_id,
    end_user_message_id: value.end_user_message_id,
  };
}

function submissionBody(sessionId: string, segment: ReflectionSegment) {
  return {
    session_id: sessionId,
    start_user_message_id: segment.startUserMessageId,
    end_user_message_id: segment.endUserMessageId,
    projection_version: PROJECTION_VERSION,
    messages: segment.messages,
  };
}

function parseSegmentListing(
  data: unknown,
  sessionId: string,
): SegmentListing | null {
  if (
    typeof data !== "object" ||
    data === null ||
    !("segments" in data) ||
    !("boundaries" in data) ||
    !("session_id" in data) ||
    data.session_id !== sessionId
  ) {
    return null;
  }
  if (
    !("targets" in data) ||
    !Array.isArray(data.segments) ||
    !Array.isArray(data.boundaries) ||
    !Array.isArray(data.targets)
  )
    return null;
  const result: StoredSegmentSummary[] = [];
  for (const item of data.segments) {
    if (typeof item !== "object" || item === null) return null;
    const value = item as Record<string, unknown>;
    if (
      typeof value.id !== "string" ||
      typeof value.start_user_message_id !== "string" ||
      typeof value.end_user_message_id !== "string" ||
      !Number.isInteger(value.projection_version) ||
      typeof value.summary !== "string"
    ) {
      return null;
    }
    result.push({
      id: value.id,
      start_user_message_id: value.start_user_message_id,
      end_user_message_id: value.end_user_message_id,
      projection_version: value.projection_version as number,
      summary: value.summary,
    });
  }
  const boundaries: CommittedSegmentBoundary[] = [];
  for (const item of data.boundaries) {
    if (typeof item !== "object" || item === null) return null;
    const value = item as Record<string, unknown>;
    if (
      typeof value.id !== "string" ||
      typeof value.start_user_message_id !== "string" ||
      typeof value.end_user_message_id !== "string" ||
      !Number.isInteger(value.projection_version) ||
      typeof value.source_eligible !== "boolean" ||
      (value.source_fingerprint !== null &&
        typeof value.source_fingerprint !== "string")
    ) {
      return null;
    }
    boundaries.push({
      id: value.id,
      startUserMessageId: value.start_user_message_id,
      endUserMessageId: value.end_user_message_id,
      projectionVersion: value.projection_version as number,
      sourceEligible: value.source_eligible,
      sourceFingerprint:
        typeof value.source_fingerprint === "string"
          ? value.source_fingerprint
          : undefined,
    });
  }
  const targets: SegmentListing["targets"] = [];
  for (const item of data.targets) {
    if (typeof item !== "object" || item === null) return null;
    const value = item as Record<string, unknown>;
    if (
      typeof value.id !== "string" ||
      typeof value.start_user_message_id !== "string" ||
      typeof value.end_user_message_id !== "string" ||
      !Number.isInteger(value.projection_version) ||
      typeof value.status !== "string" ||
      typeof value.source_fingerprint !== "string"
    ) {
      return null;
    }
    targets.push({
      id: value.id,
      startUserMessageId: value.start_user_message_id,
      endUserMessageId: value.end_user_message_id,
      projectionVersion: value.projection_version as number,
      sourceEligible: false,
      sourceFingerprint: value.source_fingerprint,
      status: value.status,
    });
  }
  return { summaries: result, boundaries, targets };
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
  const successfulSegmentFingerprints = new Map<string, Map<string, string>>();
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
        boundary.sourceFingerprint
          ? [[boundary.startUserMessageId, boundary.sourceFingerprint] as const]
          : [],
      ),
    );
    for (const [startUserMessageId, fingerprint] of cached) {
      const current = authoritative.get(startUserMessageId);
      if (current !== undefined && current !== fingerprint) {
        cached.delete(startUserMessageId);
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
    signal: AbortSignal,
  ): Promise<string[]> => {
    const fingerprints =
      successfulSegmentFingerprints.get(sessionId) ?? new Map<string, string>();
    successfulSegmentFingerprints.set(sessionId, fingerprints);
    const successful: string[] = [];
    for (const segment of segments) {
      if (!segment.closed && !includeOpenSegment) continue;
      const body = submissionBody(sessionId, segment);
      const segmentKey = segment.startUserMessageId;
      const fingerprint = submissionSourceFingerprint(sessionId, segment);
      if (fingerprints.get(segmentKey) === fingerprint) {
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
      fingerprints.set(segmentKey, fingerprint);
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
      if (state?.failure) throw state.failure;
      if (dirtyIdle) continue;
      if (
        state &&
        targetUpdates.get(sessionId) === state &&
        observed === state.tail
      ) {
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
      throw new Error(formatApiFailure("context projection", response));
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
  ): Promise<SegmentListing> => {
    const deadline = Date.now() + TARGET_WAIT_TIMEOUT_MS;
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
        observedSegmentKeys: segments.map(
          (segment) => segment.startUserMessageId,
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
      submitSegmentSnapshot(sessionId, segments, false, generation, null),
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
        let initialListing: Promise<SegmentListing> | undefined;
        const listing = () =>
          (initialListing ??= getSegmentListing(model.sessionId));
        const result = await projectMessages({
          messages,
          ...limits,
          previous,
          loadBoundaries: async () => segmentAnchors(await listing()),
          loadSummaries: () => {
            return listing().then(async (current) => {
              const sync = enqueueClosedTargetSync(
                model.sessionId,
                segmentMessages(messages, undefined, segmentAnchors(current)),
                generation,
              );
              void sync.catch((error: unknown) =>
                log(`projection target sync failed: ${String(error)}`),
              );
              return (await getFreshSegmentListing(model.sessionId)).summaries;
            });
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
              const checkpointKey = `${checkpoint.tailStartUserMessageId}:${checkpoint.createdAtMessageId}`;
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
          if (!segment)
            return "memory_read_segment failed: invalid segment metadata";

          try {
            const messages = readSegmentMessages(
              await getSessionMessages(segment.session_id),
              segment.start_user_message_id,
              segment.end_user_message_id,
            );
            return formatData({
              segment_id,
              session_id: segment.session_id,
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
