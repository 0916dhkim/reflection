import type { SourceInfo } from "@reflection/shared/sources";
import type { IngestSegmentResponse } from "@reflection/shared/ingestion";
import type { OpenCodeMessage } from "@reflection/shared/segmentation";

import { requestSignal } from "./http.js";

export interface SourceReaderConfig {
  kind: "opencode-v1" | "opencode-v2";
  url: string;
  username?: string;
  password?: string;
  directory?: string;
}

export interface HistoryReaderOptions {
  sources: Readonly<Record<string, SourceReaderConfig>>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  readOwnV1?: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<OpenCodeMessage[]>;
}

function configuredSource(
  source: SourceInfo,
  sources: Readonly<Record<string, SourceReaderConfig>>,
): SourceReaderConfig {
  const configured = sources[source.id];
  if (!configured) {
    throw new Error(`source ${source.id} is not configured for history reads`);
  }
  if (configured.kind !== source.kind) {
    throw new Error(
      `source ${source.id} kind does not match its registry entry`,
    );
  }
  return configured;
}

function authorization(source: SourceReaderConfig): HeadersInit | undefined {
  if (source.username === undefined && source.password === undefined) {
    return undefined;
  }
  if (source.username === undefined || source.password === undefined) {
    throw new Error(
      "source reader credentials must include username and password",
    );
  }
  return {
    Authorization: `Basic ${Buffer.from(`${source.username}:${source.password}`).toString("base64")}`,
  };
}

async function fetchJson(
  url: string,
  source: SourceReaderConfig,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<{ value: unknown; before?: string }> {
  try {
    signal.throwIfAborted();
    const response = await fetchImpl(url, {
      headers: authorization(source),
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`history source returned ${response.status}`);
    }
    const body = await response.text();
    signal.throwIfAborted();
    try {
      return {
        value: JSON.parse(body) as unknown,
        before: response.headers.get("X-Next-Cursor") ?? undefined,
      };
    } catch {
      throw new Error("history source returned invalid JSON");
    }
  } catch {
    signal.throwIfAborted();
    // A transport error or server body can contain URL/basic-auth credentials.
    throw new Error(
      "history source unavailable or returned an invalid response",
    );
  }
}

function messages(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("history source returned a non-array message response");
  }
  return value;
}

