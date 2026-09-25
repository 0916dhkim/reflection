import { createHash } from "node:crypto";
import {
  nativeSegmentIdForRequest,
  nativeSourceFingerprint,
  parseNativeSessionSegmentsResponse,
  type NativeSessionSegmentsResponse,
} from "@reflection/shared/native";
import type { SourceInfo } from "@reflection/shared/sources";
import type { NativeCanonicalRecord, NativeSourceOmission } from "./history.js";
import type { NativePrefixLink, NativeSegmentMemo } from "./memo.js";
import type { NativePlannedSegment } from "./segmentation.js";

export interface ModelMessageLike {
  id?: string;
  role: string;
  content: unknown;
}

export interface NativeArchivedRange {
  id: string;
  start_source_message_id: string;
  end_source_message_id: string;
  source_fingerprint: string;
  source_message_ids: string[];
}

export interface NativeCachedSummary {
  id: string;
  start_source_message_id: string;
  end_source_message_id: string;
  source_fingerprint: string;
  projection_version: 3;
  summary: string;
}

export interface NativeProjectionCheckpoint {
  version: 2;
  source_id: string;
  session_id: string;
  archived: NativeArchivedRange[];
  source_prefix_fingerprint: string;
  tail_start_source_id: string | null;
  restored_user_id: string | null;
  manifest_summary_fingerprint: string;
  /** Only verified summaries actually included in the budgeted notice. */
  cachedSummaries: NativeCachedSummary[];
  cached_summaries_fingerprint: string;
  context_limit: number;
  input_limit: number;
  output_limit: number;
  notice_id: string;
}

export interface NativeProjectionOmission {
  segmentId: string;
  startSourceMessageId: string;
  endSourceMessageId: string;
  reason: "missing-or-stale-summary" | "summary-budget" | NativeSourceOmission;
}

export interface NativeProjectionResult {
  tailStartIndex: number;
  /** Keep these references in original order BEFORE notice, anchor, and tail. */
  preservedPrefixIndices: number[];
  /** Copy the anchor's entire content verbatim, including media. Never text-render it. */
  notice?: { id: string; text: string; anchorMessageIndex?: number };
  checkpoint?: NativeProjectionCheckpoint;
  lossy: boolean;
  omissions: NativeProjectionOmission[];
  /** Estimated input tokens including system/tools, excluding reserved output. */
  estimatedTokens: number;
  reset: boolean;
  deferredReason?: string;
}

export type NativeProjectionShape = Pick<
  NativeProjectionResult,
  "tailStartIndex" | "preservedPrefixIndices" | "notice"
>;

export interface NativeProjectionOptions {
  source: SourceInfo;
  sessionId: string;
  records: readonly NativeCanonicalRecord[];
  segments: readonly NativePlannedSegment[];
  manifest: NativeSessionSegmentsResponse;
  /** Explicit transport failure only; malformed/authoritative manifests are not outages. */
  manifestUnavailable?: boolean;
  messages: readonly ModelMessageLike[];
  system: unknown;
  tools: unknown;
  contextLimit: number;
  inputLimit?: number;
  outputLimit: number;
  previous?: NativeProjectionCheckpoint;
  allowLossy?: true;
  /** Reuses per-segment validation and prefix hashing for unchanged records. */
  memo?: NativeSegmentMemo;
  /** Provider usage plus new materialized content, when a caller proves continuity. */
  estimateInput?: (shape: NativeProjectionShape) => number | undefined;
}

