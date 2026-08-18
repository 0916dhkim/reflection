import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { tool, type Plugin } from "@opencode-ai/plugin";

import { requestSignal, safeErrorDetail } from "./http.js";
import {
  readSegmentMessages,
  segmentMessages,
  type OpenCodeMessage,
  type ReflectionSegment,
} from "./segments.js";

const CONFIG_PATH = join(homedir(), ".config", "opencode", "reflection.json");
const INACTIVE_MS = 10 * 60 * 1000;

interface ReflectionConfig {
  url: string;
  apiKey: string;
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
      return { url: value.url.replace(/\/$/, ""), apiKey: value.apiKey };
    }
  } catch {}
  return null;
}

async function apiCall(path: string, init: RequestInit): Promise<ApiResult> {
  const config = loadConfig();
  if (!config) {
    return {
      ok: false,
      status: 0,
      data: null,
      detail: `missing or invalid config at ${CONFIG_PATH}`,
    };
  }

  const request = requestSignal(init.signal);
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
    messages: segment.messages,
  };
}

function formatData(data: unknown): string {
  return JSON.stringify(data, null, 2) ?? "null";
}

function formatApiFailure(operation: string, response: ApiResult): string {
  const detail = response.detail ? `: ${response.detail}` : "";
  return `${operation} failed (${response.status})${detail}`;
}

export const Reflection: Plugin = async ({ client, directory }) => {
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

  return {
    event: async ({ event }) => {
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
