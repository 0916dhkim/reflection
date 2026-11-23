import { Message } from "@opencode/ai";

export const OMITTED_TURN_STUB = "[Turn omitted after provider rejection]";

const NON_CONTENT_4XX = new Set([401, 403, 404, 405, 407, 408, 429]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Deterministic provider rejections caused by request content/format/size.
 * Excludes transient failures, aborts, auth/billing, rate limits, and routing 404s. */
export function isRejectingRequestError(error: unknown): boolean {
  const item = record(error);
  if (!item) return false;
  const { type, status } = item;
  if (type === "provider.content-filter") return true;
  if (type !== "provider.invalid-request") return false;
  if (status === undefined) return true;
  return (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500 &&
    !NON_CONTENT_4XX.has(status)
  );
}

function rawAssistantHasTools(raw: Record<string, unknown>): boolean {
  return (
    Array.isArray(raw.content) &&
    raw.content.some((part) => record(part)?.type === "tool")
  );
}

function messageAssistantHasTools(
  messages: readonly Message[],
  index: number,
): boolean {
  const message = messages[index]!;
  if (
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === "tool-call")
  )
    return true;
  const next = messages[index + 1];
  return next !== undefined && next.role === "tool" && next.id === undefined;
}

/**
 * Identify message IDs whose turns preceded a deterministic provider rejection
 * without being accepted by any subsequent provider response, merged with
 * previously persisted omissions still present in `messages`.
 */
export function detectRejectedTurnIds(input: {
  history: readonly unknown[];
  messages: readonly Message[];
  historyAfterId: string | null;
  existing?: readonly string[];
}): string[] {
  const present = new Set<string>();
  const positions = new Map<string, number>();
  input.messages.forEach((message, index) => {
    if (message.id !== undefined) {
      present.add(message.id);
      positions.set(message.id, index);
    }
  });

  const omitted = new Set<string>();
  for (const id of input.existing ?? []) {
    if (present.has(id)) omitted.add(id);
  }

  const rawEntries = input.history.map(record);
  for (let i = 0; i < rawEntries.length; i++) {
    const entry = rawEntries[i];
    if (
      !entry ||
      entry.type !== "assistant" ||
      !isRejectingRequestError(entry.error)
    )
      continue;

    const failedId = typeof entry.id === "string" ? entry.id : undefined;
    if (failedId !== undefined && present.has(failedId)) omitted.add(failedId);

    let reachedStart = true;
    for (let j = i - 1; j >= 0; j--) {
      const prev = rawEntries[j];
      if (!prev) continue;
      const prevId = typeof prev.id === "string" ? prev.id : undefined;
      if (prev.type === "assistant") {
        if (isRejectingRequestError(prev.error)) {
          reachedStart = false;
          break;
        }
        if (prev.error != null) continue;
        if (rawAssistantHasTools(prev)) {
          if (prevId !== undefined && present.has(prevId)) omitted.add(prevId);
        }
        reachedStart = false;
        break;
      }
      if (prevId !== undefined && present.has(prevId)) omitted.add(prevId);
    }

    if (reachedStart && input.historyAfterId !== null) {
      const anchorPos = positions.get(input.historyAfterId);
      if (anchorPos !== undefined) {
        for (let k = anchorPos; k >= 0; k--) {
          const message = input.messages[k]!;
          if (message.role === "tool") continue;
          if (message.role === "assistant") {
            if (
              messageAssistantHasTools(input.messages, k) &&
              message.id !== undefined
            )
              omitted.add(message.id);
            break;
          }
          if (message.id !== undefined) omitted.add(message.id);
        }
      }
    }
  }

  return [...omitted];
}

/**
 * Replace each omitted turn in `messages` with a single neutral text stub,
 * dropping attached tool-result messages for omitted assistant tool calls so
 * call/result pairing remains valid on the wire.
 */
export function applyOmittedTurns(
  messages: readonly Message[],
  omittedIds: ReadonlySet<string>,
): Message[] | readonly Message[] {
  if (omittedIds.size === 0) return messages;
  const droppedCalls = new Set<string>();
  let changed = false;
  for (const message of messages) {
    if (message.id !== undefined && omittedIds.has(message.id)) {
      changed = true;
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "tool-call") droppedCalls.add(part.id);
        }
      }
    }
  }
  if (!changed) return messages;

  const result: Message[] = [];
  let skipFollowingTools = false;
  for (const message of messages) {
    if (message.id !== undefined && omittedIds.has(message.id)) {
      skipFollowingTools = message.role === "assistant";
      result.push(
        Message.make({
          id: message.id,
          role:
            message.role === "assistant" || message.role === "system"
              ? message.role
              : "user",
          content: [{ type: "text", text: OMITTED_TURN_STUB }],
        }),
      );
      continue;
    }
    if (message.role === "tool") {
      if (skipFollowingTools && message.id === undefined) continue;
      if (droppedCalls.size > 0 && Array.isArray(message.content)) {
        const kept = message.content.filter(
          (part) => part.type !== "tool-result" || !droppedCalls.has(part.id),
        );
        if (kept.length === 0) continue;
        if (kept.length !== message.content.length) {
          result.push(Message.make({ ...message, content: kept }));
          continue;
        }
      }
    } else {
      skipFollowingTools = false;
    }
    result.push(message);
  }
  return result;
}
