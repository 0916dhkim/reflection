import { isAbsolute } from "node:path";
import { z } from "zod";
import { parseSourceInfo, type SourceInfo } from "@reflection/shared/sources";
import {
  canonicalizeNativeHistory,
  type NativeCanonicalRecord,
} from "@reflection/opencode-v2-core/history";
import type { OpenCodeMessage } from "@reflection/shared/segmentation";

const endpoint = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}, "endpoint must be HTTP(S) without embedded credentials, query, or fragment");
const readerSchema = z
  .object({
    kind: z.enum(["opencode-v1", "opencode-v2"]),
    url: endpoint,
    username: z.string().optional(),
    password: z.string().optional(),
    directory: z.string().refine(isAbsolute).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.username === undefined) === (value.password === undefined),
    "Basic authentication requires both credentials",
  );
export const configSchema = z
  .object({
    url: endpoint,
    apiKey: z.string().min(1),
    sourceId: z.string().trim().min(1).max(500),
    sources: z.record(z.string(), readerSchema),
    contextProjection: z.object({ enabled: z.literal(true) }).strict(),
  })
  .strict()
  .refine(
    (value) => value.sources[value.sourceId]?.kind === "opencode-v2",
    "own source must have an opencode-v2 endpoint",
  );
export type Config = z.infer<typeof configSchema>;
export type Reader = z.infer<typeof readerSchema>;
export function object(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Reflection: invalid object response");
  return value as Record<string, unknown>;
}
export function page(value: unknown): { data: unknown[]; next?: string } {
  const entry = object(value);
  const cursor = object(entry.cursor);
  if (
    !Array.isArray(entry.data) ||
    (cursor.next != null && (typeof cursor.next !== "string" || !cursor.next))
  )
    throw new Error("Reflection: invalid page response");
  return {
    data: entry.data,
    next: cursor.next == null ? undefined : String(cursor.next),
  };
}

// Errors never contain URL, credentials, backend response bodies, or raw SDK errors.
const httpStatus = (status?: number) =>
  status === undefined ? "" : ` (HTTP ${status})`;
export class AvailabilityError extends Error {
  constructor(readonly status?: number) {
    super(`Reflection: endpoint temporarily unavailable${httpStatus(status)}`);
  }
}
export class RequestRejectedError extends Error {
  constructor(readonly status: number) {
    super(`Reflection: endpoint rejected request${httpStatus(status)}`);
  }
}
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const SNAPSHOT_RETRY_DELAYS_MS = [100, 300] as const;
export const HISTORY_CACHE_SESSIONS = 8;

// OpenCode 2.0.8, the only accepted host, encodes message cursors as base64url
// JSON {id, order, direction} and anchors them on the message's sequence
// (server/src/handlers/message.ts, core/src/session/store.ts).
export function nativeCursorAfter(id: string): string {
  return Buffer.from(
    JSON.stringify({ id, order: "asc", direction: "next" }),
  ).toString("base64url");
}

/**
 * Settled native history prefix from the last stable context snapshot.
 *
 * In 2.0.8 rows are appended with increasing sequences and updates keep the
 * sequence. The only deletion is a committed revert, which removes a suffix.
 * Updates target incomplete records, and a step retry can revive the latest
 * assistant. So the prefix before the latest assistant and before the first
 * incomplete record does not change while its last message still exists
 * unchanged.
 */
