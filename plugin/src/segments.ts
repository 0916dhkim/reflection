export const DEFAULT_MAX_SEGMENT_CHARS = 20_000;
const MEDIA_TOKEN_RESERVE = 8_000;
const MEDIA_BYTES_PER_TOKEN = 2;
const ESTIMATED_CHARS_PER_TOKEN = 4;
export const PROJECTION_LOSS_WARNING =
  "Reflection compacted older context with omissions. Some archived details are unavailable in this prompt; use memory_search and memory_read_segment when exact history matters.";
export const PROJECTION_LOSS_WARNING_METADATA = {
  reflection: { type: "projection-loss-warning", version: 1 },
};

export interface OpenCodeMessage {
  info: {
    id: string;
    sessionID?: string;
    role: "user" | "assistant";
    parentID?: string;
    model?: {
      providerID: string;
      modelID: string;
      variant?: string;
    };
    [key: string]: unknown;
  };
  parts: ReadonlyArray<{
    type: string;
    text?: string;
    tool?: string;
    state?: unknown;
    synthetic?: boolean;
    filename?: string;
    mime?: string;
    url?: string;
    [key: string]: unknown;
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

export interface CommittedSegmentBoundary {
  id?: string;
  startUserMessageId: string;
  endUserMessageId: string;
  projectionVersion?: number;
  sourceEligible?: boolean;
  sourceFingerprint?: string;
}

type OpenCodePart = OpenCodeMessage["parts"][number];

interface IndexedMessage {
  index: number;
  message: OpenCodeMessage;
}

interface CompleteTurn {
  userMessageId: string;
  charCount: number;
  messages: IndexedMessage[];
}

interface IndexedBoundary extends CommittedSegmentBoundary {
  startIndex: number;
  endIndex: number;
}

function hasExactWarningMetadata(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const metadata = value as Record<string, unknown>;
  if (Object.keys(metadata).length !== 1 || !("reflection" in metadata)) {
    return false;
  }
  const reflection = metadata.reflection;
  if (
    typeof reflection !== "object" ||
    reflection === null ||
    Array.isArray(reflection)
  ) {
    return false;
  }
  const marker = reflection as Record<string, unknown>;
  return (
    Object.keys(marker).length === 2 &&
    marker.type === "projection-loss-warning" &&
    marker.version === 1
  );
}

export function isProjectionLossWarningMessage(
  message: OpenCodeMessage,
): boolean {
  if (message.info.role !== "user" || message.parts.length !== 1) return false;
  const part = message.parts[0];
  return (
    part?.type === "text" &&
    part.text === PROJECTION_LOSS_WARNING &&
    part.synthetic === false &&
    part.ignored === false &&
    hasExactWarningMetadata(part.metadata)
  );
}

export function isNormalUserMessage(message: OpenCodeMessage): boolean {
  return (
    message.info.role === "user" &&
    !isProjectionLossWarningMessage(message) &&
    !message.parts.some((part) => part.type === "compaction")
  );
}

export function isModelVisibleMessage(message: OpenCodeMessage): boolean {
  if (message.info.role === "user") return true;
  if (!message.info.error) return true;
  // OpenCode V1 hides generic errors, but retains interrupted output with content.
  const error = message.info.error;
  const name =
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
      ? error.name
      : undefined;
  return (
    name === "MessageAbortedError" &&
    message.parts.some(
      (part) => part.type !== "step-start" && part.type !== "reasoning",
    )
  );
}

export function isModelVisiblePart(
  message: OpenCodeMessage,
  part: OpenCodePart,
): boolean {
  // OpenCode V1 applies `ignored` only while converting user parts.
  return (
    isModelVisibleMessage(message) &&
    (message.info.role === "assistant" || part.ignored !== true)
  );
}

export function textOf(message: OpenCodeMessage): string {
  if (isProjectionLossWarningMessage(message)) return "";
  if (!isModelVisibleMessage(message)) return "";
  return message.parts
    .flatMap((part) => {
      if (!isModelVisiblePart(message, part)) return [];
      if (part.type === "text") {
        return [part.text ?? ""];
      }
      if (part.type === "file") {
        const name = part.filename ? ` ${part.filename.slice(0, 500)}` : "";
        const mime = part.mime ? ` (${part.mime.slice(0, 200)})` : "";
        return [`[Attachment${name}${mime}]`];
      }
      return [];
    })
    .join("");
}

function turns(messages: readonly OpenCodeMessage[]): CompleteTurn[] {
  const users = new Map<string, CompleteTurn>();
  const turns: CompleteTurn[] = [];

  messages.forEach((message, index) => {
    if (!isNormalUserMessage(message)) return;
    const turn: CompleteTurn = {
      userMessageId: message.info.id,
      charCount: modelVisibleCharWeightOf(message),
      messages: [{ index, message }],
    };
    users.set(message.info.id, turn);
    turns.push(turn);
  });

  messages.forEach((message, index) => {
    if (
      message.info.role !== "assistant" ||
      !message.info.parentID ||
      !isModelVisibleMessage(message)
    ) {
      return;
    }
    const turn = users.get(message.info.parentID);
    if (!turn) return;
    turn.messages.push({ index, message });
    turn.charCount += modelVisibleCharWeightOf(message);
  });

  return turns;
}

function sanitizeModelValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[nested value omitted]";
  if (typeof value === "string") {
    return value.startsWith("data:") ? "[data URL omitted]" : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeModelValue(item, depth + 1));
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sanitizeModelValue(item, depth + 1),
    ]),
  );
}

