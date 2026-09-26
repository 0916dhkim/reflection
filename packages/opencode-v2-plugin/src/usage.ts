import { createHash } from "node:crypto";
import { types } from "node:util";
import type { Message } from "@opencode/ai";
import { z } from "zod";
import type { NativeCanonicalRecord } from "@reflection/opencode-v2-core/history";
import { estimateNativeTokens } from "@reflection/opencode-v2-core/projection";
import { estimateMessages } from "./projection.js";

type Model = { id: string; providerID: string; variant?: string };
// Persist only hashes and identities. Strict, bounded decoding prevents a corrupt
// storage entry from becoming a usage anchor (or an unbounded allocation).
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const hashes = z.array(hash).max(8192);
const anchorSchema = z
  .object({
    id: hash,
    raw: hash,
    message: hash,
    before: hashes,
    after: hashes,
  })
  .strict();
const stateSchema = z
  .object({
    config: hash,
    messages: hashes,
    anchor: anchorSchema.optional(),
  })
  .strict();
const envelopeSchema = z
  .object({
    version: z.literal(1),
    sourceId: z.string().min(1).max(500),
    sessionId: z.string().min(1).max(1024),
    directory: z.string().min(1).max(4096),
    state: stateSchema,
  })
  .strict();
type State = z.infer<typeof stateSchema>;

function validState(state: State): boolean {
  const anchor = state.anchor;
  if (!anchor) return true;
  const index = anchor.before.length;
  return (
    state.messages.length === index + 1 + anchor.after.length &&
    state.messages[index] === anchor.message &&
    same(state.messages.slice(0, index), anchor.before) &&
    same(state.messages.slice(index + 1), anchor.after)
  );
}

function boundedEnvelope(value: unknown): boolean {
  const envelope = fields(value);
  const state = fields(envelope?.state);
  const anchor = fields(state?.anchor);
  const strings = [
    envelope?.sourceId,
    envelope?.sessionId,
    envelope?.directory,
    state?.config,
    anchor?.id,
    anchor?.raw,
    anchor?.message,
  ];
  if (
    strings.some(
      (item) =>
        item !== undefined && (typeof item !== "string" || item.length > 4096),
    )
  )
    return false;
  const arrays = [state?.messages, anchor?.before, anchor?.after];
  if (
    arrays.some(
      (item) =>
        item !== undefined && (!Array.isArray(item) || item.length > 8192),
    )
  )
    return false;
  return true;
}

