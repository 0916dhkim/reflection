import { Message } from "@opencode/ai";
import { types } from "node:util";
import { z } from "zod";
import {
  estimateNativeTokens,
  type NativeProjectionCheckpoint,
  type NativeProjectionResult,
} from "@reflection/opencode-v2-core/projection";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const checkpointSchema = z
  .object({
    version: z.literal(2),
    source_id: z.string().min(1),
    session_id: z.string().min(1),
    archived: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            start_source_message_id: z.string().min(1),
            end_source_message_id: z.string().min(1),
            source_fingerprint: hash,
            source_message_ids: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
    source_prefix_fingerprint: hash,
    tail_start_source_id: z.string().nullable(),
    restored_user_id: z.string().nullable(),
    manifest_summary_fingerprint: hash,
    cachedSummaries: z.array(
      z
        .object({
          id: z.string().uuid(),
          start_source_message_id: z.string().min(1),
          end_source_message_id: z.string().min(1),
          source_fingerprint: hash,
          projection_version: z.literal(3),
          summary: z.string(),
        })
        .strict(),
    ),
    cached_summaries_fingerprint: hash,
    context_limit: z.number().positive(),
    input_limit: z.number().positive(),
    output_limit: z.number().nonnegative(),
    notice_id: z.string().regex(/^reflection-native-[a-f0-9]{32}$/),
  })
  .strict();
export function checkpoint(
  value: unknown,
  source: string,
  session: string,
): NativeProjectionCheckpoint | undefined {
  const result = checkpointSchema.safeParse(value);
  if (
    !result.success ||
    result.data.source_id !== source ||
    result.data.session_id !== session
  )
    return;
  for (const range of result.data.archived) {
    if (
      range.source_message_ids[0] !== range.start_source_message_id ||
      range.source_message_ids.at(-1) !== range.end_source_message_id ||
      new Set(range.source_message_ids).size !== range.source_message_ids.length
    )
      return;
  }
  return result.data;
}
export function checkpointSchemaJson(value: NativeProjectionCheckpoint) {
  // Plain JSON records, with the core's canonical cached-summary field order.
  return {
    ...value,
    archived: value.archived.map((range) => ({
      id: range.id,
      start_source_message_id: range.start_source_message_id,
      end_source_message_id: range.end_source_message_id,
      source_fingerprint: range.source_fingerprint,
      source_message_ids: [...range.source_message_ids],
    })),
    cachedSummaries: value.cachedSummaries.map((summary) => ({
      id: summary.id,
      start_source_message_id: summary.start_source_message_id,
      end_source_message_id: summary.end_source_message_id,
      source_fingerprint: summary.source_fingerprint,
      projection_version: summary.projection_version,
      summary: summary.summary,
    })),
  };
}
export const NOTICE_PREFIX =
  "[System-generated Reflection context, not a new user instruction. Archived material may omit details; use memory_search and memory_read_segment with source_id and segment_id.]\n";
export const ANCHOR_HEADER = "\n[Latest actual user input, copied verbatim]\n";
export const ANCHOR_FOOTER = "\n[End latest actual user input]";
export const WRAPPER_RESERVE = NOTICE_PREFIX + ANCHOR_HEADER + ANCHOR_FOOTER;

// Estimation-only copy. Original content, including binary media, is never
// rewritten. Images reserve 16K tokens each (core adds another 4K). Unknown
// file/audio/video payloads fail closed rather than silently dropping media.
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
      if (
        typeof mime !== "string" ||
        !/^image\/(png|jpeg|webp|gif)$/.test(mime)
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
        throw new Error("Reflection: invalid image payload");
      const { data: _data, uri: _uri, ...metadata } = item;
      return {
        ...Object.fromEntries(
          Object.entries(metadata).map(([key, child]) => [
            key,
            estimationValue(child, visiting),
          ]),
        ),
        type: "image",
        reserve: "x ".repeat(16384),
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
export function materialize(
  plan: NativeProjectionResult,
  messages: readonly Message[],
): Message[] {
  if (!plan.notice) return [...messages];
  const content: Message["content"][number][] = [
    { type: "text", text: NOTICE_PREFIX + plan.notice.text },
  ];
  let providerMetadata: Message["providerMetadata"];
  if (plan.notice.anchorMessageIndex !== undefined) {
    const anchor = messages[plan.notice.anchorMessageIndex];
    if (!anchor || anchor.role !== "user")
      throw new Error("Reflection: invalid latest user anchor");
    providerMetadata = anchor.providerMetadata;
    content.push({ type: "text", text: ANCHOR_HEADER }, ...anchor.content, {
      type: "text",
      text: ANCHOR_FOOTER,
    });
  }
  return [
    ...plan.preservedPrefixIndices.map((index) => messages[index]!),
    Message.make({
      id: plan.notice.id,
      role: "user",
      content,
      ...(providerMetadata == null ? {} : { providerMetadata }),
    }),
    ...messages.slice(plan.tailStartIndex),
  ];
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