export function modelVisibleToolState(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return sanitizeModelValue(value);
  }
  const state = value as Record<string, unknown>;
  const time =
    typeof state.time === "object" && state.time !== null
      ? (state.time as Record<string, unknown>)
      : {};
  return sanitizeModelValue(
    typeof time.compacted === "number"
      ? { ...state, output: "[Old tool result content cleared]" }
      : state,
  );
}

function serializedLength(value: unknown): number {
  try {
    return (JSON.stringify(value) ?? "null").length;
  } catch {
    return "[unserializable value]".length;
  }
}

function dataUrlBytes(url: string): number | null {
  if (!url.startsWith("data:")) return null;
  const separator = url.indexOf(",");
  if (separator < 0) return null;
  const metadata = url.slice(0, separator);
  const payload = url.slice(separator + 1);
  return metadata.endsWith(";base64")
    ? Math.ceil((payload.length * 3) / 4)
    : Buffer.byteLength(payload, "utf8");
}

export function modelVisibleMediaTokens(value: unknown): number {
  if (typeof value !== "object" || value === null)
    return Number.POSITIVE_INFINITY;
  const media = value as Record<string, unknown>;
  const mime = typeof media.mime === "string" ? media.mime : "";
  if (mime.startsWith("image/")) return MEDIA_TOKEN_RESERVE;
  if (typeof media.url !== "string") return Number.POSITIVE_INFINITY;
  const bytes = dataUrlBytes(media.url);
  return bytes === null
    ? Number.POSITIVE_INFINITY
    : Math.max(MEDIA_TOKEN_RESERVE, Math.ceil(bytes / MEDIA_BYTES_PER_TOKEN));
}

export function modelVisibleToolAttachmentTokens(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  const state = value as Record<string, unknown>;
  const time =
    typeof state.time === "object" && state.time !== null
      ? (state.time as Record<string, unknown>)
      : {};
  if (
    state.status !== "completed" ||
    typeof time.compacted === "number" ||
    !Array.isArray(state.attachments)
  ) {
    return 0;
  }
  return state.attachments.reduce(
    (total, attachment) => total + modelVisibleMediaTokens(attachment),
    0,
  );
}

export function modelVisibleCharWeightOf(message: OpenCodeMessage): number {
  if (!isModelVisibleMessage(message)) return 0;
  let weight = 0;
  for (const part of message.parts) {
    if (!isModelVisiblePart(message, part)) continue;
    if (part.type === "text" || part.type === "reasoning") {
      weight += part.text?.length ?? 0;
      continue;
    }
    if (part.type === "tool") {
      weight +=
        (part.tool?.length ?? 0) +
        serializedLength(modelVisibleToolState(part.state));
      weight +=
        modelVisibleToolAttachmentTokens(part.state) *
        ESTIMATED_CHARS_PER_TOKEN;
      continue;
    }
    if (part.type === "file") {
      weight += modelVisibleMediaTokens(part) * ESTIMATED_CHARS_PER_TOKEN;
    }
  }
  return weight;
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
  committedBoundaries: readonly CommittedSegmentBoundary[] = [],
): ReflectionSegment[] {
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error("maxChars must be a positive integer");
  }

  const completeTurns = turns(messages);
  const selectedBoundaries = reconcileSegmentBoundaries(
    completeTurns,
    committedBoundaries,
  );
  const segments: ReflectionSegment[] = [];
  let cursor = 0;
  for (const boundary of selectedBoundaries) {
    packTurns(
      completeTurns.slice(cursor, boundary.startIndex),
      maxChars,
      true,
      segments,
    );
    segments.push(
      makeSegment(
        completeTurns.slice(boundary.startIndex, boundary.endIndex + 1),
        true,
      ),
    );
    cursor = boundary.endIndex + 1;
  }
  packTurns(completeTurns.slice(cursor), maxChars, false, segments);
  return segments;
}

