import { createHash } from "node:crypto";
import type { Message } from "@opencode/ai";
import type {
  NativeProjectionCheckpoint,
  NativeProjectionResult,
} from "@reflection/opencode-v2-core/projection";
import type { NativeSessionSegmentsResponse } from "@reflection/shared/native";

export function manifestPrefixFingerprint(
  manifest: NativeSessionSegmentsResponse,
  archived: readonly { id: string }[],
): string {
  const ids = new Set(archived.map((range) => range.id));
  const pick = <T extends { id: string }>(entries: readonly T[]) =>
    entries.filter((entry) => ids.has(entry.id));
  return createHash("sha256")
    .update(
      JSON.stringify({
        segments: pick(manifest.segments),
        boundaries: pick(manifest.boundaries),
        targets: pick(manifest.targets),
      }),
    )
    .digest("hex");
}

export interface CachedProjectionPlan {
  readonly plan: NativeProjectionResult;
  readonly prefixIds: readonly string[];
  readonly prefixFingerprint: string;
  readonly tailStartSourceId: string | null;
  readonly manifestPrefixFingerprint: string;
  readonly manifestSummaryFingerprint: string;
  readonly cachedSummariesFingerprint: string;
  readonly contextLimit: number;
  readonly inputLimit: number | undefined;
  readonly outputLimit: number;
  readonly noticeId: string;
}

export function cacheProjectionPlan(
  plan: NativeProjectionResult,
  requestMessages: readonly Message[],
  manifestPrefixFingerprint: string,
): CachedProjectionPlan | undefined {
  const checkpoint = plan.checkpoint;
  if (!checkpoint || plan.tailStartIndex > requestMessages.length) return;
  const prefixIds = requestMessages
    .slice(0, plan.tailStartIndex)
    .map((message) => message.id);
  if (prefixIds.some((id) => id === undefined)) return;
  return {
    plan,
    prefixIds: prefixIds as string[],
    prefixFingerprint: checkpoint.source_prefix_fingerprint,
    tailStartSourceId: checkpoint.tail_start_source_id,
    manifestPrefixFingerprint,
    manifestSummaryFingerprint: checkpoint.manifest_summary_fingerprint,
    cachedSummariesFingerprint: checkpoint.cached_summaries_fingerprint,
    contextLimit: checkpoint.context_limit,
    inputLimit: checkpoint.input_limit,
    outputLimit: checkpoint.output_limit,
    noticeId: checkpoint.notice_id,
  };
}

/** Reuse only when the settled prefix and every checkpoint identity still
 * match. New tail messages are allowed; inserts, reverts, or changed summaries
 * invalidate the cached plan. */
export function canReuseProjectionPlan(
  previous: NativeProjectionCheckpoint | undefined,
  cached: CachedProjectionPlan,
  requestMessages: readonly Message[],
  manifestPrefixFingerprint: string,
  contextLimit: number,
  inputLimit: number | undefined,
  outputLimit: number,
): boolean {
  if (!previous || !cached.plan.checkpoint) return false;
  if (
    previous.notice_id !== cached.noticeId ||
    previous.source_prefix_fingerprint !== cached.prefixFingerprint ||
    previous.tail_start_source_id !== cached.tailStartSourceId ||
    cached.manifestPrefixFingerprint !== manifestPrefixFingerprint ||
    previous.manifest_summary_fingerprint !==
      cached.manifestSummaryFingerprint ||
    previous.cached_summaries_fingerprint !==
      cached.cachedSummariesFingerprint ||
    previous.context_limit !== contextLimit ||
    previous.input_limit !== inputLimit ||
    previous.output_limit !== outputLimit ||
    cached.contextLimit !== contextLimit ||
    cached.inputLimit !== inputLimit ||
    cached.outputLimit !== outputLimit ||
    cached.prefixIds.length > requestMessages.length
  )
    return false;
  for (let index = 0; index < cached.prefixIds.length; index++) {
    if (requestMessages[index]?.id !== cached.prefixIds[index]) return false;
  }
  return true;
}
