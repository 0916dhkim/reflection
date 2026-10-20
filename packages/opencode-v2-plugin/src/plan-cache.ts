import { createHash } from "node:crypto";
import type { Message } from "@opencode/ai";
import type {
  NativeProjectionCheckpoint,
  NativeProjectionResult,
} from "@reflection/opencode-v2-core/projection";
import type { NativeSessionSegmentsResponse } from "@reflection/shared/native";

function prefixKey(message: Message, index: number): string {
  if (message.id !== undefined) return message.id;
  try {
    return `#${index}:${message.role}:${createHash("sha256")
      .update(JSON.stringify(message.content))
      .digest("hex")}`;
  } catch {
    return `#${index}:${message.role}`;
  }
}

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
    .map(prefixKey);
  return {
    plan,
    prefixIds,
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
export function projectionPlanReuseReason(
  previous: NativeProjectionCheckpoint | undefined,
  cached: CachedProjectionPlan,
  requestMessages: readonly Message[],
  manifestPrefixFingerprint: string,
  contextLimit: number,
  inputLimit: number | undefined,
  outputLimit: number,
): string {
  if (!previous) return "no-previous";
  if (!cached.plan.checkpoint) return "no-checkpoint";
  if (previous.notice_id !== cached.noticeId) return "notice";
  if (previous.source_prefix_fingerprint !== cached.prefixFingerprint)
    return "source-prefix";
  if (previous.tail_start_source_id !== cached.tailStartSourceId)
    return "tail-start";
  if (cached.manifestPrefixFingerprint !== manifestPrefixFingerprint)
    return "manifest-prefix";
  if (
    previous.manifest_summary_fingerprint !== cached.manifestSummaryFingerprint
  )
    return "manifest-summary";
  if (
    previous.cached_summaries_fingerprint !== cached.cachedSummariesFingerprint
  )
    return "cached-summaries";
  if (previous.context_limit !== contextLimit) return "context-limit";
  if (previous.input_limit !== inputLimit) return "input-limit";
  if (previous.output_limit !== outputLimit) return "output-limit";
  if (cached.contextLimit !== contextLimit) return "cached-context-limit";
  if (cached.inputLimit !== inputLimit) return "cached-input-limit";
  if (cached.outputLimit !== outputLimit) return "cached-output-limit";
  if (cached.prefixIds.length > requestMessages.length) return "prefix-short";
  for (let index = 0; index < cached.prefixIds.length; index++) {
    const message = requestMessages[index];
    if (
      message === undefined ||
      prefixKey(message, index) !== cached.prefixIds[index]
    )
      return "prefix-id";
  }
  return "ok";
}

export function canReuseProjectionPlan(
  previous: NativeProjectionCheckpoint | undefined,
  cached: CachedProjectionPlan,
  requestMessages: readonly Message[],
  manifestPrefixFingerprint: string,
  contextLimit: number,
  inputLimit: number | undefined,
  outputLimit: number,
): boolean {
  return (
    projectionPlanReuseReason(
      previous,
      cached,
      requestMessages,
      manifestPrefixFingerprint,
      contextLimit,
      inputLimit,
      outputLimit,
    ) === "ok"
  );
}
