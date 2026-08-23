import { sourceFingerprint } from "./domain.js";

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
  sourceBoundaryVersion: 1 | 2;
  startSourceMessageId: string | null;
  endSourceMessageId: string | null;
  startMessageId: string;
  endMessageId: string;
  sourceMessageIds: string[];
  charCount: number;
  closed: boolean;
  messages: ReflectionMessage[];
}

interface CommittedSegmentBoundaryBase {
  id?: string;
  startUserMessageId: string;
  endUserMessageId: string;
  projectionVersion?: number;
  sourceEligible?: boolean;
  sourceFingerprint?: string;
}

export type CommittedSegmentBoundary = CommittedSegmentBoundaryBase &
  (
    | {
        sourceBoundaryVersion: 1;
        startSourceMessageId: null;
        endSourceMessageId: null;
      }
    | {
        sourceBoundaryVersion: 2;
        startSourceMessageId: string;
        endSourceMessageId: string;
      }
  );

export function submissionSourceFingerprint(
  sessionId: string,
  segment: ReflectionSegment,
): string {
  const common = {
    session_id: sessionId,
    start_user_message_id: segment.startUserMessageId,
    end_user_message_id: segment.endUserMessageId,
    projection_version: 0 as const,
    processing_priority: 0,
    messages: segment.messages,
  };
  if (segment.sourceBoundaryVersion === 1) {
    if (
      segment.startSourceMessageId !== null ||
      segment.endSourceMessageId !== null
    ) {
      throw new Error("V1 segments cannot contain source cursors");
    }
    return sourceFingerprint({
      ...common,
      source_boundary_version: 1,
      start_source_message_id: null,
      end_source_message_id: null,
    });
  }
  if (
    segment.startSourceMessageId === null ||
    segment.endSourceMessageId === null
  ) {
    throw new Error("V2 segments require both source cursors");
  }
  return sourceFingerprint({
    ...common,
    source_boundary_version: 2,
    start_source_message_id: segment.startSourceMessageId,
    end_source_message_id: segment.endSourceMessageId,
  });
}

type OpenCodePart = OpenCodeMessage["parts"][number];

interface IndexedMessage {
  index: number;
  sourceIndex: number;
  turnIndex: number;
  message: OpenCodeMessage;
}

interface CompleteTurn {
  index: number;
  userMessageId: string;
  charCount: number;
  closed: boolean;
  messages: IndexedMessage[];
}

interface CanonicalHistory {
  turns: CompleteTurn[];
  messages: IndexedMessage[];
}

interface IndexedV1Boundary {
  boundary: CommittedSegmentBoundary;
  startIndex: number;
  endIndex: number;
}

interface IndexedV2Boundary {
  boundary: CommittedSegmentBoundary & { sourceBoundaryVersion: 2 };
  turnIndex: number;
  startIndex: number;
  endIndex: number;
  startOffset: number;
  endOffset: number;
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
    (message.info.role === "assistant" || part.ignored !== true) &&
    !(
      message.info.role === "user" &&
      part.type === "file" &&
      (part.mime === "text/plain" || part.mime === "application/x-directory")
    )
  );
}

export function isCompletedAssistantMessage(
  message: OpenCodeMessage | undefined,
): boolean {
  if (!message || message.info.role !== "assistant") return false;
  const time = message.info.time;
  if (typeof time !== "object" || time === null || Array.isArray(time)) {
    return false;
  }
  return Number.isFinite((time as Record<string, unknown>).completed);
}

