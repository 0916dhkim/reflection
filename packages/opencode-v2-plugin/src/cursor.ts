import { createHash } from "node:crypto";
import { Message } from "@opencode/ai";
import type { SourceInfo } from "@reflection/shared/sources";
import {
  parseNativeSessionSegmentsResponse,
  type NativeSegmentSummary,
} from "@reflection/shared/native";
import { estimateNativeTokens } from "@reflection/opencode-v2-core/projection";
import { NOTICE_PREFIX, estimateMessages } from "./projection.js";

// Once projection fires, keep at most this share of the context window as raw
// tail and spend at most this share on summaries, leaving room to grow back to
// the projection trigger.
const TAIL_SHARE = 0.25;
const SUMMARY_SHARE = 0.05;

export interface CursorState {
  version: 1;
  sourceId: string;
  sessionId: string;
  submittedThrough: string | null;
  summarizedThrough: string | null;
  summaryFingerprint: string;
  projectedThrough?: string | null;
  projectedAnchor?: string | null;
  block?: ArchiveBlock;
}

export function parseCursorState(
  value: unknown,
  sourceId: string,
  sessionId: string,
): CursorState | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    return;
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1 ||
    state.sourceId !== sourceId ||
    state.sessionId !== sessionId ||
    (state.submittedThrough !== null &&
      typeof state.submittedThrough !== "string") ||
    (state.summarizedThrough !== null &&
      typeof state.summarizedThrough !== "string") ||
    typeof state.summaryFingerprint !== "string" ||
    (state.projectedThrough != null &&
      typeof state.projectedThrough !== "string") ||
    (state.projectedAnchor != null &&
      typeof state.projectedAnchor !== "string") ||
    (state.block !== undefined &&
      (state.block === null ||
        typeof state.block !== "object" ||
        typeof (state.block as ArchiveBlock).through !== "string" ||
        typeof (state.block as ArchiveBlock).text !== "string"))
  )
    return;
  return state as unknown as CursorState;
}

export function emptyCursorState(
  sourceId: string,
  sessionId: string,
): CursorState {
  return {
    version: 1,
    sourceId,
    sessionId,
    submittedThrough: null,
    summarizedThrough: null,
    summaryFingerprint: "",
    projectedThrough: null,
  };
}

export function cursorSummaryState(
  value: unknown,
  source: SourceInfo,
): {
  summaries: NativeSegmentSummary[];
  summarizedThrough: string | null;
  fingerprint: string;
} {
  const manifest = parseNativeSessionSegmentsResponse(value, source.id);
  const summaries = manifest.segments.filter(
    (segment) => typeof segment.summary === "string",
  );
  return {
    summaries,
    summarizedThrough: summaries.at(-1)?.end_source_message_id ?? null,
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify(
          summaries.map((segment) => [
            segment.id,
            segment.start_source_message_id,
            segment.end_source_message_id,
            segment.summary,
          ]),
        ),
      )
      .digest("hex"),
  };
}

// A tail may not start between a tool call and its result: providers reject a
// tool result whose call is missing. safe[i] is true when every result at or
// after message i has its call at or after i (or no call in the request).
function toolSafeStarts(messages: readonly Message[]): boolean[] {
  const calls = new Map<string, number>();
  const unsafe = Array<number>(messages.length + 2).fill(0);
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return;
    for (const part of message.content) {
      if (part.type === "tool-call") calls.set(part.id, index);
      if (part.type !== "tool-result") continue;
      const call = calls.get(part.id);
      if (call === undefined || call === index) continue;
      unsafe[call + 1]!++;
      unsafe[index + 1]!--;
    }
  });
  let depth = 0;
  return Array.from({ length: messages.length + 1 }, (_, index) => {
    depth += unsafe[index]!;
    return depth === 0;
  });
}

export const ANCHOR_HEADER = "\n[Latest actual user input, copied verbatim]\n";
export const ANCHOR_FOOTER = "\n[End latest actual user input]";

