import { createHash } from "node:crypto";
import { Message } from "@opencode/ai";
import type { SourceInfo } from "@reflection/shared/sources";
import {
  parseNativeSessionSegmentsResponse,
  type NativeSegmentSummary,
} from "@reflection/shared/native";
import { estimateNativeTokens } from "@reflection/opencode-v2-core/projection";
import { NOTICE_PREFIX } from "./projection.js";

export interface CursorState {
  version: 1;
  sourceId: string;
  sessionId: string;
  submittedThrough: string | null;
  summarizedThrough: string | null;
  summaryFingerprint: string;
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
    typeof state.summaryFingerprint !== "string"
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

export function selectCursorProjection(input: {
  sourceId: string;
  messages: readonly Message[];
  summarizedThrough: string | null;
  summaries: readonly NativeSegmentSummary[];
  hardTokens: number;
  systemTokens: number;
}):
  | {
      messages: Message[];
      estimatedTokens: number;
      omittedSummaries: number;
    }
  | undefined {
  let tailStart = 0;
  if (input.summarizedThrough !== null) {
    const index = input.messages.findIndex(
      (message) => message.id === input.summarizedThrough,
    );
    if (index < 0) return;
    tailStart = index + 1;
  }
  const costs = input.messages.map(
    (message) =>
      8 +
      estimateNativeTokens({ role: message.role, content: message.content }),
  );
  let tailCost = costs.slice(tailStart).reduce((sum, cost) => sum + cost, 0);
  while (
    tailStart < input.messages.length - 1 &&
    input.systemTokens + tailCost > input.hardTokens
  ) {
    tailCost -= costs[tailStart]!;
    tailStart++;
  }
  let remaining = input.hardTokens - input.systemTokens - tailCost;
  const selected: NativeSegmentSummary[] = [];
  for (let index = input.summaries.length - 1; index >= 0; index--) {
    const segment = input.summaries[index]!;
    const cost =
      estimateNativeTokens(`Segment ${segment.id}\n${segment.summary}`) + 2;
    if (cost > remaining) break;
    selected.unshift(segment);
    remaining -= cost;
  }
  const omittedSummaries = input.summaries.length - selected.length;
  const parts = [
    NOTICE_PREFIX.trimEnd(),
    `[Reflection source_id=${JSON.stringify(input.sourceId)}]`,
    ...selected.map((segment) => `Segment ${segment.id}\n${segment.summary}`),
  ];
  if (omittedSummaries > 0)
    parts.push(
      `[${omittedSummaries} older summaries omitted; use memory_search]`,
    );
  const notice =
    input.summaries.length > 0
      ? Message.make({
          id: `reflection-cursor-${createHash("sha256")
            .update(parts.join("\n\n"))
            .digest("hex")
            .slice(0, 32)}`,
          role: "user",
          content: [{ type: "text", text: parts.join("\n\n") }],
        })
      : undefined;
  const messages = notice
    ? [notice, ...input.messages.slice(tailStart)]
    : [...input.messages.slice(tailStart)];
  const estimatedTokens =
    input.systemTokens +
    (notice
      ? 8 + estimateNativeTokens({ role: notice.role, content: notice.content })
      : 0) +
    tailCost;
  return { messages, estimatedTokens, omittedSummaries };
}