export function isSafeSegmentSnapshot(
  segment: ReflectionSegment,
  messages: readonly OpenCodeMessage[],
): boolean {
  if (segment.closed || segment.sourceBoundaryVersion === 1) return true;
  if (segment.endSourceMessageId === null) return false;
  return isCompletedAssistantMessage(
    messages.find((message) => message.info.id === segment.endSourceMessageId),
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

function canonicalHistory(
  messages: readonly OpenCodeMessage[],
): CanonicalHistory {
  const users = new Map<string, CompleteTurn>();
  const completeTurns: CompleteTurn[] = [];

  messages.forEach((message) => {
    if (!isNormalUserMessage(message)) return;
    const turn: CompleteTurn = {
      index: completeTurns.length,
      userMessageId: message.info.id,
      charCount: 0,
      closed: false,
      messages: [],
    };
    users.set(message.info.id, turn);
    completeTurns.push(turn);
  });

  const sourceMessages: IndexedMessage[] = [];
  messages.forEach((message, index) => {
    let turn: CompleteTurn | undefined;
    if (isNormalUserMessage(message)) {
      turn = users.get(message.info.id);
    } else if (
      message.info.role === "assistant" &&
      message.info.parentID &&
      isModelVisibleMessage(message)
    ) {
      turn = users.get(message.info.parentID);
    }
    if (!turn) return;
    const indexed = {
      index,
      sourceIndex: sourceMessages.length,
      turnIndex: turn.index,
      message,
    };
    sourceMessages.push(indexed);
    turn.messages.push(indexed);
    turn.charCount += modelVisibleCharWeightOf(message);
  });

  completeTurns.forEach((turn, index) => {
    turn.closed = index < completeTurns.length - 1;
  });
  return { turns: completeTurns, messages: sourceMessages };
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
  return sanitizeModelValue(modelVisibleToolStateValue(value));
}

function modelVisibleToolStateValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const state = value as Record<string, unknown>;
  const time =
    typeof state.time === "object" && state.time !== null
      ? (state.time as Record<string, unknown>)
      : {};
  return typeof time.compacted === "number"
    ? { ...state, output: "[Old tool result content cleared]" }
    : state;
}

export function modelVisibleToolStateSize(value: unknown): {
  chars: number;
  utf8Bytes: number;
} {
  const visible = modelVisibleToolStateValue(value);
  const seen = new WeakSet<object>();
  try {
    const serialized =
      JSON.stringify(visible, function (key, item: unknown) {
        if (this === visible && key === "attachments") return undefined;
        if (typeof item === "string" && item.startsWith("data:")) {
          return "[data URL omitted]";
        }
        if (typeof item === "object" && item !== null) {
          if (seen.has(item)) throw new Error("cyclic tool state");
          seen.add(item);
        }
        return item;
      }) ?? "null";
    return {
      chars: serialized.length,
      utf8Bytes: Buffer.byteLength(serialized, "utf8"),
    };
  } catch {
    return {
      chars: Number.POSITIVE_INFINITY,
      utf8Bytes: Number.POSITIVE_INFINITY,
    };
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
  return state.attachments.reduce((total, attachment) => {
    if (typeof attachment !== "object" || attachment === null) return total;
    const item = attachment as Record<string, unknown>;
    const mime = typeof item.mime === "string" ? item.mime : "";
    const url = typeof item.url === "string" ? item.url : "";
    const validDataUrl = url.startsWith("data:") && url.includes(",");
    const hostMedia = mime.startsWith("image/") || mime === "application/pdf";
    return (
      total +
      (validDataUrl || (hostMedia && url.length > 0)
        ? modelVisibleMediaTokens(item)
        : 0)
    );
  }, 0);
}

function inlineDataUrlTokens(value: unknown): number {
  const pending: Array<{ value: unknown; root: boolean }> = [
    { value, root: true },
  ];
  const seen = new WeakSet<object>();
  let total = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (typeof current.value === "string") {
      if (!current.value.startsWith("data:")) continue;
      const bytes = dataUrlBytes(current.value);
      if (bytes === null) return Number.POSITIVE_INFINITY;
      total += Math.max(
        MEDIA_TOKEN_RESERVE,
        Math.ceil(bytes / MEDIA_BYTES_PER_TOKEN),
      );
      continue;
    }
    if (typeof current.value !== "object" || current.value === null) continue;
    if (seen.has(current.value)) return Number.POSITIVE_INFINITY;
    seen.add(current.value);
    for (const [key, item] of Object.entries(current.value)) {
      if (current.root && key === "attachments") continue;
      pending.push({ value: item, root: false });
    }
  }
  return total;
}

export function modelVisibleToolInlineDataTokens(value: unknown): number {
  if (typeof value !== "object" || value === null) {
    return inlineDataUrlTokens(value);
  }
  const state = value as Record<string, unknown>;
  const time =
    typeof state.time === "object" && state.time !== null
      ? (state.time as Record<string, unknown>)
      : {};
  return inlineDataUrlTokens(modelVisibleToolStateValue(value));
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
      const stateSize = modelVisibleToolStateSize(part.state);
      weight += (part.tool?.length ?? 0) + stateSize.chars;
      weight +=
        modelVisibleToolAttachmentTokens(part.state) *
        ESTIMATED_CHARS_PER_TOKEN;
      weight +=
        modelVisibleToolInlineDataTokens(part.state) *
        ESTIMATED_CHARS_PER_TOKEN;
      continue;
    }
    if (part.type === "file") {
      weight += modelVisibleMediaTokens(part) * ESTIMATED_CHARS_PER_TOKEN;
    }
  }
  return weight;
}