function packTurns(
  completeTurns: readonly CompleteTurn[],
  maxChars: number,
  forceClosed: boolean,
  segments: ReflectionSegment[],
): void {
  let current: CompleteTurn[] = [];
  let currentChars = 0;

  for (const turn of completeTurns) {
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

  if (current.length > 0) segments.push(makeSegment(current, forceClosed));
}

function betterBoundaryPlan(
  left: readonly IndexedBoundary[],
  right: readonly IndexedBoundary[],
): readonly IndexedBoundary[] {
  const score = (items: readonly IndexedBoundary[]) => ({
    coverage: items.reduce(
      (total, item) => total + item.endIndex - item.startIndex + 1,
      0,
    ),
    eligible: items.filter((item) => item.sourceEligible).length,
    version: items.reduce(
      (total, item) => total + (item.projectionVersion ?? 0),
      0,
    ),
    key: items
      .map(
        (item) =>
          `${item.startUserMessageId}:${item.endUserMessageId}:${item.id ?? ""}`,
      )
      .join("|"),
  });
  const a = score(left);
  const b = score(right);
  if (a.coverage !== b.coverage) return a.coverage > b.coverage ? left : right;
  if (a.eligible !== b.eligible) return a.eligible > b.eligible ? left : right;
  if (a.version !== b.version) return a.version > b.version ? left : right;
  return a.key <= b.key ? left : right;
}

function reconcileSegmentBoundaries(
  completeTurns: readonly CompleteTurn[],
  boundaries: readonly CommittedSegmentBoundary[],
): readonly IndexedBoundary[] {
  const userIndexes = new Map(
    completeTurns.map((turn, index) => [turn.userMessageId, index]),
  );
  const candidates = boundaries
    .flatMap((boundary): IndexedBoundary[] => {
      const startIndex = userIndexes.get(boundary.startUserMessageId);
      const endIndex = userIndexes.get(boundary.endUserMessageId);
      return startIndex === undefined ||
        endIndex === undefined ||
        startIndex > endIndex
        ? []
        : [{ ...boundary, startIndex, endIndex }];
    })
    .sort(
      (left, right) =>
        left.endIndex - right.endIndex ||
        left.startIndex - right.startIndex ||
        (left.id ?? "").localeCompare(right.id ?? ""),
    );
  const plans: Array<readonly IndexedBoundary[]> = [[]];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) continue;
    let previous = index - 1;
    while (
      previous >= 0 &&
      candidates[previous]!.endIndex >= candidate.startIndex
    ) {
      previous -= 1;
    }
    const included = [...(plans[previous + 1] ?? []), candidate];
    plans[index + 1] = betterBoundaryPlan(plans[index] ?? [], included);
  }
  return [...(plans.at(-1) ?? [])].sort(
    (left, right) => left.startIndex - right.startIndex,
  );
}

export function readSegmentMessages(
  messages: readonly OpenCodeMessage[],
  startUserMessageId: string,
  endUserMessageId: string,
): ReflectionMessage[] {
  const startIndex = messages.findIndex(
    (message) =>
      isNormalUserMessage(message) && message.info.id === startUserMessageId,
  );
  const endIndex = messages.findIndex(
    (message) =>
      isNormalUserMessage(message) && message.info.id === endUserMessageId,
  );

  if (startIndex < 0 || endIndex < 0)
    throw new Error("Segment user boundary was not found");
  if (startIndex > endIndex)
    throw new Error("Segment user boundaries are out of order");

  const selectedTurns = turns(messages).filter(
    (turn) =>
      turn.messages[0].index >= startIndex &&
      turn.messages[0].index <= endIndex,
  );
  return reflectionMessages(selectedTurns);
}