function fields(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Hash actual provider-visible fields, including binary image bytes, without
 * calling foreign toJSON/accessors or retaining a copy of the payload. */
function fingerprint(value: unknown): string | undefined {
  try {
    const hash = createHash("sha256");
    const visiting = new Set<object>();
    const visit = (item: unknown): void => {
      if (
        item === null ||
        item === undefined ||
        typeof item === "boolean" ||
        typeof item === "number" ||
        typeof item === "string"
      ) {
        hash.update(JSON.stringify([typeof item, item ?? null]));
        return;
      }
      if (typeof item !== "object" || types.isProxy(item) || visiting.has(item))
        throw new Error("unhashable payload");
      if (ArrayBuffer.isView(item)) {
        hash.update(`bytes:${item.constructor.name}:${item.byteLength}:`);
        hash.update(Buffer.from(item.buffer, item.byteOffset, item.byteLength));
        return;
      }
      if (item instanceof ArrayBuffer) {
        hash.update(`buffer:${item.byteLength}:`);
        hash.update(Buffer.from(item));
        return;
      }
      visiting.add(item);
      try {
        const descriptors = Object.getOwnPropertyDescriptors(item);
        const keys = Reflect.ownKeys(descriptors);
        if (
          keys.some(
            (key) => typeof key !== "string" || !("value" in descriptors[key]!),
          )
        )
          throw new Error("unhashable payload");
        if (Array.isArray(item)) {
          hash.update(`array:${item.length}:`);
          for (let index = 0; index < item.length; index++)
            visit(descriptors[String(index)]?.value);
        } else {
          hash.update("object:");
          for (const key of (keys as string[]).sort()) {
            hash.update(JSON.stringify(key));
            visit(descriptors[key]!.value);
          }
        }
        hash.update(Array.isArray(item) ? "]" : "}");
      } finally {
        visiting.delete(item);
      }
    };
    visit(value);
    return hash.digest("hex");
  } catch {
    return;
  }
}

function messageHashes(messages: readonly Message[]): string[] | undefined {
  const hashes = messages.map((message) =>
    fingerprint({
      id: message.id,
      role: message.role,
      content: message.content,
      metadata: message.metadata,
      providerMetadata: message.providerMetadata,
      native: message.native,
    }),
  );
  return hashes.every((hash): hash is string => hash !== undefined)
    ? hashes
    : undefined;
}

/** Match the pinned host's same-model assistant lowering (to-llm-message.ts).
 * Only optional undefined fields are interchangeable with missing fields; opaque
 * provider state and tool input must match in full. Unknown mappings fall back. */
function matchesFields(
  actual: unknown,
  expected: Record<string, unknown>,
): boolean {
  const value = fields(actual);
  if (!value) return false;
  const defined = (item: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(item).filter(([, value]) => value !== undefined),
    );
  const hash = fingerprint(defined(value));
  return hash !== undefined && hash === fingerprint(defined(expected));
}

function matchesAssistant(
  record: NativeCanonicalRecord,
  message: Message,
  provider: string,
): boolean {
  const raw = record.raw;
  if (!Array.isArray(raw.content)) return false;
  const metadata = (state: unknown) =>
    state === undefined ? undefined : { [provider]: state };
  const expected: Record<string, unknown>[] = [];
  for (const value of raw.content) {
    const part = fields(value);
    if (!part) return false;
    if (part.type === "text" || part.type === "reasoning") {
      if (
        typeof part.text !== "string" ||
        (part.state !== undefined && !fields(part.state))
      )
        return false;
      // The host drops empty text, but retains empty reasoning with provider state.
      if (
        part.text === "" &&
        (part.type === "text" || part.state === undefined)
      )
        continue;
      expected.push({
        type: part.type,
        text: part.text,
        providerMetadata: metadata(part.state),
      });
      continue;
    }
    if (
      part.type !== "tool" ||
      typeof part.id !== "string" ||
      typeof part.name !== "string"
    )
      return false;
    const state = fields(part.state);
    if (
      !state ||
      !["streaming", "running", "completed", "error"].includes(
        String(state.status),
      )
    )
      return false;
    let input = state.input;
    if (state.status === "streaming") {
      if (typeof input !== "string") return false;
      try {
        input = JSON.parse(input);
      } catch {
        /* Host retains incomplete JSON as text. */
      }
    } else if (!fields(input)) return false;
    if (part.executed !== undefined && typeof part.executed !== "boolean")
      return false;
    if (part.providerState !== undefined && !fields(part.providerState))
      return false;
    expected.push({
      type: "tool-call",
      id: part.id,
      name: part.name,
      input,
      providerExecuted: part.executed,
      providerMetadata: metadata(part.providerState),
    });
    // Hosted tool results live inside the assistant; local results are separate
    // messages and are charged as additions by the caller.
    if (
      part.executed !== true ||
      (state.status !== "completed" && state.status !== "error")
    )
      continue;
    const resultState = part.providerResultState ?? part.providerState;
    if (resultState !== undefined && !fields(resultState)) return false;
    let result: unknown;
    if (state.status === "completed") {
      if (!Array.isArray(state.content)) return false;
      const single =
        state.content.length === 1 ? fields(state.content[0]) : undefined;
      result =
        single?.type === "text"
          ? { type: "text", value: single.text }
          : { type: "content", value: state.content };
    } else {
      result = {
        type: "error",
        value: { error: state.error, content: state.content ?? [] },
      };
    }
    expected.push({
      type: "tool-result",
      id: part.id,
      name: part.name,
      result,
      providerExecuted: part.executed,
      providerMetadata: metadata(resultState),
    });
  }
  return (
    expected.length > 0 &&
    expected.length === message.content.length &&
    expected.every((part, index) =>
      matchesFields(message.content[index], part),
    ) &&
    matchesFields(
      {
        metadata: message.metadata,
        providerMetadata: message.providerMetadata,
        native: message.native,
      },
      { metadata: raw.metadata },
    )
  );
}

function usage(record: NativeCanonicalRecord): number | undefined {
  const raw = record.raw;
  const time = fields(raw.time);
  const tokens = fields(raw.tokens);
  const cache = fields(tokens?.cache);
  if (
    raw.type !== "assistant" ||
    !record.complete ||
    typeof time?.completed !== "number" ||
    !Number.isFinite(time.completed) ||
    raw.error != null ||
    !tokens ||
    !cache
  )
    return;
  const values = [
    tokens.input,
    cache.read,
    cache.write,
    tokens.output,
    tokens.reasoning,
  ];
  if (
    values.some(
      (value) =>
        typeof value !== "number" || !Number.isFinite(value) || value < 0,
    ) ||
    typeof tokens.input !== "number" ||
    typeof cache.read !== "number" ||
    typeof cache.write !== "number" ||
    tokens.input + cache.read + cache.write <= 0
  )
    return;
  const total = values.reduce<number>(
    (sum, value) => sum + (value as number),
    0,
  );
  return Number.isFinite(total) ? total : undefined;
}

/** Per-plugin-instance, LRU bounded by sessions; no prompts or raw records persist. */
export class UsageTracker {
  private readonly sessions = new Map<string, State>();
  constructor(private readonly capacity = 64) {}

  has(session: string): boolean {
    return this.sessions.has(session);
  }

  /** Restore only into an empty slot; never replace a live LRU entry. The
   * restored hashes are hints, not authorization: prepare still validates the
   * current config, exact prefix/anchor and complete latest assistant usage. */
  restore(
    session: string,
    sourceId: string,
    directory: string,
    value: unknown,
  ): boolean {
    if (this.has(session)) return false;
    try {
      if (!boundedEnvelope(value)) return false;
      const parsed = envelopeSchema.safeParse(value);
      if (
        !parsed.success ||
        parsed.data.sourceId !== sourceId ||
        parsed.data.sessionId !== session ||
        parsed.data.directory !== directory ||
        !validState(parsed.data.state) ||
        parsed.data.state.messages.length +
          (parsed.data.state.anchor?.before.length ?? 0) +
          (parsed.data.state.anchor?.after.length ?? 0) >
          8192
      )
        return false;
      this.sessions.set(session, parsed.data.state);
      if (this.sessions.size > this.capacity) {
        this.sessions.delete(this.sessions.keys().next().value!);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** JSON-safe storage envelope, or undefined for an absent/unpersistable state.
   * A caller must remove an old entry when undefined is returned. */
  export(
    session: string,
    sourceId: string,
    directory: string,
  ): z.infer<typeof envelopeSchema> | undefined {
    const state = this.sessions.get(session);
    if (!state) return;
    const value = {
      version: 1,
      sourceId,
      sessionId: session,
      directory,
      state,
    };
    const parsed = envelopeSchema.safeParse(value);
    if (
      !parsed.success ||
      !validState(parsed.data.state) ||
      state.messages.length +
        (state.anchor?.before.length ?? 0) +
        (state.anchor?.after.length ?? 0) >
        8192
    )
      return;
    return parsed.data;
  }

  prepare(
    session: string,
    records: readonly NativeCanonicalRecord[],
    model: Model,
    system: unknown,
    tools: unknown,
    options: unknown,
  ) {
    const config = fingerprint({ model, system, tools, options });
    const previous = this.sessions.get(session);
    const latest = records.findLast(
      (record) => record.raw.type === "assistant",
    );
    const rawModel = fields(latest?.raw.model);
    const total = latest && usage(latest);
    const raw = latest && fingerprint(latest.raw);
    const assistantId = latest && fingerprint(latest.raw.id);
    const eligible =
      config !== undefined &&
      config === previous?.config &&
      latest &&
      raw &&
      assistantId &&
      total !== undefined &&
      rawModel?.providerID === model.providerID &&
      rawModel.id === model.id &&
      (rawModel.variant === undefined || rawModel.variant === model.variant);
    const estimate = (messages: readonly Message[]): number | undefined => {
      if (!eligible || !previous) return;
      const hashes = messageHashes(messages);
      if (!hashes) return;
      const matches = messages.flatMap((message, index) =>
        message.id === latest.raw.id && message.role === "assistant"
          ? [index]
          : [],
      );
      if (matches.length !== 1) return;
      const index = matches[0]!;
      const before = hashes.slice(0, index);
      const after = hashes.slice(index + 1);
      if (previous.anchor?.id === assistantId) {
        if (
          previous.anchor.raw !== raw ||
          previous.anchor.message !== hashes[index] ||
          !same(before, previous.anchor.before) ||
          !same(
            after.slice(0, previous.anchor.after.length),
            previous.anchor.after,
          ) ||
          !matchesAssistant(latest, messages[index]!, model.providerID)
        )
          return;
      } else if (
        !same(before, previous.messages) ||
        !matchesAssistant(latest, messages[index]!, model.providerID)
      )
        return;
      const added = estimateMessages(messages.slice(index + 1)).reduce(
        (sum, message) =>
          sum +
          8 +
          estimateNativeTokens({
            role: message.role,
            content: message.content,
          }),
        0,
      );
      return total + added;
    };
    const remember = (messages: readonly Message[]) => {
      const hashes = config && messageHashes(messages);
      if (!config || !hashes) {
        this.sessions.delete(session);
        return;
      }
      const matches = eligible
        ? messages.flatMap((message, index) =>
            message.id === latest.raw.id && message.role === "assistant"
              ? [index]
              : [],
          )
        : [];
      const index =
        matches.length === 1 && estimate(messages) !== undefined
          ? matches[0]
          : undefined;
      const anchor =
        index === undefined
          ? undefined
          : {
              id: assistantId!,
              raw: raw!,
              message: hashes[index]!,
              before: hashes.slice(0, index),
              after: hashes.slice(index + 1),
            };
      this.sessions.delete(session);
      this.sessions.set(session, { config, messages: hashes, anchor });
      if (this.sessions.size > this.capacity)
        this.sessions.delete(this.sessions.keys().next().value!);
    };
    return { estimate, remember };
  }

  delete(session: string) {
    this.sessions.delete(session);
  }
  clear() {
    this.sessions.clear();
  }
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