function orderedSourceMessages(
  sourceMessages: readonly IndexedMessage[],
): IndexedMessage[] {
  return [...sourceMessages].sort(
    (left, right) => left.sourceIndex - right.sourceIndex,
  );
}

function reflectionMessages(
  sourceMessages: readonly IndexedMessage[],
): ReflectionMessage[] {
  return orderedSourceMessages(sourceMessages).map(({ message }) => ({
    role: message.info.role,
    text: textOf(message),
  }));
}

function sourceEndpoints(sourceMessages: readonly IndexedMessage[]): {
  ordered: IndexedMessage[];
  first: IndexedMessage;
  last: IndexedMessage;
} {
  const ordered = orderedSourceMessages(sourceMessages);
  const first = ordered[0];
  const last = ordered.at(-1);
  if (!first || !last) throw new Error("Cannot create an empty segment");
  return { ordered, first, last };
}

function makeV1Segment(
  completeTurns: readonly CompleteTurn[],
  closed: boolean,
): ReflectionSegment {
  const firstTurn = completeTurns[0];
  const lastTurn = completeTurns.at(-1);
  if (!firstTurn || !lastTurn)
    throw new Error("Cannot create an empty segment");
  const { ordered, first, last } = sourceEndpoints(
    completeTurns.flatMap((turn) => turn.messages),
  );
  return {
    startUserMessageId: firstTurn.userMessageId,
    endUserMessageId: lastTurn.userMessageId,
    sourceBoundaryVersion: 1,
    startSourceMessageId: null,
    endSourceMessageId: null,
    startMessageId: first.message.info.id,
    endMessageId: last.message.info.id,
    sourceMessageIds: ordered.map(({ message }) => message.info.id),
    charCount: completeTurns.reduce((total, turn) => total + turn.charCount, 0),
    closed,
    messages: reflectionMessages(ordered),
  };
}

function makeV2Segment(
  turn: CompleteTurn,
  sourceMessages: readonly IndexedMessage[],
  closed: boolean,
): ReflectionSegment {
  const { ordered, first, last } = sourceEndpoints(sourceMessages);
  return {
    startUserMessageId: turn.userMessageId,
    endUserMessageId: turn.userMessageId,
    sourceBoundaryVersion: 2,
    startSourceMessageId: first.message.info.id,
    endSourceMessageId: last.message.info.id,
    startMessageId: first.message.info.id,
    endMessageId: last.message.info.id,
    sourceMessageIds: ordered.map(({ message }) => message.info.id),
    charCount: ordered.reduce(
      (total, item) => total + modelVisibleCharWeightOf(item.message),
      0,
    ),
    closed,
    messages: reflectionMessages(ordered),
  };
}