export interface NativeV2Message {
  id: string;
  type:
    | "user"
    | "assistant"
    | "synthetic"
    | "shell"
    | "skill"
    | "system"
    | "compaction"
    | "idle"
    | "agent-switched"
    | "model-switched"
    | "location-switched";
  time: { created: number; [key: string]: unknown };
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Minimum transport shape from @opencode/schema/session-message at v2.0.8
// (7673ed6). Keep additional fields intact for the CP009 canonical adapter.
function validateV2Message(
  message: unknown,
): asserts message is NativeV2Message {
  const time = (value: unknown) =>
    isRecord(value) &&
    typeof value.created === "number" &&
    Number.isFinite(value.created);
  const model = (value: unknown) =>
    isRecord(value) &&
    typeof value.providerID === "string" &&
    typeof value.id === "string";
  const error = (value: unknown) =>
    isRecord(value) &&
    typeof value.type === "string" &&
    typeof value.message === "string";
  const oneOf = (value: unknown, choices: readonly string[]) =>
    typeof value === "string" && choices.includes(value);
  const toolContent = (value: unknown) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (part) =>
        isRecord(part) &&
        ((part.type === "text" && typeof part.text === "string") ||
          (part.type === "file" &&
            typeof part.uri === "string" &&
            typeof part.mime === "string")),
    );
  const assistantPart = (part: unknown): boolean => {
    if (!isRecord(part)) return false;
    if (part.type === "text" || part.type === "reasoning")
      return typeof part.text === "string";
    if (
      part.type !== "tool" ||
      typeof part.id !== "string" ||
      typeof part.name !== "string" ||
      !time(part.time) ||
      !isRecord(part.state)
    )
      return false;
    const state = part.state;
    switch (state.status) {
      case "streaming":
        return typeof state.input === "string";
      case "running":
        return isRecord(state.input) && isRecord(state.metadata);
      case "completed":
        return isRecord(state.input) && toolContent(state.content);
      case "error":
        return (
          isRecord(state.input) &&
          error(state.error) &&
          (state.content === undefined || toolContent(state.content))
        );
      default:
        return false;
    }
  };
  if (
    !isRecord(message) ||
    typeof message.id !== "string" ||
    !message.id.startsWith("msg_") ||
    !time(message.time)
  ) {
    throw new Error("history source returned an invalid v2 message");
  }
  let valid = false;
  switch (message.type) {
    case "user":
    case "synthetic":
    case "system":
      valid = typeof message.text === "string";
      break;
    case "skill":
      valid =
        typeof message.text === "string" &&
        typeof message.skill === "string" &&
        typeof message.name === "string";
      break;
    case "assistant":
      valid =
        typeof message.agent === "string" &&
        model(message.model) &&
        Array.isArray(message.content) &&
        message.content.every(assistantPart);
      break;
    case "shell":
      valid =
        typeof message.shellID === "string" &&
        typeof message.command === "string" &&
        oneOf(message.status, ["running", "exited", "timeout", "killed"]);
      break;
    case "idle":
      valid = oneOf(message.outcome, ["succeeded", "failed", "interrupted"]);
      break;
    case "agent-switched":
      valid = typeof message.agent === "string";
      break;
    case "model-switched":
      valid = model(message.model);
      break;
    case "location-switched":
      valid =
        isRecord(message.location) &&
        typeof message.location.directory === "string";
      break;
    case "compaction":
      valid =
        oneOf(message.reason, ["auto", "manual"]) &&
        (message.status === "failed"
          ? error(message.error)
          : oneOf(message.status, ["running", "completed"]) &&
            typeof message.summary === "string" &&
            typeof message.recent === "string");
      break;
    default:
      throw new Error("history source returned an unknown v2 message type");
  }
  if (!valid)
    throw new Error("history source returned an invalid v2 message body");
}

function v1Url(source: SourceReaderConfig, sessionId: string): string {
  const url = new URL(
    `/session/${encodeURIComponent(sessionId)}/message`,
    source.url,
  );
  if (source.directory !== undefined) {
    url.searchParams.set("directory", source.directory);
  }
  return url.toString();
}

function v2Url(
  source: SourceReaderConfig,
  sessionId: string,
  cursor?: string,
): string {
  const url = new URL(
    `/api/session/${encodeURIComponent(sessionId)}/message`,
    source.url,
  );
  if (cursor === undefined) url.searchParams.set("order", "asc");
  url.searchParams.set("limit", "200");
  if (cursor !== undefined) {
    url.searchParams.set("cursor", cursor);
  }
  return url.toString();
}

function v2Page(value: unknown): { data: unknown[]; next?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("history source returned an invalid v2 page");
  }
  const page = value as Record<string, unknown>;
  const data = messages(page.data);
  const cursor = page.cursor;
  if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
    throw new Error("history source returned an invalid v2 cursor");
  }
  const next = (cursor as Record<string, unknown>).next ?? undefined;
  if (next !== undefined && (typeof next !== "string" || next.length === 0)) {
    throw new Error("history source returned an invalid v2 cursor");
  }
  return { data, next };
}

/**
 * Legacy v1 transport. Native v2 records deliberately use a separate type.
 */
export async function readHistory(
  source: SourceInfo,
  sessionId: string,
  options: HistoryReaderOptions,
  signal: AbortSignal,
  ownSourceId?: string,
): Promise<OpenCodeMessage[]> {
  if (source.kind !== "opencode-v1") {
    throw new Error(
      "native v2 history requires its typed reader and range contract",
    );
  }
  return (await readPages(
    source,
    sessionId,
    options,
    signal,
    ownSourceId,
  )) as OpenCodeMessage[];
}