interface HistoryCache {
  records: NativeCanonicalRecord[];
  ids: Set<string>;
  last: string;
}
// The Reflection API answers every 4xx with a JSON `{ detail }` envelope. A 4xx
// without it never reached the application, for example a reverse proxy's
// plain-text 404 while the API container is replaced during a deploy.
async function isApplicationError(response: Response): Promise<boolean> {
  const type = response.headers.get("content-type") ?? "";
  if (type.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    await response.body?.cancel();
    return false;
  }
  const reader = response.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ERROR_BODY_BYTES) {
        await reader.cancel();
        return false;
      }
      chunks.push(value);
    }
  } catch {
    return false;
  }
  try {
    const body: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    return (
      body != null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      "detail" in body &&
      (typeof body.detail === "string" || Array.isArray(body.detail))
    );
  } catch {
    return false;
  }
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export class RegistryUnavailableError extends AvailabilityError {
  constructor(status?: number) {
    super(status);
    this.message =
      "Reflection: source registry missing or temporarily unavailable";
  }
}
export class Transport {
  readonly registry = new Map<string, SourceInfo>();
  readonly histories = new Map<string, HistoryCache>();
  constructor(
    readonly config: Config,
    readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async request(
    path: string,
    signal: AbortSignal,
    source?: Reader,
    body?: unknown,
  ) {
    const url = new URL(path, source?.url ?? this.config.url);
    const headers = new Headers();
    if (source) {
      if (source.username !== undefined)
        headers.set(
          "Authorization",
          `Basic ${Buffer.from(`${source.username}:${source.password}`).toString("base64")}`,
        );
    } else headers.set("X-API-Key", this.config.apiKey);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    let response: Response;
    try {
      signal.throwIfAborted();
      response = await this.fetchImpl(url, {
        method: body === undefined ? "GET" : "POST",
        headers,
        redirect: "error",
        signal: requestSignal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      if (signal.aborted) throw new Error("Reflection: operation cancelled");
      throw new AvailabilityError();
    }
    if (!response.ok) {
      if (
        response.status >= 500 ||
        response.status === 408 ||
        response.status === 429
      ) {
        await response.body?.cancel();
        throw new AvailabilityError(response.status);
      }
      if (source) {
        await response.body?.cancel();
        throw new RequestRejectedError(response.status);
      }
      const application = await isApplicationError(response);
      if (signal.aborted) throw new Error("Reflection: operation cancelled");
      if (!application) throw new AvailabilityError(response.status);
      throw new RequestRejectedError(response.status);
    }
    try {
      const value: unknown = await response.json();
      signal.throwIfAborted();
      return {
        value,
        before: response.headers.get("X-Next-Cursor") ?? undefined,
      };
    } catch {
      if (!signal.aborted && requestSignal.aborted)
        throw new AvailabilityError();
      throw new Error(
        signal.aborted
          ? "Reflection: operation cancelled"
          : `Reflection: ${source ? "history source" : "backend"} unavailable or invalid response`,
      );
    }
  }
  async source(id: string, signal: AbortSignal): Promise<SourceInfo> {
    const cached = this.registry.get(id);
    if (cached) return cached;
    const configured = this.config.sources[id];
    if (!configured)
      throw new Error("Reflection: requested source is not configured");
    let source: SourceInfo;
    try {
      source = parseSourceInfo(
        (await this.request(`/v1/sources/${encodeURIComponent(id)}`, signal))
          .value,
      );
    } catch (error) {
      if (
        error instanceof AvailabilityError ||
        (error instanceof RequestRejectedError && error.status === 404)
      )
        throw new RegistryUnavailableError(error.status);
      throw new Error(
        "Reflection: source registry missing, unavailable, or invalid",
      );
    }
    if (
      source.id !== id ||
      source.kind !== configured.kind ||
      (source.kind === "opencode-v2" && source.identity_scheme !== "source-v1")
    )
      throw new Error("Reflection: source registry identity/kind mismatch");
    this.registry.set(id, source);
    return source;
  }
  reader(source: SourceInfo): Reader {
    const reader = this.config.sources[source.id];
    if (!reader || reader.kind !== source.kind)
      throw new Error("Reflection: source endpoint/kind mismatch");
    return reader;
  }
  /** `after` resumes an opencode-v2 read after that message ID (exclusive). */
  async history(
    source: SourceInfo,
    id: string,
    signal: AbortSignal,
    after?: string,
  ): Promise<unknown[]> {
    const reader = this.reader(source);
    if (after !== undefined && source.kind !== "opencode-v2")
      throw new Error(
        "Reflection: resumed history requires an opencode-v2 source",
      );
    const messages: unknown[] = [];
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let cursor = after === undefined ? undefined : nativeCursorAfter(after);
    do {
      const query = new URLSearchParams();
      if (source.kind === "opencode-v2") {
        query.set("limit", "200");
        if (cursor) query.set("cursor", cursor);
        else query.set("order", "asc");
      } else {
        if (reader.directory) query.set("directory", reader.directory);
        if (cursor) query.set("before", cursor);
      }
      const response = await this.request(
        `${source.kind === "opencode-v2" ? "/api" : ""}/session/${encodeURIComponent(id)}/message?${query}`,
        signal,
        reader,
      );
      const batch =
        source.kind === "opencode-v2"
          ? page(response.value)
          : { data: response.value, next: response.before };
      if (!Array.isArray(batch.data))
        throw new Error("Reflection: invalid history array");
      for (const raw of batch.data) {
        const item = object(raw);
        const messageId =
          source.kind === "opencode-v2" ? item.id : object(item.info).id;
        if (typeof messageId !== "string" || !messageId || ids.has(messageId))
          throw new Error("Reflection: missing or duplicate history ID");
        ids.add(messageId);
      }
      if (source.kind === "opencode-v1") messages.unshift(...batch.data);
      else messages.push(...batch.data);
      cursor = batch.next;
      if (cursor) {
        if (cursors.has(cursor))
          throw new Error("Reflection: repeated history cursor");
        cursors.add(cursor);
      }
    } while (cursor);
    return messages;
  }
  async session(reader: Reader, id: string, signal: AbortSignal) {
    const info = object(
      object(
        (
          await this.request(
            `/api/session/${encodeURIComponent(id)}`,
            signal,
            reader,
          )
        ).value,
      ).data,
    );
    if (
      info.id !== id ||
      typeof object(info.location).directory !== "string" ||
      typeof object(info.time).updated !== "number"
    )
      throw new Error("Reflection: invalid session metadata");
    return info;
  }
  async active(
    reader: Reader,
    id: string,
    signal: AbortSignal,
  ): Promise<string> {
    const data = object(
      (await this.request("/api/session/active", signal, reader)).value,
    ).data;
    if (Array.isArray(data)) {
      const entry = data.find((item) => object(item).id === id);
      return entry === undefined ? "inactive" : JSON.stringify(entry);
    }
    const entry = object(data)[id];
    return entry === undefined ? "inactive" : JSON.stringify(entry);
  }
  /**
   * `incremental` reuses this session's settled prefix from the previous stable
   * snapshot and reads only the tail after it. Any doubt falls back to a full
   * read. Only opencode-v2 sources are cached.
   */
  async snapshot(
    source: SourceInfo,
    id: string,
    signal: AbortSignal,
    inactive: boolean,
    incremental = false,
  ) {
    const reader = this.reader(source);
    const cacheable = incremental && source.kind === "opencode-v2";
    // A concurrent write (for example the host's restart notice) can land while
    // paging. Retry a stable read a bounded number of times, then fail closed.
    for (let attempt = 0; ; attempt++) {
      const before = await this.session(reader, id, signal);
      const status = await this.active(reader, id, signal);
      if (inactive && status !== "inactive")
        throw new Error("Reflection: session is active");
      const records = cacheable
        ? await this.cachedRecords(source, id, signal)
        : canonicalizeNativeHistory(await this.history(source, id, signal));
      const after = await this.session(reader, id, signal);
      const finalStatus = await this.active(reader, id, signal);
      if (
        JSON.stringify(before) === JSON.stringify(after) &&
        status === finalStatus
      ) {
        if (cacheable) this.remember(source.id, id, records);
        return { info: after, records };
      }
      const delay = SNAPSHOT_RETRY_DELAYS_MS[attempt];
      if (delay === undefined)
        throw new Error(
          "Reflection: history revision/status changed while paging",
        );
      await pause(delay, signal);
    }
  }
  forget(sourceId: string, id: string): void {
    this.histories.delete(historyKey(sourceId, id));
  }
  private async cachedRecords(
    source: SourceInfo,
    id: string,
    signal: AbortSignal,
  ): Promise<NativeCanonicalRecord[]> {
    const key = historyKey(source.id, id);
    const cached = this.histories.get(key);
    if (cached) {
      // Re-read the last cached message as an overlap. A missing anchor
      // returns [], so an empty or different first item means a revert
      // reached the prefix or the message changed.
      let tail: unknown[] | undefined;
      try {
        tail = await this.history(
          source,
          id,
          signal,
          cached.records.at(-2)!.source.id,
        );
      } catch (error) {
        if (!(error instanceof RequestRejectedError)) throw error;
      }
      if (tail !== undefined && JSON.stringify(tail[0]) === cached.last) {
        const fresh = canonicalizeNativeHistory(tail.slice(1));
        if (fresh.every((record) => !cached.ids.has(record.source.id)))
          return [...cached.records, ...fresh];
      }
      this.histories.delete(key);
    }
    return canonicalizeNativeHistory(await this.history(source, id, signal));
  }
  private remember(
    sourceId: string,
    id: string,
    records: NativeCanonicalRecord[],
  ): void {
    const key = historyKey(sourceId, id);
    this.histories.delete(key);
    let end = records.findIndex((record) => !record.complete);
    if (end < 0) end = records.length;
    const latestAssistant = records.findLastIndex(
      (record) => record.raw.type === "assistant",
    );
    if (latestAssistant >= 0) end = Math.min(end, latestAssistant);
    // The overlap anchors on the second-to-last cached message.
    if (end < 2) return;
    const settled = records.slice(0, end);
    this.histories.set(key, {
      records: settled,
      ids: new Set(settled.map((record) => record.source.id)),
      last: JSON.stringify(settled.at(-1)!.raw),
    });
    for (const oldest of this.histories.keys()) {
      if (this.histories.size <= HISTORY_CACHE_SESSIONS) break;
      this.histories.delete(oldest);
    }
  }
}

const historyKey = (sourceId: string, id: string) =>
  JSON.stringify([sourceId, id]);

export function legacyHistory(history: unknown[]): OpenCodeMessage[] {
  let previous = -Infinity;
  for (const value of history) {
    const item = object(value);
    const info = object(item.info);
    if (
      (info.role !== "user" && info.role !== "assistant") ||
      !Array.isArray(item.parts) ||
      !item.parts.every((part) => typeof object(part).type === "string")
    )
      throw new Error("Reflection: invalid legacy history");
    const created = object(info.time).created;
    if (
      typeof created !== "number" ||
      !Number.isFinite(created) ||
      created < previous
    )
      throw new Error("Reflection: legacy history out of order");
    previous = created;
  }
  return history as OpenCodeMessage[];
}

export function automaticCompaction(value: unknown): boolean {
  if (!Array.isArray(value))
    throw new Error("Reflection: expected normalized Config.Entry[]");
  let auto = true;
  for (const entry of value) {
    const document = object(entry);
    if (document.type === "directory") {
      if (typeof document.path !== "string")
        throw new Error("Reflection: invalid config directory entry");
      continue;
    }
    if (document.type !== "document")
      throw new Error("Reflection: unknown config entry type");
    const info = object(document.info);
    if (info.compaction == null) continue;
    const enabled = object(info.compaction).auto;
    if (enabled !== undefined && typeof enabled !== "boolean")
      throw new Error("Reflection: invalid compaction configuration");
    if (typeof enabled === "boolean") auto = enabled;
  }
  return auto;
}