function boundaryVersion(boundary: CommittedSegmentBoundary): 1 | 2 {
  const value = (
    boundary as CommittedSegmentBoundary & {
      sourceBoundaryVersion?: unknown;
      startSourceMessageId?: unknown;
      endSourceMessageId?: unknown;
    }
  ).sourceBoundaryVersion;
  const startSourceMessageId = (boundary as { startSourceMessageId?: unknown })
    .startSourceMessageId;
  const endSourceMessageId = (boundary as { endSourceMessageId?: unknown })
    .endSourceMessageId;

  if (value === undefined || value === 1) {
    if (startSourceMessageId !== undefined && startSourceMessageId !== null) {
      throw new Error("V1 source boundaries cannot contain source cursors");
    }
    if (endSourceMessageId !== undefined && endSourceMessageId !== null) {
      throw new Error("V1 source boundaries cannot contain source cursors");
    }
    return 1;
  }
  if (value !== 2) throw new Error("Unsupported source boundary version");
  if (
    typeof startSourceMessageId !== "string" ||
    startSourceMessageId.trim().length === 0 ||
    typeof endSourceMessageId !== "string" ||
    endSourceMessageId.trim().length === 0
  ) {
    throw new Error("V2 source boundaries require both source cursors");
  }
  if (boundary.startUserMessageId !== boundary.endUserMessageId) {
    throw new Error("V2 source boundaries must stay within one user turn");
  }
  return 2;
}

interface BoundaryInterval {
  boundary: CommittedSegmentBoundary;
  startIndex: number;
  endIndex: number;
  key: string;
}

function betterBoundaryPlan<T extends BoundaryInterval>(
  left: readonly T[],
  right: readonly T[],
): readonly T[] {
  const score = (items: readonly T[]) => ({
    coverage: items.reduce(
      (total, item) => total + item.endIndex - item.startIndex + 1,
      0,
    ),
    eligible: items.filter((item) => item.boundary.sourceEligible).length,
    version: items.reduce(
      (total, item) => total + (item.boundary.projectionVersion ?? 0),
      0,
    ),
    key: items.map((item) => item.key).join("|"),
  });
  const a = score(left);
  const b = score(right);
  if (a.coverage !== b.coverage) return a.coverage > b.coverage ? left : right;
  if (a.eligible !== b.eligible) return a.eligible > b.eligible ? left : right;
  if (a.version !== b.version) return a.version > b.version ? left : right;
  return a.key <= b.key ? left : right;
}