export class NativeProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeProjectionError";
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sameIds(
  ids: readonly string[],
  records: readonly NativeCanonicalRecord[],
): boolean {
  return (
    ids.length === records.length &&
    ids.every((id, index) => id === records[index]!.source.id)
  );
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Conservative tokenizer-independent estimate: UTF-8 and lexical pressure,
 * structural framing, and explicit media reserves. Not a provider token count.
 * Opaque binary/cyclic/non-JSON content requires a plugin-specific media policy.
 */
export function estimateNativeTokens(value: unknown): number {
  const visiting = new Set<object>();
  function visit(item: unknown): number {
    if (item == null) return 0;
    if (typeof item === "string") {
      return Math.max(
        Math.ceil(Buffer.byteLength(item, "utf8") / 3),
        (item.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? []).length,
      );
    }
    if (typeof item === "number" || typeof item === "boolean") return 2;
    if (
      typeof item !== "object" ||
      visiting.has(item) ||
      ArrayBuffer.isView(item) ||
      item instanceof ArrayBuffer
    ) {
      throw new NativeProjectionError(
        "opaque or cyclic model payload requires an explicit media policy",
      );
    }
    visiting.add(item);
    let total = 2;
    if (Array.isArray(item)) {
      for (const part of item) total += visit(part) + 2;
    } else {
      const fields = object(item)!;
      if (
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      ) {
        throw new NativeProjectionError(
          "non-JSON model content requires an explicit estimation policy",
        );
      }
      const type = fields.type;
      if (type === "image" || type === "image_url") total += 4096;
      if (
        type === "file" ||
        type === "audio" ||
        type === "video" ||
        type === "input_audio"
      ) {
        throw new NativeProjectionError(
          "unbounded file/audio/video requires an explicit media policy",
        );
      }
      for (const [key, child] of Object.entries(fields))
        total += visit(key) + visit(child) + 2;
    }
    visiting.delete(item);
    return total;
  }
  return visit(value);
}

/** Pure plan only. The caller materializes prefix references, notice + optional
 * copied user content, then messages.slice(tailStartIndex). No native compaction.
 * API array order is authoritative; timestamps and imagined parent links are not.
 */
export function projectNativeContext(
  options: NativeProjectionOptions,
): NativeProjectionResult {
  const { source, sessionId, records, segments, messages, previous } = options;
  const fail = (reason: string): never => {
    throw new NativeProjectionError(reason);
  };
  if (source.kind !== "opencode-v2" || source.identity_scheme !== "source-v1")
    fail("invalid native source registry");
  let manifest: NativeSessionSegmentsResponse;
  try {
    manifest = parseNativeSessionSegmentsResponse(options.manifest, source.id);
  } catch {
    return fail("invalid source-owned native manifest");
  }
  if (manifest.session_id !== sessionId) fail("manifest session mismatch");
  const inputLimit = options.inputLimit ?? options.contextLimit;
  if (
    ![options.contextLimit, inputLimit, options.outputLimit].every(
      Number.isFinite,
    ) ||
    options.contextLimit <= 0 ||
    inputLimit <= 0 ||
    options.outputLimit < 0
  )
    fail("invalid model limits");
  const usable = Math.min(
    inputLimit,
    options.contextLimit - options.outputLimit,
  );
  if (usable <= 0) fail("no usable input budget");
  const hard = Math.floor(usable * 0.9);
  const soft = Math.floor(usable * 0.75);
  const summaryBudget = Math.floor(options.contextLimit * 0.05);
  const fixedTokens =
    estimateNativeTokens(options.system) + estimateNativeTokens(options.tools);
  const costs = messages.map(
    (message) =>
      8 +
      estimateNativeTokens({ role: message.role, content: message.content }),
  );
  const costPrefix = [0];
  for (const cost of costs) costPrefix.push(costPrefix.at(-1)! + cost);
  const tailCost = (index: number) => costPrefix.at(-1)! - costPrefix[index]!;
  const usageEstimate = (shape: NativeProjectionShape) => {
    const value = options.estimateInput?.(shape);
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  };
  const rawTokens =
    usageEstimate({ tailStartIndex: 0, preservedPrefixIndices: [] }) ??
    fixedTokens + tailCost(0);
  const raw = (reason?: string): NativeProjectionResult => ({
    tailStartIndex: 0,
    preservedPrefixIndices: [],
    lossy: false,
    omissions: [],
    estimatedTokens: rawTokens,
    reset: previous !== undefined,
    ...(reason ? { deferredReason: reason } : {}),
  });
  const positions = new Map<string, number>();
  const tools = new Map<string, number[]>();
  records.forEach((record, index) => {
    if (
      record.raw.id !== record.source.id ||
      record.raw.type !== record.source.type ||
      positions.has(record.source.id)
    )
      fail("invalid canonical source IDs/types");
    positions.set(record.source.id, index);
    if (record.raw.type !== "assistant" || !Array.isArray(record.raw.content))
      return;
    for (const part of record.raw.content) {
      const tool = object(part);
      if (tool?.type !== "tool" || typeof tool.id !== "string") continue;
      tools.set(tool.id, [...(tools.get(tool.id) ?? []), index]);
    }
  });
  // A model message can contain several results. Every owner participates in
  // cut validation, so a call/result group cannot straddle the archive boundary.
  const owners: number[][] = [];
  const pinned: boolean[] = [];
  let ambiguousToolMapping = false;
  messages.forEach((message) => {
    const own =
      message.id === undefined ? undefined : positions.get(message.id);
    const indices = new Set<number>(own === undefined ? [] : [own]);
    let pin = message.id !== undefined && own === undefined;
    let mappedToolPart = false;
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      const tool = object(part);
      if (tool?.type !== "tool-result" && tool?.type !== "tool-call") continue;
      const id = tool.toolCallId ?? tool.id;
      const matches = typeof id === "string" ? tools.get(id) : undefined;
      if (matches?.length === 1) mappedToolPart = true;
      if (matches?.length !== 1) {
        pin = true;
        ambiguousToolMapping = true;
      }
      for (const match of matches ?? []) indices.add(match);
    }
    if (message.role === "tool" && !mappedToolPart) ambiguousToolMapping = true;
    owners.push([...indices]);
    pinned.push(pin || indices.size === 0);
  });
  const latestUser = records.findLastIndex(
    (record) => record.raw.type === "user",
  );
  const latestUserModels = messages.flatMap((message, index) =>
    latestUser >= 0 && message.id === records[latestUser]!.source.id
      ? [index]
      : [],
  );

  // Index whole rendered groups once. A cutoff is safe iff every archived
  // owner's last rendered message precedes every live owner's first message.
  const firstModel = Array<number>(records.length + 1).fill(messages.length);
  const lastModel = Array<number>(records.length).fill(-1);
  const pinnedCostPrefix = [0];
  const pinnedIndices: number[] = [];
  let firstPinnedOwner = records.length;
  owners.forEach((group, index) => {
    for (const owner of group) {
      firstModel[owner] = Math.min(firstModel[owner]!, index);
      lastModel[owner] = Math.max(lastModel[owner]!, index);
      if (pinned[index]) firstPinnedOwner = Math.min(firstPinnedOwner, owner);
    }
    if (pinned[index]) pinnedIndices.push(index);
    pinnedCostPrefix.push(
      pinnedCostPrefix.at(-1)! + (pinned[index] ? costs[index]! : 0),
    );
  });
  for (let index = records.length - 1; index >= 0; index--)
    firstModel[index] = Math.min(firstModel[index]!, firstModel[index + 1]!);
  for (let index = 1; index < records.length; index++)
    lastModel[index] = Math.max(lastModel[index]!, lastModel[index - 1]!);

  function byId<T extends { id: string }>(
    entries: readonly T[],
  ): Map<string, T[]> {
    const index = new Map<string, T[]>();
    for (const entry of entries) {
      const group = index.get(entry.id);
      if (group) group.push(entry);
      else index.set(entry.id, [entry]);
    }
    return index;
  }
  const boundaryIndex = byId(manifest.boundaries);
  const targetIndex = byId(manifest.targets);
  const summaryIndex = byId(manifest.segments);
  const header = `[Reflection source_id=${JSON.stringify(source.id)}]\n`;
  const headerTokens = estimateNativeTokens(header) + 12;
  type Reason = NativeProjectionOmission["reason"];
  const reasonCounts: Partial<Record<Reason, number>> = {};
  type Range = {
    end: number;
    archived: NativeArchivedRange;
    summary?: string;
    summaryText?: string;
    summaryTokens: number;
    warnings: NativeSourceOmission[];
    detailedText: string;
    detailedTokens: number;
    summaryTokensPrefix: number;
    reasonCounts: Partial<Record<Reason, number>>;
    sourcePrefixFingerprint: string;
    summaryPrefixFingerprint: string;
  };
  const validatedRanges: Pick<
    Range,
    "end" | "archived" | "summary" | "warnings" | "sourcePrefixFingerprint"
  >[] = [];
  // Preserve the v1 JSON-array framing exactly, without serializing each raw
  // prefix again for every candidate. Each completed raw record is read once.
  let sourceHash = createHash("sha256").update("[");
  const memo = options.memo;
  // The prefix link of the previous segment (null before the first), or
  // undefined once the chain of memoized links from the first record breaks.
  let predecessor: NativePrefixLink | null | undefined = null;
  let cursor = 0;
  for (const segment of segments) {
    const start = positions.get(segment.request.start_source_message_id);
    const end = positions.get(segment.request.end_source_message_id);
    if (
      !segment.closed ||
      start !== cursor ||
      end === undefined ||
      end < cursor
    )
      break;
    const slice = records.slice(cursor, end + 1);
    // A segment planned from these exact record objects through the memo was
    // already hashed and identified; its request object proves it.
    const entry = memo?.lookup(source, sessionId, slice);
    const known =
      entry !== undefined &&
      entry.request === segment.request &&
      entry.id === segment.id &&
      entry.fingerprint === segment.fingerprint;
    const request = known
      ? segment.request
      : {
          ...segment.request,
          messages: slice.map((record) => record.source),
        };
    if (
      request.source_id !== source.id ||
      request.session_id !== sessionId ||
      request.projection_version !== 3 ||
      request.source_boundary_version !== 3 ||
      slice.some((record) => !record.complete) ||
      !sameIds(segment.sourceMessageIds, slice) ||
      (!known &&
        (nativeSourceFingerprint(request) !== segment.fingerprint ||
          nativeSourceFingerprint(segment.request) !== segment.fingerprint ||
          nativeSegmentIdForRequest(request, source) !== segment.id))
    )
      break;
    const exact = (entry: {
      id: string;
      start_source_message_id: string;
      end_source_message_id: string;
      projection_version: number;
    }) =>
      entry.id === segment.id &&
      entry.start_source_message_id === request.start_source_message_id &&
      entry.end_source_message_id === request.end_source_message_id &&
      entry.projection_version === 3;
    const boundaries = boundaryIndex.get(segment.id) ?? [];
    const targets = targetIndex.get(segment.id) ?? [];
    // Conflicting metadata is not evidence of eligibility, even if one row matches.
    const eligible =
      targets.length > 0
        ? targets.every(
            (entry) =>
              exact(entry) && entry.source_fingerprint === segment.fingerprint,
          )
        : boundaries.length > 0 &&
          boundaries.every(
            (entry) =>
              exact(entry) &&
              entry.source_eligible &&
              entry.source_fingerprint === segment.fingerprint,
          );
    const summaries = summaryIndex.get(segment.id) ?? [];
    const summary =
      eligible && summaries.length === 1 && exact(summaries[0]!)
        ? summaries[0]!.summary
        : undefined;
    const archived: NativeArchivedRange = {
      id: segment.id,
      start_source_message_id: request.start_source_message_id,
      end_source_message_id: request.end_source_message_id,
      source_fingerprint: segment.fingerprint,
      source_message_ids: slice.map((record) => record.source.id),
    };
    const warnings = [
      ...new Set(slice.flatMap((record) => record.omissions ?? [])),
    ];
    // The raw prefix hash through this segment depends on every earlier
    // record, so resume it only when this link was built on the exact link
    // used for the previous segment in this pass (checked transitively).
    // Entries are created only by planning from canonical requests; prefix
    // links depend on record identity alone, so any entry for this exact
    // slice may carry one.
    let link = entry?.prefix;
    let sourcePrefixFingerprint: string;
    if (link && predecessor !== undefined && link.previous === predecessor) {
      sourceHash = link.hash.copy();
      sourcePrefixFingerprint = link.fingerprint;
    } else {
      for (let index = cursor; index <= end; index++) {
        if (index > 0) sourceHash.update(",");
        sourceHash.update(JSON.stringify(records[index]!.raw));
      }
      sourcePrefixFingerprint = sourceHash.copy().update("]").digest("hex");
      link = undefined;
      if (entry && predecessor !== undefined) {
        link = {
          previous: predecessor,
          hash: sourceHash.copy(),
          fingerprint: sourcePrefixFingerprint,
        };
        entry.prefix = link;
      }
    }
    predecessor = link;
    validatedRanges.push({
      end,
      summary,
      archived,
      warnings,
      sourcePrefixFingerprint,
    });
    cursor = end + 1;
  }

  const cached = new Map<string, NativeCachedSummary>();
  // Local storage is not an authority for source identity. Check the complete
  // prior raw prefix, exact canonical ranges, and the independent bounded-cache
  // digest before considering text. Legacy v1 checkpoints have no usable cache.
  if (
    options.manifestUnavailable === true &&
    previous?.version === 2 &&
    previous.source_id === source.id &&
    previous.session_id === sessionId &&
    Array.isArray(previous.archived) &&
    previous.archived.length > 0 &&
    previous.archived.length <= validatedRanges.length &&
    Array.isArray(previous.cachedSummaries) &&
    previous.cachedSummaries.length <= previous.archived.length &&
    [previous.context_limit, previous.input_limit].every(
      (value) => Number.isFinite(value) && value > 0,
    ) &&
    Number.isFinite(previous.output_limit) &&
    previous.output_limit >= 0 &&
    (previous.tail_start_source_id === null ||
      typeof previous.tail_start_source_id === "string") &&
    (previous.restored_user_id === null ||
      typeof previous.restored_user_id === "string") &&
    typeof previous.notice_id === "string" &&
    /^reflection-native-[a-f0-9]{32}$/.test(previous.notice_id) &&
    typeof previous.manifest_summary_fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(previous.manifest_summary_fingerprint) &&
    previous.source_prefix_fingerprint ===
      validatedRanges[previous.archived.length - 1]!.sourcePrefixFingerprint &&
    digest(previous.archived) ===
      digest(
        validatedRanges
          .slice(0, previous.archived.length)
          .map((range) => range.archived),
      )
  ) {
    let valid = true;
    let tokens = 0;
    const normalized: NativeCachedSummary[] = [];
    const seen = new Set<string>();
    const archivedById = new Map(
      validatedRanges
        .slice(0, previous.archived.length)
        .map((range) => [range.archived.id, range.archived]),
    );
    for (const value of previous.cachedSummaries) {
      const entry = object(value);
      const range =
        typeof entry?.id === "string" ? archivedById.get(entry.id) : undefined;
      if (
        !entry ||
        !range ||
        seen.has(range.id) ||
        entry.projection_version !== 3 ||
        typeof entry.summary !== "string" ||
        entry.start_source_message_id !== range.start_source_message_id ||
        entry.end_source_message_id !== range.end_source_message_id ||
        entry.source_fingerprint !== range.source_fingerprint
      ) {
        valid = false;
        break;
      }
      seen.add(range.id);
      tokens +=
        estimateNativeTokens(`Segment ${range.id}\n${entry.summary}`) + 2;
      normalized.push({
        id: range.id,
        start_source_message_id: range.start_source_message_id,
        end_source_message_id: range.end_source_message_id,
        source_fingerprint: range.source_fingerprint,
        projection_version: 3,
        summary: entry.summary,
      });
    }
    if (
      valid &&
      tokens <= Math.floor(previous.context_limit * 0.05) &&
      digest(normalized) === previous.cached_summaries_fingerprint
    ) {
      for (const entry of normalized) cached.set(entry.id, entry);
    }
  }

  const manifestEvidence = [
    ...manifest.boundaries,
    ...manifest.targets,
    ...manifest.segments,
  ];
  const ranges: Range[] = [];
  const summaryHash = createHash("sha256").update("[");
  for (const range of validatedRanges) {
    const { archived, warnings } = range;
    let summary = range.summary;
    const fallback = cached.get(archived.id);
    if (summary === undefined && fallback) {
      const start = positions.get(archived.start_source_message_id)!;
      // Even during an outage, supplied evidence for this range is authoritative:
      // absence of its eligible summary, a changed target, or an overlapping range
      // must not resurrect older cached text. Unrelated ranges do not invalidate it.
      const evidence = manifestEvidence.some((entry) => {
        if (entry.id === archived.id) return true;
        const entryStart = positions.get(entry.start_source_message_id);
        const entryEnd = positions.get(entry.end_source_message_id);
        return (
          entryStart !== undefined &&
          entryEnd !== undefined &&
          entryStart <= range.end &&
          entryEnd >= start
        );
      });
      if (!evidence) summary = fallback.summary;
    }
    const reasons: Reason[] =
      summary === undefined
        ? ["missing-or-stale-summary", ...warnings]
        : warnings;
    for (const reason of reasons)
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    if (summary !== undefined)
      reasonCounts["summary-budget"] =
        (reasonCounts["summary-budget"] ?? 0) + 1;
    const heading = `Segment ${archived.id}\n`;
    const summaryText = summary === undefined ? undefined : heading + summary;
    const detailedText =
      heading +
      [
        ...(summary === undefined ? [] : [summary]),
        ...reasons.map(
          (reason) =>
            `[Reflection omitted ${archived.start_source_message_id}..${archived.end_source_message_id}: ${reason}]`,
        ),
      ].join("\n\n");
    if (ranges.length > 0) summaryHash.update(",");
    summaryHash.update(JSON.stringify([archived, summary ?? null]));
    const summaryTokens =
      summaryText === undefined ? 0 : estimateNativeTokens(summaryText) + 2;
    ranges.push({
      ...range,
      summary,
      summaryText,
      archived,
      warnings,
      detailedText,
      summaryTokens,
      detailedTokens:
        (ranges.at(-1)?.detailedTokens ?? 0) +
        estimateNativeTokens(detailedText) +
        2,
      summaryTokensPrefix:
        (ranges.at(-1)?.summaryTokensPrefix ?? 0) + summaryTokens,
      reasonCounts: { ...reasonCounts },
      summaryPrefixFingerprint: summaryHash.copy().update("]").digest("hex"),
    });
  }

  function candidate(
    count: number,
    forcedSummaries?: Set<number>,
  ): NativeProjectionResult | undefined {
    if (ambiguousToolMapping) return;
    const last = ranges[count - 1]!;
    const end = last.end;
    const tailStartIndex = firstModel[end + 1]!;
    // Unknown messages remain pinned, but a mapped archived group in the tail
    // makes this cutoff impossible. Never drop or duplicate half a group.
    if (lastModel[end]! >= tailStartIndex || firstPinnedOwner <= end) return;
    // Only exact checkpoint reconstruction may keep a formerly restored user
    // after a newer user arrives in the raw tail. The completed identity and
    // notice must still match the checkpoint, and measured usage must authorize
    // that exact rendering below. Fresh candidates always use the latest user.
    let anchorUser = latestUser;
    let anchorModels = latestUserModels;
    if (forcedSummaries !== undefined) {
      const restored = previous?.restored_user_id;
      if (restored === null) {
        anchorUser = -1;
      } else {
        const index =
          typeof restored === "string" ? positions.get(restored) : undefined;
        if (
          index === undefined ||
          index > end ||
          records[index]!.raw.type !== "user"
        )
          return;
        anchorUser = index;
        anchorModels = messages.flatMap((message, modelIndex) =>
          message.id === restored ? [modelIndex] : [],
        );
      }
    }
    let anchorMessageIndex: number | undefined;
    if (anchorUser >= 0 && anchorUser <= end) {
      if (anchorModels.length !== 1) return;
      anchorMessageIndex = anchorModels[0]!;
      if (messages[anchorMessageIndex]!.role !== "user") return;
      if (
        forcedSummaries !== undefined &&
        (anchorMessageIndex >= tailStartIndex ||
          pinned[anchorMessageIndex] ||
          owners[anchorMessageIndex]!.length !== 1 ||
          owners[anchorMessageIndex]![0] !== anchorUser)
      )
        return;
    }
    if (last.reasonCounts["missing-or-stale-summary"] && !options.allowLossy)
      return;
    const baseTokens =
      fixedTokens +
      pinnedCostPrefix[tailStartIndex]! +
      tailCost(tailStartIndex) +
      (anchorMessageIndex === undefined ? 0 : costs[anchorMessageIndex]!);
    const conservativeBudget = Math.min(summaryBudget, hard - baseTokens);
    let usageBacked = false;
    const build = (
      noticeBudget: number,
      forceAggregate = forcedSummaries !== undefined,
    ): NativeProjectionResult | undefined => {
      if (headerTokens > noticeBudget) return;
      let text: string;
      let keptSummaries: Set<number> | undefined;
      if (
        !forceAggregate &&
        headerTokens + last.detailedTokens <= noticeBudget
      ) {
        text =
          header +
          ranges
            .slice(0, count)
            .map((range) => range.detailedText)
            .join("\n\n");
      } else {
        // Only first/last references fit a bounded aggregate. Exact intermediate
        // metadata stays in the operator's plan, not in a model-accessible tool.
        const counts = { ...last.reasonCounts };
        const marker = (includeSummaryBudget = true) =>
          `[Reflection omitted ${count} ranges: ${Object.entries(counts)
            .filter(
              ([reason, total]) =>
                total! > 0 &&
                (includeSummaryBudget || reason !== "summary-budget"),
            )
            .map(([reason, total]) => `${reason}=${total}`)
            .join(
              ", ",
            )}. First Segment ${ranges[0]!.archived.id}; last Segment ${last.archived.id}. Intermediate references omitted for budget.]`;
        // If all available summaries fit, do not reserve a summary-budget warning
        // that will disappear. This also avoids shedding cached text on an outage
        // merely because older uncached ranges now need a missing-summary warning.
        if (forcedSummaries !== undefined) {
          if (
            !options.allowLossy &&
            last.reasonCounts["summary-budget"] !== forcedSummaries.size
          )
            return;
          keptSummaries = forcedSummaries;
          for (const index of keptSummaries) counts["summary-budget"]! -= 1;
        } else {
          const allSummaryMarkerTokens =
            estimateNativeTokens(marker(false)) + 2;
          const markerTokens =
            headerTokens + allSummaryMarkerTokens + last.summaryTokensPrefix <=
            noticeBudget
              ? allSummaryMarkerTokens
              : estimateNativeTokens(marker()) + 2;
          let remaining = noticeBudget - headerTokens - markerTokens;
          if (
            remaining < 0 ||
            (!options.allowLossy && last.summaryTokensPrefix > remaining)
          )
            return;
          keptSummaries = new Set<number>();
          for (let index = count - 1; index >= 0; index--) {
            const range = ranges[index]!;
            if (range.summary === undefined || range.summaryTokens > remaining)
              continue;
            keptSummaries.add(index);
            remaining -= range.summaryTokens;
            counts["summary-budget"]! -= 1;
          }
        }
        const texts = [...keptSummaries]
          .sort((a, b) => a - b)
          .map((index) => ranges[index]!.summaryText!);
        text = header + [marker(), ...texts].join("\n\n");
      }
      if (estimateNativeTokens(text) + 12 > summaryBudget) return;
      const selected = ranges.slice(0, count);
      const omissions: NativeProjectionOmission[] = [];
      selected.forEach((range, index) => {
        const reasons: Reason[] = [...range.warnings];
        if (range.summary === undefined)
          reasons.unshift("missing-or-stale-summary");
        else if (keptSummaries && !keptSummaries.has(index))
          reasons.unshift("summary-budget");
        for (const reason of reasons)
          omissions.push({
            segmentId: range.archived.id,
            startSourceMessageId: range.archived.start_source_message_id,
            endSourceMessageId: range.archived.end_source_message_id,
            reason,
          });
      });
      const preservedPrefixIndices = pinnedIndices.filter(
        (index) => index < tailStartIndex,
      );
      const cachedSummaries: NativeCachedSummary[] = selected.flatMap(
        (range, index) =>
          range.summary === undefined ||
          (keptSummaries && !keptSummaries.has(index))
            ? []
            : [
                {
                  id: range.archived.id,
                  start_source_message_id:
                    range.archived.start_source_message_id,
                  end_source_message_id: range.archived.end_source_message_id,
                  source_fingerprint: range.archived.source_fingerprint,
                  projection_version: 3,
                  summary: range.summary,
                },
              ],
      );
      const identity = {
        version: 2 as const,
        source_id: source.id,
        session_id: sessionId,
        archived: selected.map((range) => range.archived),
        source_prefix_fingerprint: last.sourcePrefixFingerprint,
        tail_start_source_id: records[end + 1]?.source.id ?? null,
        restored_user_id:
          anchorMessageIndex === undefined
            ? null
            : records[anchorUser]!.source.id,
        manifest_summary_fingerprint: last.summaryPrefixFingerprint,
        cachedSummaries,
        cached_summaries_fingerprint: digest(cachedSummaries),
        context_limit: options.contextLimit,
        input_limit: inputLimit,
        output_limit: options.outputLimit,
      };
      const noticeId = `reflection-native-${digest([identity, text]).slice(0, 32)}`;
      const notice = {
        id: noticeId,
        text,
        ...(anchorMessageIndex === undefined ? {} : { anchorMessageIndex }),
      };
      const shape = { tailStartIndex, preservedPrefixIndices, notice };
      const conservativeTokens = baseTokens + estimateNativeTokens(text) + 12;
      const measured = usageEstimate(shape);
      usageBacked = measured !== undefined;
      const estimatedTokens = measured ?? conservativeTokens;
      if (estimatedTokens > hard) return;
      const checkpoint: NativeProjectionCheckpoint = {
        ...identity,
        notice_id: noticeId,
      };
      const reused =
        previous !== undefined && digest(previous) === digest(checkpoint);
      if (
        forcedSummaries !== undefined &&
        (measured === undefined || !reused || noticeId !== previous?.notice_id)
      )
        return;
      return {
        tailStartIndex,
        preservedPrefixIndices,
        notice,
        checkpoint: reused ? previous : checkpoint,
        lossy: omissions.length > 0,
        omissions,
        estimatedTokens,
        reset: !reused,
      };
    };
    // Re-render the exact old selection independently of today's conservative
    // base. Only measured whole-input usage may authorize that old notice.
    if (forcedSummaries !== undefined)
      return build(summaryBudget, false) ?? build(summaryBudget);
    // The whole-payload estimate must not discard a usage-backed plan before
    // the caller sees its actual notice. Keep the old tighter notice budget
    // when usage is unavailable, including for this exact candidate.
    const full = build(summaryBudget);
    if (full && (conservativeBudget >= summaryBudget || usageBacked))
      return full;
    if (conservativeBudget < summaryBudget) return build(conservativeBudget);
    return full;
  }

  // Recompute budgets/mapping on every invocation; raw model messages and user
  // content are never cached. Unrelated summaries cannot perturb an ordinary loop.
  if (
    previous?.version === 2 &&
    previous.source_id === source.id &&
    previous.session_id === sessionId &&
    Array.isArray(previous.archived)
  ) {
    const count = previous.archived.length;
    if (count > 0 && count <= ranges.length) {
      if (Array.isArray(previous.cachedSummaries)) {
        const selected = new Set<number>();
        let next = 0;
        let valid = true;
        for (const cachedSummary of previous.cachedSummaries) {
          const entry = object(cachedSummary);
          while (next < count && ranges[next]!.archived.id !== entry?.id)
            next++;
          const range = ranges[next];
          if (
            next >= count ||
            !range ||
            entry?.projection_version !== 3 ||
            entry.summary !== range.summary ||
            entry.start_source_message_id !==
              range.archived.start_source_message_id ||
            entry.end_source_message_id !==
              range.archived.end_source_message_id ||
            entry.source_fingerprint !== range.archived.source_fingerprint
          ) {
            valid = false;
            break;
          }
          selected.add(next++);
        }
        if (valid) {
          const forced = candidate(count, selected);
          if (forced && forced.estimatedTokens <= soft) return forced;
        }
      }
      const existing = candidate(count);
      if (
        existing &&
        existing.checkpoint &&
        digest(previous.archived) === digest(existing.checkpoint.archived) &&
        previous.source_prefix_fingerprint ===
          existing.checkpoint.source_prefix_fingerprint &&
        previous.tail_start_source_id ===
          existing.checkpoint.tail_start_source_id &&
        existing.estimatedTokens <= soft
      )
        return existing;
    }
  }
  if (rawTokens <= soft) return raw();
  const target = options.contextLimit * 0.25;
  const firstTarget = ranges.findIndex(
    (range) => tailCost(firstModel[range.end + 1]!) <= target,
  );
  const start = firstTarget < 0 ? ranges.length : firstTarget;
  // Earliest fitting target cutoff, otherwise latest fitting larger raw tail.
  // Stop at the first success; never construct every possible checkpoint.
  for (let index = start; index < ranges.length; index++) {
    const plan = candidate(index + 1);
    if (plan) return plan;
  }
  for (let index = start - 1; index >= 0; index--) {
    const plan = candidate(index + 1);
    if (plan) return plan;
  }
  if (rawTokens > hard)
    fail("no source-safe native projection fits the hard input budget");
  return raw(
    "no eligible closed source prefix fits projection budgets; retaining raw context below hard limit",
  );
}
