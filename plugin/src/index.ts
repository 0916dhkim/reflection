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
  readSegmentMessages,
  segmentMessages,
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
const PROJECTION_VERSION = 1;

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

function parseSegmentSummaries(
  data: unknown,
  sessionId: string,
): StoredSegmentSummary[] | null {
  if (
    typeof data !== "object" ||
    data === null ||
    !("segments" in data) ||
    !("session_id" in data) ||
    data.session_id !== sessionId
  ) {
    return null;
  }
  if (!Array.isArray(data.segments)) return null;
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
  return result;
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
    });
    return (response.data ?? []) as OpenCodeMessage[];
  };

  const submitSession = async (sessionId: string, includeTail: boolean) => {
    const segments = segmentMessages(await getSessionMessages(sessionId));
    for (const segment of segments) {
      if (!segment.closed && !includeTail) continue;
      const response = await apiCall("/v1/segments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submissionBody(sessionId, segment)),
      });
      if (!response.ok) {
        await log(
          formatApiFailure(`segment submission for ${sessionId}`, response),
        );
      }
    }
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
    const result = {
      contextLimit: limit.context,
      inputLimit: limit.input,
      outputLimit: limit.output,
    };
    modelLimits.set(key, result);
    return result;
  };

  const getSegmentSummaries = async (
    sessionId: string,
  ): Promise<StoredSegmentSummary[]> => {
    const response = await apiCall(
      `/v1/sessions/${encodeURIComponent(sessionId)}/segments`,
      { method: "GET" },
      PROJECTION_REQUEST_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new Error(formatApiFailure("context projection", response));
    }
    const summaries = parseSegmentSummaries(response.data, sessionId);
    if (!summaries) {
      throw new Error("context projection failed: invalid segment summaries");
    }
    return summaries;
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
        sessionGenerations.set(
          sessionId,
          (sessionGenerations.get(sessionId) ?? 0) + 1,
        );
        compactingSessions.delete(sessionId);
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

      try {
        await submitSession(sessionId, false);

        const response = await client.session.list({ query: { directory } });
        const cutoff = Date.now() - INACTIVE_MS;
        for (const session of response.data ?? []) {
          if (session.id === sessionId || session.time.updated > cutoff)
            continue;
          await submitSession(session.id, true);
        }
      } catch (error) {
        await log(`idle ingestion failed: ${String(error)}`);
      }
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
      const compactionDeadline = compactingSessions.get(model.sessionId);
      if (compactionDeadline !== undefined) {
        compactingSessions.delete(model.sessionId);
        if (compactionDeadline >= Date.now()) return;
      }
      const generation = sessionGenerations.get(model.sessionId) ?? 0;
      try {
        const previous = projectionState.get(model.sessionId);
        const limits = await getModelLimits(model.providerId, model.modelId);
        const result = await projectMessages({
          messages,
          ...limits,
          previous,
          loadSummaries: () => getSegmentSummaries(model.sessionId),
        });
        if ((sessionGenerations.get(model.sessionId) ?? 0) !== generation) {
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
          try {
            await client.app.log({
              body: {
                service: "reflection",
                level: "info",
                message: `context projection reset ${model.sessionId} at ${result.state.checkpoint?.tailStartUserMessageId}; estimated ${result.estimatedTokens}/${limits.contextLimit} tokens`,
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
