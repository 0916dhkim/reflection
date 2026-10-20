import { createHash } from "node:crypto";
import { Message } from "@opencode/ai";
import type { SourceInfo } from "@reflection/shared/sources";
import {
  parseNativeSessionSegmentsResponse,
  type NativeSegmentSummary,
} from "@reflection/shared/native";
import { estimateNativeTokens } from "@reflection/opencode-v2-core/projection";
import { NOTICE_PREFIX } from "./projection.js";

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
      typeof state.projectedThrough !== "string")
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

export function selectCursorProjection(input: {
  sourceId: string;
  messages: readonly Message[];
  summaries: readonly NativeSegmentSummary[];
  projectedThrough: string | null;
  contextLimit: number;
  softTokens: number;
  hardTokens: number;
  systemTokens: number;
}): {
  messages: Message[];
  estimatedTokens: number;
  omittedSummaries: number;
  projectedThrough: string | null;
  mode: "raw" | "kept" | "fired";
} {
  const positions = new Map<string, number>();
  input.messages.forEach((message, index) => {
    if (message.id !== undefined) positions.set(message.id, index);
  });
  const safe = toolSafeStarts(input.messages);
  const costs = input.messages.map(
    (message) =>
      8 +
      estimateNativeTokens({ role: message.role, content: message.content }),
  );
  const suffix = Array<number>(costs.length + 1).fill(0);
  for (let index = costs.length - 1; index >= 0; index--)
    suffix[index] = suffix[index + 1]! + costs[index]!;
  // A summary can end on a tool-calling assistant message; keep that call in
  // the tail rather than sending its results alone.
  const tailAfter = (id: string) => {
    let start = positions.get(id)! + 1;
    while (start > 0 && !safe[start]) start--;
    return start;
  };
  // Trim the oldest messages past the hard budget without separating a tool
  // result from its call. If only an unsafe start fits, include the call and
  // let the caller reject the over-budget request instead of an invalid one.
  const fit = (start: number) => {
    let tailStart = start;
    let tailCost = suffix[tailStart]!;
    while (
      tailStart < input.messages.length - 1 &&
      (input.systemTokens + tailCost > input.hardTokens || !safe[tailStart])
    ) {
      tailCost -= costs[tailStart]!;
      tailStart++;
    }
    while (tailStart > 0 && !safe[tailStart]) {
      tailStart--;
      tailCost += costs[tailStart]!;
    }
    return { tailStart, tailCost };
  };
  const cuts = input.summaries.flatMap((segment, index) =>
    positions.has(segment.end_source_message_id)
      ? [{ id: segment.end_source_message_id, count: index + 1 }]
      : [],
  );

  const render = (
    cut: { id: string; count: number },
    mode: "kept" | "fired",
  ) => {
    const { tailStart, tailCost } = fit(tailAfter(cut.id));
    let remaining = Math.min(
      Math.floor(input.contextLimit * SUMMARY_SHARE),
      input.hardTokens - input.systemTokens - tailCost,
    );
    const selected: NativeSegmentSummary[] = [];
    for (let index = cut.count - 1; index >= 0; index--) {
      const segment = input.summaries[index]!;
      const cost =
        estimateNativeTokens(`Segment ${segment.id}\n${segment.summary}`) + 2;
      if (cost > remaining) break;
      selected.unshift(segment);
      remaining -= cost;
    }
    const omittedSummaries = cut.count - selected.length;
    const parts = [
      NOTICE_PREFIX.trimEnd(),
      `[Reflection source_id=${JSON.stringify(input.sourceId)}]`,
      ...selected.map((segment) => `Segment ${segment.id}\n${segment.summary}`),
    ];
    if (omittedSummaries > 0)
      parts.push(
        `[${omittedSummaries} older summaries omitted; use memory_search]`,
      );
    const notice = Message.make({
      id: `reflection-cursor-${createHash("sha256")
        .update(parts.join("\n\n"))
        .digest("hex")
        .slice(0, 32)}`,
      role: "user",
      content: [{ type: "text", text: parts.join("\n\n") }],
    });
    return {
      messages: [notice, ...input.messages.slice(tailStart)],
      estimatedTokens:
        input.systemTokens +
        8 +
        estimateNativeTokens({ role: notice.role, content: notice.content }) +
        tailCost,
      omittedSummaries,
      projectedThrough: cut.id,
      mode,
    };
  };

  // Keep the previous cut while it fits so the prompt prefix stays stable.
  const previous = cuts.find((cut) => cut.id === input.projectedThrough);
  if (
    previous &&
    input.systemTokens + suffix[tailAfter(previous.id)]! <= input.softTokens
  ) {
    const kept = render(previous, "kept");
    if (kept.estimatedTokens <= input.softTokens) return kept;
  }
  const raw = {
    messages: [...input.messages],
    estimatedTokens: input.systemTokens + suffix[0]!,
    omittedSummaries: 0,
    projectedThrough: null,
    mode: "raw" as const,
  };
  if (raw.estimatedTokens <= input.softTokens || cuts.length === 0) {
    if (raw.estimatedTokens <= input.hardTokens) return raw;
    // Nothing is summarized yet: drop the oldest whole exchanges to fit.
    const { tailStart, tailCost } = fit(0);
    return {
      ...raw,
      messages: input.messages.slice(tailStart),
      estimatedTokens: input.systemTokens + tailCost,
    };
  }
  // Fire: archive through the earliest summary that leaves a raw tail within
  // the target, or through the latest summary when none does.
  const target = Math.floor(input.contextLimit * TAIL_SHARE);
  const cut =
    cuts.find((candidate) => suffix[tailAfter(candidate.id)]! <= target) ??
    cuts.at(-1)!;
  return render(cut, "fired");
}
