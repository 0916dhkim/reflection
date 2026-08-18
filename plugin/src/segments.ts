export const DEFAULT_MAX_SEGMENT_CHARS = 20_000;

export interface OpenCodeMessage {
  info: {
    id: string;
    role: "user" | "assistant";
    parentID?: string;
  };
  parts: ReadonlyArray<{
    type: string;
    text?: string;
  }>;
}

export interface ReflectionMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ReflectionSegment {
  startUserMessageId: string;
  endUserMessageId: string;
  charCount: number;
  closed: boolean;
  messages: ReflectionMessage[];
}

interface IndexedMessage {
  index: number;
  message: OpenCodeMessage;
}

interface CompleteTurn {
  userMessageId: string;
  charCount: number;
  messages: IndexedMessage[];
}

export function textOf(message: OpenCodeMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function completeTurns(messages: readonly OpenCodeMessage[]): CompleteTurn[] {
  const users = new Map<string, CompleteTurn>();
  const turns: CompleteTurn[] = [];

  messages.forEach((message, index) => {
    if (message.info.role !== "user") return;
    const turn: CompleteTurn = {
      userMessageId: message.info.id,
      charCount: textOf(message).length,
      messages: [{ index, message }],
    };
    users.set(message.info.id, turn);
    turns.push(turn);
  });

  const completed = new Set<string>();
  messages.forEach((message, index) => {
    if (message.info.role !== "assistant" || !message.info.parentID) return;
    const turn = users.get(message.info.parentID);
    if (!turn) return;
    turn.messages.push({ index, message });
    turn.charCount += textOf(message).length;
    completed.add(turn.userMessageId);
  });

  return turns.filter((turn) => completed.has(turn.userMessageId));
}

function reflectionMessages(
  turns: readonly CompleteTurn[],
): ReflectionMessage[] {
  return turns
    .flatMap((turn) => turn.messages)
    .sort((a, b) => a.index - b.index)
    .map(({ message }) => ({
      role: message.info.role,
      text: textOf(message),
    }));
}

function makeSegment(
  turns: readonly CompleteTurn[],
  closed: boolean,
): ReflectionSegment {
  return {
    startUserMessageId: turns[0].userMessageId,
    endUserMessageId: turns[turns.length - 1].userMessageId,
    charCount: turns.reduce((total, turn) => total + turn.charCount, 0),
    closed,
    messages: reflectionMessages(turns),
  };
}

export function segmentMessages(
  messages: readonly OpenCodeMessage[],
  maxChars = DEFAULT_MAX_SEGMENT_CHARS,
): ReflectionSegment[] {
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error("maxChars must be a positive integer");
  }

  const segments: ReflectionSegment[] = [];
  let current: CompleteTurn[] = [];
  let currentChars = 0;

  for (const turn of completeTurns(messages)) {
    if (turn.charCount > maxChars) {
      if (current.length > 0) segments.push(makeSegment(current, true));
      segments.push(makeSegment([turn], true));
      current = [];
      currentChars = 0;
      continue;
    }

    if (current.length > 0 && currentChars + turn.charCount > maxChars) {
      segments.push(makeSegment(current, true));
      current = [];
      currentChars = 0;
    }

    current.push(turn);
    currentChars += turn.charCount;
    if (currentChars === maxChars) {
      segments.push(makeSegment(current, true));
      current = [];
      currentChars = 0;
    }
  }

  if (current.length > 0) segments.push(makeSegment(current, false));
  return segments;
}

export function readSegmentMessages(
  messages: readonly OpenCodeMessage[],
  startUserMessageId: string,
  endUserMessageId: string,
): ReflectionMessage[] {
  const startIndex = messages.findIndex(
    (message) =>
      message.info.role === "user" && message.info.id === startUserMessageId,
  );
  const endIndex = messages.findIndex(
    (message) =>
      message.info.role === "user" && message.info.id === endUserMessageId,
  );

  if (startIndex < 0 || endIndex < 0)
    throw new Error("Segment user boundary was not found");
  if (startIndex > endIndex)
    throw new Error("Segment user boundaries are out of order");

  const turns = completeTurns(messages).filter(
    (turn) =>
      turn.messages[0].index >= startIndex &&
      turn.messages[0].index <= endIndex,
  );
  return reflectionMessages(turns);
}
