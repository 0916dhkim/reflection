import {
  isNormalUserMessage,
  type OpenCodeMessage,
} from "@reflection/shared/segmentation";

/**
 * Tool attachments are re-serialized into every subsequent request, so a
 * session that produces screenshots accumulates binary payload without bound.
 * Only the newest turns need the images inline: the model has already read the
 * older ones, they cost far more wire bytes than context tokens, and a tool can
 * be re-run to recover one.
 */
export const DEFAULT_ATTACHMENT_LAG_TURNS = 1;

type ToolPartState = {
  attachments?: unknown;
  output?: unknown;
};

function attachmentsOf(part: unknown): unknown[] {
  if (typeof part !== "object" || part === null) return [];
  const candidate = part as { type?: unknown; state?: unknown };
  if (candidate.type !== "tool") return [];
  const state = candidate.state;
  if (typeof state !== "object" || state === null) return [];
  const attachments = (state as ToolPartState).attachments;
  return Array.isArray(attachments) ? attachments : [];
}

function describe(attachment: unknown): string {
  if (typeof attachment !== "object" || attachment === null) {
    return "[Attached file omitted by Reflection]";
  }
  const item = attachment as { mime?: unknown; filename?: unknown };
  const mime = typeof item.mime === "string" ? item.mime : "file";
  const filename =
    typeof item.filename === "string" && item.filename.length > 0
      ? item.filename
      : "file";
  return `[Attached ${mime}: ${filename} omitted by Reflection; re-run the tool to view it]`;
}

function stripPart(part: unknown, attachments: readonly unknown[]): unknown {
  const source = part as { state?: unknown };
  const state = source.state as ToolPartState;
  // Prepended, not appended: opencode truncates tool output to
  // `toolOutputMaxChars` from the end, which would drop a trailing notice.
  const notice = attachments.map(describe).join("\n");
  const output =
    typeof state.output === "string"
      ? `${notice}\n${state.output}`
      : state.output;
  return {
    ...(source as Record<string, unknown>),
    state: { ...state, attachments: [], output },
  };
}

/**
 * Replaces tool attachments outside the newest `lagTurns` user turns with a
 * text placeholder. Returns the input array when nothing changes, and copies
 * only the messages and parts it rewrites: the caller's messages are shared
 * with the projection cache and with opencode's own message store.
 */
export function stripStaleToolAttachments(
  messages: readonly OpenCodeMessage[],
  lagTurns: number = DEFAULT_ATTACHMENT_LAG_TURNS,
): readonly OpenCodeMessage[] {
  if (!Number.isInteger(lagTurns) || lagTurns < 0) {
    throw new Error("Attachment lag must be a non-negative integer");
  }
  const turnStarts = messages.flatMap((message, index) =>
    isNormalUserMessage(message) ? [index] : [],
  );
  if (turnStarts.length <= lagTurns) return messages;
  const boundary = turnStarts[turnStarts.length - lagTurns];
  if (boundary === undefined) return messages;

  let changed = false;
  const projected = messages.map((message, index) => {
    if (index >= boundary) return message;
    if (!message.parts.some((part) => attachmentsOf(part).length > 0)) {
      return message;
    }
    changed = true;
    return {
      ...message,
      parts: message.parts.map((part) => {
        const attachments = attachmentsOf(part);
        return attachments.length > 0
          ? (stripPart(part, attachments) as (typeof message.parts)[number])
          : part;
      }),
    };
  });
  return changed ? projected : messages;
}