/** Archive messages[0, start): `through` is the last message the summaries may
 * cover and `id` names it. `start` is tool-safe. `anchor` is the archived
 * latest user message copied into the notice, fixed while the cut is kept. */
type Cut = { id: string; through: number; start: number; anchor?: number };
export type EstimateSource = "provider" | "provider-bound" | "heuristic";
/** Rendered archive description, persisted so a manifest outage keeps it. */
export type ArchiveBlock = { through: string; text: string };

const droppedMarker = (dropped: number) =>
  `[${dropped} earlier messages omitted to fit the input budget; use memory_search]`;

export function selectCursorProjection(input: {
  sourceId: string;
  messages: readonly Message[];
  summaries: readonly NativeSegmentSummary[];
  /** Last rendered archive, used only when no summaries could be read. */
  cachedBlock?: ArchiveBlock;
  projectedThrough: string | null;
  /** Latest user copied into the kept cut's notice; undefined if unknown. */
  projectedAnchor?: string | null;
  contextLimit: number;
  softTokens: number;
  hardTokens: number;
  /** Heuristic tokens for the system prompt and tool definitions. */
  systemTokens: number;
  /** Provider-anchored size of an exact request, when continuity is proven. */
  measure?: (messages: readonly Message[]) => number | undefined;
  /** Provider-anchored upper bound, when exact continuity is lost. */
  bound?: (messages: readonly Message[]) => number | undefined;
}): {
  messages: Message[];
  estimatedTokens: number;
  measured: boolean;
  source: EstimateSource;
  omittedSummaries: number;
  missingRanges: number;
  projectedThrough: string | null;
  projectedAnchor: string | null;
  block?: ArchiveBlock;
  mode: "raw" | "kept" | "fired";
} {
  const count = input.messages.length;
  const positions = new Map<string, number>();
  input.messages.forEach((message, index) => {
    if (message.id !== undefined) positions.set(message.id, index);
  });
  const safe = toolSafeStarts(input.messages);
  // Images become fixed reserves; other media fails closed (projection.ts).
  const costs = estimateMessages(input.messages).map(
    (message) =>
      8 +
      estimateNativeTokens({ role: message.role, content: message.content }),
  );
  const suffix = Array<number>(count + 1).fill(0);
  for (let index = count - 1; index >= 0; index--)
    suffix[index] = suffix[index + 1]! + costs[index]!;
  const located = input.summaries
    .flatMap((segment) => {
      const start = positions.get(segment.start_source_message_id);
      const end = positions.get(segment.end_source_message_id);
      return start === undefined || end === undefined || end < start
        ? []
        : [{ segment, start, end }];
    })
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const latestUser = input.messages.findLastIndex(
    (message) => message.role === "user" && message.id !== undefined,
  );

  // An assistant's source record includes its tool results, so archive them
  // with it when later messages follow. When the results are the latest
  // messages, keep the call in the tail rather than sending results alone.
  const cutThrough = (id: string): Cut | undefined => {
    const through = positions.get(id);
    if (through === undefined) return;
    let start = through + 1;
    while (
      start < count &&
      input.messages[start]!.id === undefined &&
      input.messages[start]!.role === "tool"
    )
      start++;
    if (start >= count || !safe[start]) {
      start = through + 1;
      while (start > 0 && !safe[start]) start--;
    }
    return start > 0 ? { id, through, start } : undefined;
  };
  const withAnchor = (cut: Cut, anchor?: string | null): Cut => {
    const position =
      anchor === undefined
        ? latestUser
        : anchor === null
          ? -1
          : (positions.get(anchor) ?? -1);
    return position >= 0 && position < cut.start
      ? { ...cut, anchor: position }
      : cut;
  };

  // Summaries through the cut, newest first within budget, then explicit
  // markers for archived source messages no available summary covers.
  const archive = (cut: Cut | null, end: number) => {
    const cachedThrough =
      input.summaries.length === 0 && input.cachedBlock
        ? positions.get(input.cachedBlock.through)
        : undefined;
    const parts: string[] = [];
    let covered = -1;
    let omitted = 0;
    const ranges: [number, number][] = [];
    if (cut && cachedThrough !== undefined && cachedThrough <= cut.through) {
      parts.push(input.cachedBlock!.text);
      covered = cachedThrough;
    } else if (cut) {
      const included = located.filter((item) => item.end <= cut.through);
      let remaining = Math.floor(input.contextLimit * SUMMARY_SHARE);
      const selected: typeof included = [];
      for (let index = included.length - 1; index >= 0; index--) {
        const item = included[index]!;
        const cost =
          estimateNativeTokens(
            `Segment ${item.segment.id}\n${item.segment.summary}`,
          ) + 2;
        if (cost > remaining) break;
        selected.unshift(item);
        remaining -= cost;
      }
      omitted = included.length - selected.length;
      if (omitted > 0)
        parts.push(`[${omitted} older summaries omitted; use memory_search]`);
      parts.push(
        ...selected.map(
          (item) => `Segment ${item.segment.id}\n${item.segment.summary}`,
        ),
      );
      for (const item of included) ranges.push([item.start, item.end]);
    }
    let missing = 0;
    let range = 0;
    let first: string | undefined;
    let last: string | undefined;
    const close = () => {
      if (first === undefined) return;
      parts.push(
        `[Reflection omitted ${first}..${last}: missing-or-stale-summary]`,
      );
      missing++;
      first = undefined;
    };
    for (let index = covered + 1; index < end; index++) {
      const id = input.messages[index]!.id;
      if (id === undefined) continue;
      while (range < ranges.length && ranges[range]![1] < index) range++;
      if (range < ranges.length && ranges[range]![0] <= index) close();
      else {
        first ??= id;
        last = id;
      }
    }
    close();
    return { text: parts.join("\n\n"), omitted, missing };
  };

  const notice = (cut: Cut | null, start: number) => {
    const end = cut === null ? 0 : cut.start;
    const block = archive(cut, end);
    const dropped = start - end;
    const text = [
      NOTICE_PREFIX.trimEnd(),
      `[Reflection source_id=${JSON.stringify(input.sourceId)}]`,
      ...(block.text ? [block.text] : []),
      ...(dropped > 0 ? [droppedMarker(dropped)] : []),
    ].join("\n\n");
    const position =
      cut?.anchor ?? (latestUser >= 0 && latestUser < start ? latestUser : -1);
    const anchor = position >= 0 ? input.messages[position] : undefined;
    const message = Message.make({
      id: `reflection-cursor-${createHash("sha256")
        .update(JSON.stringify([text, anchor?.id ?? null]))
        .digest("hex")
        .slice(0, 32)}`,
      role: "user",
      content: anchor
        ? [
            { type: "text", text },
            { type: "text", text: ANCHOR_HEADER },
            ...anchor.content,
            { type: "text", text: ANCHOR_FOOTER },
          ]
        : [{ type: "text", text }],
      ...(anchor?.providerMetadata == null
        ? {}
        : { providerMetadata: anchor.providerMetadata }),
    });
    const [estimated] = estimateMessages([message]);
    return {
      message,
      cost:
        8 +
        estimateNativeTokens({
          role: estimated!.role,
          content: estimated!.content,
        }),
      omitted: block.omitted,
      missing: block.missing,
      block: cut ? { through: cut.id, text: block.text } : undefined,
      anchor: anchor?.id ?? null,
    };
  };

  // The bound never subtracts archived content, so it only applies to kept and
  // raw requests, which archive no more than the previous request did.
  const candidate = (
    cut: Cut | null,
    start = cut?.start ?? 0,
    bounded = false,
  ) => {
    const head = cut === null && start === 0 ? undefined : notice(cut, start);
    const messages = [
      ...(head ? [head.message] : []),
      ...input.messages.slice(start),
    ];
    const measured = input.measure?.(messages);
    const bound =
      measured === undefined && bounded ? input.bound?.(messages) : undefined;
    return {
      messages,
      estimatedTokens:
        measured ??
        bound ??
        input.systemTokens + (head?.cost ?? 0) + suffix[start]!,
      measured: measured !== undefined,
      source: (measured !== undefined
        ? "provider"
        : bound !== undefined
          ? "provider-bound"
          : "heuristic") as EstimateSource,
      omittedSummaries: head?.omitted ?? 0,
      missingRanges: head?.missing ?? 0,
      projectedThrough: cut?.id ?? null,
      projectedAnchor: head?.anchor ?? null,
      ...(head?.block ? { block: head.block } : {}),
      cut,
      start,
      headCost: head?.cost ?? 0,
    };
  };

  // Past the hard budget, drop the oldest tail messages without separating a
  // tool result from its call, and say so in the notice. If only an unsafe
  // start fits, keep the call and let the caller reject the over-budget
  // request instead of sending an invalid one.
  const fit = (
    projection: ReturnType<typeof candidate>,
    mode: "raw" | "kept" | "fired",
  ) => {
    let chosen = projection;
    if (projection.estimatedTokens > input.hardTokens) {
      const reserve = estimateNativeTokens(droppedMarker(count)) + 2;
      let start = projection.start;
      let estimated = projection.estimatedTokens;
      while (
        start < count - 1 &&
        (estimated + reserve > input.hardTokens || !safe[start])
      ) {
        estimated -= costs[start]!;
        start++;
      }
      while (start > projection.start && !safe[start]) {
        start--;
        estimated += costs[start]!;
      }
      if (start !== projection.start) {
        const trimmed = candidate(projection.cut, start);
        chosen = {
          ...trimmed,
          estimatedTokens: estimated - projection.headCost + trimmed.headCost,
          measured: false,
          source: "heuristic",
        };
      }
    }
    const { cut: _cut, start: _start, headCost: _headCost, ...result } = chosen;
    return { ...result, mode };
  };

  // Keep the previous cut while it fits so the prompt prefix stays stable.
  const previous =
    input.projectedThrough === null
      ? undefined
      : cutThrough(input.projectedThrough);
  if (previous) {
    const kept = candidate(
      withAnchor(previous, input.projectedAnchor),
      undefined,
      true,
    );
    if (kept.estimatedTokens <= input.softTokens) return fit(kept, "kept");
  }
  const raw = candidate(null, 0, true);
  if (raw.estimatedTokens <= input.softTokens || count < 2)
    return fit(raw, "raw");
  // Fire: archive through the earliest summary that leaves a raw tail within
  // the target, or through the latest summary when none does. When summaries
  // lag behind, archive further and mark what is not summarized yet.
  const target = Math.floor(input.contextLimit * TAIL_SHARE);
  const summaryCuts = located.flatMap((item) => {
    const cut = cutThrough(item.segment.end_source_message_id);
    return cut ? [cut] : [];
  });
  let cut =
    summaryCuts.find((candidate) => suffix[candidate.start]! <= target) ??
    summaryCuts.at(-1);
  if (!cut || candidate(withAnchor(cut)).estimatedTokens > input.softTokens) {
    let latest: Cut | undefined;
    for (let index = (cut?.through ?? -1) + 1; index < count; index++) {
      const id = input.messages[index]!.id;
      const next = id === undefined ? undefined : cutThrough(id);
      if (!next || next.start >= count || next.start <= (cut?.start ?? 0))
        continue;
      latest = next;
      if (suffix[next.start]! <= target) break;
    }
    cut = latest ?? cut;
  }
  if (!cut) return fit(raw, "raw");
  const fired = candidate(withAnchor(cut));
  // Until a projection fits, keep the full request when it does.
  if (
    fired.estimatedTokens > input.hardTokens &&
    raw.estimatedTokens <= input.hardTokens
  )
    return fit(raw, "raw");
  return fit(fired, "fired");
}
