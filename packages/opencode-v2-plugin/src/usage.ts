import { createHash } from "node:crypto";
import { types } from "node:util";
import type { Message } from "@opencode/ai";
import type { NativeCanonicalRecord } from "@reflection/opencode-v2-core/history";
import { estimateNativeTokens } from "@reflection/opencode-v2-core/projection";
import { estimateMessages } from "./projection.js";

type Model = { id: string; providerID: string; variant?: string };
type State = {
  config: string;
  messages: string[];
  anchor?: {
    id: string;
    raw: string;
    message: string;
    before: string[];
    after: string[];
  };
};

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
    const eligible =
      config !== undefined &&
      config === previous?.config &&
      latest &&
      raw &&
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
      if (previous.anchor?.id === latest.raw.id) {
        if (
          previous.anchor.raw !== raw ||
          previous.anchor.message !== hashes[index] ||
          !same(before, previous.anchor.before) ||
          !same(
            after.slice(0, previous.anchor.after.length),
            previous.anchor.after,
          )
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
              id: latest!.raw.id,
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