function selectBoundaryIntervals<T extends BoundaryInterval>(
  candidates: readonly T[],
): T[] {
  const plans: Array<readonly T[]> = [[]];
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

function reconcileV1Boundaries(
  completeTurns: readonly CompleteTurn[],
  boundaries: readonly CommittedSegmentBoundary[],
): IndexedV1Boundary[] {
  const userIndexes = new Map(
    completeTurns.map((turn, index) => [turn.userMessageId, index]),
  );
  const candidates = boundaries
    .flatMap((boundary): Array<IndexedV1Boundary & BoundaryInterval> => {
      if (boundaryVersion(boundary) !== 1) return [];
      const startIndex = userIndexes.get(boundary.startUserMessageId);
      const endIndex = userIndexes.get(boundary.endUserMessageId);
      return startIndex === undefined ||
        endIndex === undefined ||
        startIndex > endIndex
        ? []
        : [
            {
              boundary,
              startIndex,
              endIndex,
              key: `${boundary.startUserMessageId}:${boundary.endUserMessageId}:${boundary.id ?? ""}`,
            },
          ];
    })
    .sort(
      (left, right) =>
        left.endIndex - right.endIndex ||
        left.startIndex - right.startIndex ||
        (left.boundary.id ?? "").localeCompare(right.boundary.id ?? ""),
    );
  return selectBoundaryIntervals(candidates).map(
    ({ boundary, startIndex, endIndex }) => ({
      boundary,
      startIndex,
      endIndex,
    }),
  );
}

function uniqueSourceIndexes(
  sourceMessages: readonly IndexedMessage[],
): Map<string, number | null> {
  const indexes = new Map<string, number | null>();
  for (const sourceMessage of sourceMessages) {
    const id = sourceMessage.message.info.id;
    indexes.set(id, indexes.has(id) ? null : sourceMessage.sourceIndex);
  }
  return indexes;
}

function resolveV2Boundaries(
  history: CanonicalHistory,
  boundaries: readonly CommittedSegmentBoundary[],
): IndexedV2Boundary[] {
  const turnsByUser = new Map(
    history.turns.map((turn) => [turn.userMessageId, turn]),
  );
  const sourceIndexes = uniqueSourceIndexes(history.messages);
  return boundaries.flatMap((boundary): IndexedV2Boundary[] => {
    if (boundaryVersion(boundary) !== 2) return [];
    const current = boundary as CommittedSegmentBoundary & {
      sourceBoundaryVersion: 2;
      startSourceMessageId: string;
      endSourceMessageId: string;
    };
    const turn = turnsByUser.get(current.startUserMessageId);
    const startIndex = sourceIndexes.get(current.startSourceMessageId);
    const endIndex = sourceIndexes.get(current.endSourceMessageId);
    if (!turn || startIndex === undefined || endIndex === undefined) return [];
    if (startIndex === null || endIndex === null) {
      throw new Error("V2 source boundary is ambiguous");
    }
    if (startIndex > endIndex) {
      throw new Error("V2 source boundaries are out of order");
    }
    const exactSpan = history.messages.slice(startIndex, endIndex + 1);
    if (
      exactSpan.length === 0 ||
      exactSpan.some((message) => message.turnIndex !== turn.index)
    ) {
      throw new Error("V2 source boundary leaves its user turn");
    }
    const startOffset = turn.messages.findIndex(
      (message) => message.sourceIndex === startIndex,
    );
    const endOffset = turn.messages.findIndex(
      (message) => message.sourceIndex === endIndex,
    );
    if (startOffset < 0 || endOffset < 0 || startOffset > endOffset) {
      throw new Error("V2 source boundary does not match its user turn");
    }
    return [
      {
        boundary: current,
        turnIndex: turn.index,
        startIndex,
        endIndex,
        startOffset,
        endOffset,
      },
    ];
  });
}

function reconcileV2Boundaries(
  boundaries: readonly IndexedV2Boundary[],
  frozenTurns: ReadonlySet<number>,
): IndexedV2Boundary[] {
  const candidates = boundaries
    .filter((boundary) => !frozenTurns.has(boundary.turnIndex))
    .map((item) => ({
      ...item,
      key: `${item.boundary.startUserMessageId}:${item.boundary.endUserMessageId}:${item.boundary.startSourceMessageId}:${item.boundary.endSourceMessageId}:${item.boundary.id ?? ""}`,
    }))
    .sort(
      (left, right) =>
        left.endIndex - right.endIndex ||
        left.startIndex - right.startIndex ||
        (left.boundary.id ?? "").localeCompare(right.boundary.id ?? ""),
    );
  return selectBoundaryIntervals(candidates).map(
    ({ key: _key, ...boundary }) => boundary,
  );
}

function isLegalActiveTurnCut(message: IndexedMessage): boolean {
  return isCompletedAssistantMessage(message.message);
}

function fragmentSourceRange(
  turn: CompleteTurn,
  sourceMessages: readonly IndexedMessage[],
  maxChars: number,
  forceClosed: boolean,
  segments: ReflectionSegment[],
): void {
  if (sourceMessages.length === 0) return;
  const weights = sourceMessages.map((message) =>
    modelVisibleCharWeightOf(message.message),
  );
  const finitePrefix = [0];
  const infinitePrefix = [0];
  for (const weight of weights) {
    finitePrefix.push(
      finitePrefix.at(-1)! + (Number.isFinite(weight) ? weight : 0),
    );
    infinitePrefix.push(
      infinitePrefix.at(-1)! + (Number.isFinite(weight) ? 0 : 1),
    );
  }
  const rangeWeight = (start: number, end: number) => {
    const endOffset = end + 1;
    return infinitePrefix[endOffset]! - infinitePrefix[start]! > 0
      ? Number.POSITIVE_INFINITY
      : finitePrefix[endOffset]! - finitePrefix[start]!;
  };

  let start = 0;
  let index = 0;
  let lastLegalCut = -1;
  while (index < sourceMessages.length) {
    const nextWeight = rangeWeight(start, index);
    if (index > start && nextWeight > maxChars && lastLegalCut >= start) {
      segments.push(
        makeV2Segment(
          turn,
          sourceMessages.slice(start, lastLegalCut + 1),
          true,
        ),
      );
      start = lastLegalCut + 1;
      index = start;
      lastLegalCut = -1;
      continue;
    }

    const current = sourceMessages[index];
    if (!current) break;
    const legalCut = isLegalActiveTurnCut(current);
    if (legalCut) lastLegalCut = index;
    if (nextWeight >= maxChars && legalCut) {
      segments.push(
        makeV2Segment(turn, sourceMessages.slice(start, index + 1), true),
      );
      start = index + 1;
      lastLegalCut = -1;
    }
    index += 1;
  }
  if (start < sourceMessages.length) {
    segments.push(
      makeV2Segment(turn, sourceMessages.slice(start), forceClosed),
    );
  }
}

function fragmentTurn(
  turn: CompleteTurn,
  boundaries: readonly IndexedV2Boundary[],
  maxChars: number,
): ReflectionSegment[] {
  const firstSourceIndex = turn.messages[0]?.sourceIndex;
  if (firstSourceIndex === undefined) {
    throw new Error("Cannot fragment an empty turn");
  }
  if (
    turn.messages.some(
      (message, index) => message.sourceIndex !== firstSourceIndex + index,
    )
  ) {
    // Exact cursors cannot cover a disjoint turn without crossing another
    // turn's source, so preserve the legacy whole-turn boundary instead.
    if (boundaries.length === 0) return [makeV1Segment([turn], turn.closed)];
    throw new Error("A fragmented turn must be contiguous in source order");
  }
  const segments: ReflectionSegment[] = [];
  let cursor = 0;
  boundaries.forEach((boundary, index) => {
    fragmentSourceRange(
      turn,
      turn.messages.slice(cursor, boundary.startOffset),
      maxChars,
      true,
      segments,
    );
    const sourceMessages = turn.messages.slice(
      boundary.startOffset,
      boundary.endOffset + 1,
    );
    segments.push(
      makeV2Segment(
        turn,
        sourceMessages,
        turn.closed ||
          boundary.endOffset < turn.messages.length - 1 ||
          isCompletedAssistantMessage(sourceMessages.at(-1)?.message),
      ),
    );
    cursor = boundary.endOffset + 1;
    const next = boundaries[index + 1];
    if (next && next.startOffset < cursor) {
      throw new Error("Selected V2 source boundaries overlap");
    }
  });
  fragmentSourceRange(
    turn,
    turn.messages.slice(cursor),
    maxChars,
    turn.closed,
    segments,
  );
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
      throw new Error("Oversized turns must use source-message boundaries");
    }
    if (current.length > 0 && currentChars + turn.charCount > maxChars) {
      segments.push(makeV1Segment(current, true));
      current = [];
      currentChars = 0;
    }
    current.push(turn);
    currentChars += turn.charCount;
    if (currentChars === maxChars) {
      segments.push(makeV1Segment(current, true));
      current = [];
      currentChars = 0;
    }
  }

  if (current.length > 0) {
    segments.push(makeV1Segment(current, forceClosed));
  }
}

