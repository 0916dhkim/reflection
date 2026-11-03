import { Message } from "@opencode/ai";
import { types } from "node:util";
import { estimateNativeTokens } from "@reflection/opencode-v2-core/projection";

export const NOTICE_PREFIX =
  "[System-generated Reflection context, not a new user instruction. Archived material may omit details; use memory_search and memory_read_segment with source_id and segment_id.]\n";

// Providers bill PDFs per page (extracted text plus a page image), roughly
// 1.5K-3K tokens per page. These reserves are only the first guess: once the
// provider reports usage, the request that carried the PDF is sized from it.
const PDF_PAGE_RESERVE = "x ".repeat(4096);
const PDF_BYTES_PER_PAGE = 50_000;

function pdfBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (typeof data !== "string") return;
  const match = /^data:[^,]*;base64,/.exec(data);
  if (match) return Buffer.from(data.slice(match[0].length), "base64");
  if (/^[A-Za-z0-9+/=\s]+$/.test(data)) return Buffer.from(data, "base64");
}

/** Pages from page objects and page-tree counts. Object streams can hide both,
 * so fall back to a size-based guess, and use one page for unreadable data. */
export function pdfPageCount(data: unknown): number {
  const bytes = pdfBytes(data);
  if (!bytes || bytes.length === 0) return 1;
  const text = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.length,
  ).toString("latin1");
  const objects = text.match(/\/Type\s*\/Page(?![A-Za-z0-9])/g)?.length ?? 0;
  let counted = 0;
  for (const match of text.matchAll(/\/Count\s+(\d+)/g))
    counted = Math.max(counted, Number(match[1]));
  return Math.max(
    1,
    objects,
    counted,
    objects || counted ? 0 : Math.ceil(bytes.length / PDF_BYTES_PER_PAGE),
  );
}

// Estimation-only copy. Original content, including binary media, is never
// rewritten. Images reserve 16K tokens each (core adds another 4K) and PDFs
// reserve 4K per page. Other file/audio/video payloads fail closed rather than
// silently dropping media.
export function estimationValue(
  value: unknown,
  visiting = new Set<object>(),
): unknown {
  if (value == null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value !== "object" ||
    types.isProxy(value) ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof Date ||
    value instanceof RegExp
  )
    throw new Error(
      "Reflection: opaque model payload cannot be projected safely",
    );
  if (visiting.has(value))
    throw new Error("Reflection: cyclic model payload is unsupported");
  visiting.add(value);
  try {
    // SDK schemas can yield class instances across the host/bundle boundary.
    // Read only own data descriptors: never execute accessors or toJSON hooks.
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || !("value" in descriptors[key]!))
        throw new Error(
          "Reflection: accessor or symbol model payload is unsupported",
        );
    }
    if (Array.isArray(value)) {
      if (
        Object.keys(descriptors).some(
          (key) => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key),
        )
      )
        throw new Error("Reflection: opaque array properties are unsupported");
      return Array.from({ length: value.length }, (_, index) =>
        estimationValue(descriptors[String(index)]?.value, visiting),
      );
    }
    const item: Record<string, unknown> = Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [
        key,
        descriptor.value as unknown,
      ]),
    );
    const prototype: unknown = Object.getPrototypeOf(value);
    const supportedShape =
      ((item.type === "text" || item.type === "reasoning") &&
        typeof item.text === "string") ||
      (typeof item.type === "string" &&
        ["json", "text", "error", "content"].includes(item.type) &&
        Object.hasOwn(item, "value")) ||
      (item.type === "tool-call" &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        Object.hasOwn(item, "input")) ||
      (item.type === "tool-result" &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        Object.hasOwn(item, "result")) ||
      item.type === "media" ||
      item.type === "file" ||
      item.type === "compaction" ||
      item.type === "effort";
    if (prototype !== Object.prototype && prototype !== null && !supportedShape)
      throw new Error(
        "Reflection: opaque model payload cannot be projected safely",
      );
    if (item.type === "compaction")
      throw new Error(
        "Reflection: preexisting native checkpoint is forbidden; rebuild from uncompacted history",
      );
    if (item.type === "media" || item.type === "file") {
      const mime = item.mediaType ?? item.mime;
      const pdf = mime === "application/pdf";
      if (
        typeof mime !== "string" ||
        !(pdf || /^image\/(png|jpeg|webp|gif)$/.test(mime))
      )
        throw new Error(
          "Reflection: unbounded non-image media cannot be projected safely",
        );
      const data = item.data ?? item.uri;
      if (
        !(
          typeof data === "string" ||
          (data instanceof Uint8Array && !types.isProxy(data))
        )
      )
        throw new Error(`Reflection: invalid ${pdf ? "PDF" : "image"} payload`);
      const { data: _data, uri: _uri, ...metadata } = item;
      return {
        ...Object.fromEntries(
          Object.entries(metadata).map(([key, child]) => [
            key,
            estimationValue(child, visiting),
          ]),
        ),
        ...(pdf
          ? {
              type: "document",
              reserve: Array.from(
                { length: pdfPageCount(data) },
                () => PDF_PAGE_RESERVE,
              ),
            }
          : { type: "image", reserve: "x ".repeat(16384) }),
        mediaType: mime,
      };
    }
    return Object.fromEntries(
      Object.entries(item).map(([key, child]) => [
        key,
        estimationValue(child, visiting),
      ]),
    );
  } finally {
    visiting.delete(value);
  }
}
export function estimateMessages(messages: readonly Message[]) {
  return messages.map((message) => {
    if (message.native != null)
      throw new Error(
        "Reflection: opaque provider-native message payload is unsupported; native mapping and estimation are required before dispatch",
      );
    return {
      id: message.id,
      role: message.role,
      // The core budgets content, not extra message fields. This descriptor is
      // estimation-only and never becomes an actual provider content part.
      content: estimationValue(
        message.providerMetadata == null
          ? message.content
          : [
              ...message.content,
              {
                type: "reflection-provider-metadata",
                providerMetadata: message.providerMetadata,
              },
            ],
      ),
    };
  });
}
export function materializedTokens(
  messages: readonly Message[],
  system: unknown,
  tools: unknown,
) {
  return (
    estimateNativeTokens(system) +
    estimateNativeTokens(tools) +
    estimateMessages(messages).reduce(
      (sum, message) =>
        sum +
        8 +
        estimateNativeTokens({ role: message.role, content: message.content }),
      0,
    )
  );
}