// CP009 consumes canonical typed records, not reconstructed v1 user turns.
export async function readNativeV2History(
  source: SourceInfo,
  sessionId: string,
  options: HistoryReaderOptions,
  signal: AbortSignal,
): Promise<NativeV2Message[]> {
  if (source.kind !== "opencode-v2")
    throw new Error("expected an opencode-v2 source");
  return (await readPages(
    source,
    sessionId,
    options,
    signal,
  )) as NativeV2Message[];
}

async function readPages(
  source: SourceInfo,
  sessionId: string,
  options: HistoryReaderOptions,
  signal: AbortSignal,
  ownSourceId?: string,
): Promise<unknown[]> {
  const configured = configuredSource(source, options.sources);
  const endpoint = new URL(configured.url);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("invalid history source endpoint");
  }
  const request = requestSignal(signal, options.timeoutMs ?? 120_000);
  try {
    request.signal.throwIfAborted();
    if (
      source.id === ownSourceId &&
      source.kind === "opencode-v1" &&
      options.readOwnV1
    ) {
      return await options.readOwnV1(sessionId, request.signal);
    }
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;

    const result: unknown[] = [];
    const seenCursors = new Set<string>();
    const seenMessageIds = new Set<string>();
    let cursor: string | undefined;
    do {
      const url = new URL(
        source.kind === "opencode-v1"
          ? v1Url(configured, sessionId)
          : v2Url(configured, sessionId, cursor),
      );
      if (source.kind === "opencode-v1" && cursor !== undefined)
        url.searchParams.set("before", cursor);
      const response = await fetchJson(
        url.toString(),
        configured,
        request.signal,
        fetchImpl,
      );
      const page =
        source.kind === "opencode-v1"
          ? { data: messages(response.value), next: response.before }
          : v2Page(response.value);
      for (const message of page.data) {
        let id: unknown;
        if (source.kind === "opencode-v2") {
          validateV2Message(message);
          id = message.id;
        } else {
          id = (message as OpenCodeMessage)?.info?.id;
        }
        if (typeof id !== "string" || id.length === 0) {
          throw new Error("history source returned a message without an ID");
        }
        if (seenMessageIds.has(id)) {
          throw new Error("history source returned duplicate messages");
        }
        seenMessageIds.add(id);
      }
      // v1's before cursor traverses older pages, each in chronological order.
      if (source.kind === "opencode-v1") result.unshift(...page.data);
      else result.push(...page.data);
      cursor = page.next;
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) {
          throw new Error("history source returned a repeated cursor");
        }
        seenCursors.add(cursor);
      }
    } while (cursor !== undefined);
    let previousCreated: number | undefined;
    for (const message of result) {
      // V2 cursors define transcript sequence. Admission/delivery and async
      // execution can differ from creation time; never reorder by timestamps.
      if (source.kind === "opencode-v2") break;
      const time = (message as OpenCodeMessage).info.time;
      const created =
        typeof time === "object" && time !== null && "created" in time
          ? time.created
          : undefined;
      if (typeof created !== "number") continue;
      if (
        !Number.isFinite(created) ||
        (previousCreated !== undefined && created < previousCreated)
      ) {
        throw new Error("history source returned out-of-order messages");
      }
      previousCreated = created;
    }
    return result;
  } finally {
    request.dispose();
  }
}

export function assertReadableBoundary(
  source: SourceInfo,
  segment: IngestSegmentResponse,
): void {
  if (segment.source_boundary_version === 3) {
    if (
      source.kind !== "opencode-v2" ||
      source.identity_scheme !== "source-v1"
    ) {
      throw new Error(
        "native hydration requires an opencode-v2 source-v1 registry entry",
      );
    }
    return;
  }
  if (source.kind === "opencode-v2") {
    throw new Error(
      "cannot hydrate legacy turn boundaries from an opencode-v2 source",
    );
  }
}