export function segmentMessages(
  messages: readonly OpenCodeMessage[],
  maxChars = DEFAULT_MAX_SEGMENT_CHARS,
  committedBoundaries: readonly CommittedSegmentBoundary[] = [],
): ReflectionSegment[] {
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error("maxChars must be a positive integer");
  }

  const history = canonicalHistory(messages);
  const selectedV1 = reconcileV1Boundaries(history.turns, committedBoundaries);
  const frozenTurns = new Set<number>();
  for (const boundary of selectedV1) {
    for (
      let index = boundary.startIndex;
      index <= boundary.endIndex;
      index += 1
    ) {
      frozenTurns.add(index);
    }
  }

  // Resolve every V2 cursor before considering V1 coverage so malformed exact
  // anchors can never silently degrade to whole-turn behavior.
  const resolvedV2 = resolveV2Boundaries(history, committedBoundaries);
  const selectedV2 = reconcileV2Boundaries(resolvedV2, frozenTurns);
  const selectedV2ByTurn = new Map<number, IndexedV2Boundary[]>();
  for (const boundary of selectedV2) {
    const current = selectedV2ByTurn.get(boundary.turnIndex);
    if (current) current.push(boundary);
    else selectedV2ByTurn.set(boundary.turnIndex, [boundary]);
  }
  const fragmentedTurns = new Set(
    resolvedV2
      .filter((boundary) => !frozenTurns.has(boundary.turnIndex))
      .map((boundary) => boundary.turnIndex),
  );
  history.turns.forEach((turn) => {
    if (!frozenTurns.has(turn.index) && turn.charCount > maxChars) {
      fragmentedTurns.add(turn.index);
    }
  });

  const selectedV1ByStart = new Map(
    selectedV1.map((boundary) => [boundary.startIndex, boundary]),
  );
  const segments: ReflectionSegment[] = [];
  let ordinaryTurns: CompleteTurn[] = [];
  const flushOrdinaryTurns = (forceClosed: boolean) => {
    packTurns(ordinaryTurns, maxChars, forceClosed, segments);
    ordinaryTurns = [];
  };

  let turnIndex = 0;
  while (turnIndex < history.turns.length) {
    const v1 = selectedV1ByStart.get(turnIndex);
    if (v1) {
      flushOrdinaryTurns(true);
      const coveredTurns = history.turns.slice(v1.startIndex, v1.endIndex + 1);
      segments.push(
        makeV1Segment(coveredTurns, coveredTurns.at(-1)?.closed ?? true),
      );
      turnIndex = v1.endIndex + 1;
      continue;
    }

    const turn = history.turns[turnIndex];
    if (!turn) break;
    if (fragmentedTurns.has(turnIndex)) {
      flushOrdinaryTurns(true);
      segments.push(
        ...fragmentTurn(turn, selectedV2ByTurn.get(turnIndex) ?? [], maxChars),
      );
    } else {
      ordinaryTurns.push(turn);
    }
    turnIndex += 1;
  }
  flushOrdinaryTurns(false);
  return segments;
}

export function readSegmentMessages(
  messages: readonly OpenCodeMessage[],
  boundary: CommittedSegmentBoundary,
): ReflectionMessage[];
export function readSegmentMessages(
  messages: readonly OpenCodeMessage[],
  startUserMessageId: string,
  endUserMessageId: string,
): ReflectionMessage[];
export function readSegmentMessages(
  messages: readonly OpenCodeMessage[],
  boundaryOrStartUserMessageId: CommittedSegmentBoundary | string,
  legacyEndUserMessageId?: string,
): ReflectionMessage[] {
  const boundary: CommittedSegmentBoundary =
    typeof boundaryOrStartUserMessageId === "string"
      ? {
          startUserMessageId: boundaryOrStartUserMessageId,
          endUserMessageId: legacyEndUserMessageId ?? "",
          sourceBoundaryVersion: 1,
          startSourceMessageId: null,
          endSourceMessageId: null,
        }
      : boundaryOrStartUserMessageId;
  const history = canonicalHistory(messages);
  if (boundaryVersion(boundary) === 2) {
    const resolved = resolveV2Boundaries(history, [boundary])[0];
    if (!resolved) throw new Error("V2 source boundary was not found");
    return reflectionMessages(
      history.messages.slice(resolved.startIndex, resolved.endIndex + 1),
    );
  }

  const userIndexes = new Map(
    history.turns.map((turn, index) => [turn.userMessageId, index]),
  );
  const startIndex = userIndexes.get(boundary.startUserMessageId);
  const endIndex = userIndexes.get(boundary.endUserMessageId);
  if (startIndex === undefined || endIndex === undefined) {
    throw new Error("Segment user boundary was not found");
  }
  if (startIndex > endIndex) {
    throw new Error("Segment user boundaries are out of order");
  }
  return reflectionMessages(
    history.turns
      .slice(startIndex, endIndex + 1)
      .flatMap((turn) => turn.messages),
  );
}
