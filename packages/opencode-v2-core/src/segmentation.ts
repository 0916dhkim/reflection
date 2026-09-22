import {
  MAX_MESSAGE_TEXT_CHARS,
  MAX_SEGMENT_TEXT_CHARS,
  codePointLength,
} from "@reflection/shared/contracts";
import {
  nativeSegmentIdForRequest,
  nativeSourceFingerprint,
  parseNativeSegmentCreate,
  parseNativeSessionSegmentsResponse,
  type NativeSegmentCreate,
  type NativeSessionSegmentsResponse,
} from "@reflection/shared/native";
import type { SourceInfo } from "@reflection/shared/sources";

import type { NativeCanonicalRecord } from "./history.js";

export interface NativePlannedSegment {
  request: NativeSegmentCreate;
  id: string;
  fingerprint: string;
  closed: boolean;
  sourceMessageIds: string[];
  weightedChars: number;
}

export interface NativeSegmentPlanOptions {
  source: SourceInfo;
  sessionId: string;
  records: readonly NativeCanonicalRecord[];
  manifest?: NativeSessionSegmentsResponse;
  softLimitChars?: number;
  allowOpenSnapshot?: boolean;
}

interface Anchor {
  start: number;
  end: number;
  target: boolean;
}

function requireSource(source: SourceInfo): void {
  if (source.kind !== "opencode-v2" || source.identity_scheme !== "source-v1") {
    throw new Error(
      "native segmentation requires an opencode-v2 source-v1 registry entry",
    );
  }
}

function validateRecords(
  records: readonly NativeCanonicalRecord[],
): Map<string, number> {
  const positions = new Map<string, number>();
  records.forEach((record, index) => {
    if (record.source.id !== record.raw.id || positions.has(record.source.id)) {
      throw new Error("native canonical records must have unique matching IDs");
    }
    if (codePointLength(record.source.text) > MAX_MESSAGE_TEXT_CHARS) {
      throw new Error(
        `native source message ${record.source.id} exceeds the message text limit`,
      );
    }
    positions.set(record.source.id, index);
  });
  return positions;
}

function anchorsFor(
  manifest: NativeSessionSegmentsResponse | undefined,
  source: SourceInfo,
  sessionId: string,
  records: readonly NativeCanonicalRecord[],
  positions: ReadonlyMap<string, number>,
): Anchor[] {
  if (manifest === undefined) return [];
  const parsed = parseNativeSessionSegmentsResponse(manifest, source.id);
  if (parsed.session_id !== sessionId) {
    throw new Error("native manifest session does not match segment plan");
  }
  const raw = [
    ...parsed.boundaries.map((entry) => ({ ...entry, target: false })),
    ...parsed.targets.map((entry) => ({ ...entry, target: true })),
  ];
  const anchors: Anchor[] = [];
  for (const entry of raw) {
    const start = positions.get(entry.start_source_message_id);
    const end = positions.get(entry.end_source_message_id);
    // A retained manifest can outlive a locally rewound transcript. Its
    // missing endpoint is intentionally discarded so the remaining history is
    // replanned rather than being covered by an impossible range.
    if (start === undefined || end === undefined) continue;
    if (end < start) throw new Error("native manifest anchor is reversed");
    const request = requestFor(
      source,
      sessionId,
      records.slice(start, end + 1),
    );
    if (nativeSegmentIdForRequest(request, source) !== entry.id) {
      throw new Error("native manifest anchor has an invalid deterministic ID");
    }
    anchors.push({
      start,
      end,
      target: entry.target,
    });
  }
  anchors.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const unique: Anchor[] = [];
  for (const anchor of anchors) {
    const previous = unique.at(-1);
    if (previous === undefined) {
      unique.push(anchor);
      continue;
    }
    if (anchor.start === previous.start) {
      if (anchor.target !== previous.target) {
        unique[unique.length - 1] = anchor.target ? anchor : previous;
        continue;
      }
      if (anchor.end !== previous.end) {
        throw new Error("native manifest anchors with the same start conflict");
      }
      continue;
    }
    if (anchor.start <= previous.end) {
      throw new Error("native manifest anchors overlap");
    }
    unique.push(anchor);
  }
  return unique;
}

function requestFor(
  source: SourceInfo,
  sessionId: string,
  records: readonly NativeCanonicalRecord[],
): NativeSegmentCreate {
  const first = records[0];
  const last = records.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error("cannot create an empty native segment");
  }
  return parseNativeSegmentCreate({
    source_id: source.id,
    session_id: sessionId,
    source_boundary_version: 3,
    start_source_message_id: first.source.id,
    end_source_message_id: last.source.id,
    projection_version: 3,
    processing_priority: 0,
    messages: records.map((record) => record.source),
  });
}

function planned(
  source: SourceInfo,
  sessionId: string,
  records: readonly NativeCanonicalRecord[],
  closed: boolean,
): NativePlannedSegment {
  const request = requestFor(source, sessionId, records);
  return {
    request,
    id: nativeSegmentIdForRequest(request, source),
    fingerprint: nativeSourceFingerprint(request),
    closed,
    sourceMessageIds: records.map((record) => record.source.id),
    weightedChars: records.reduce(
      (total, record) => total + record.weightedChars,
      0,
    ),
  };
}

function assertSegmentSize(records: readonly NativeCanonicalRecord[]): void {
  const size = records.reduce(
    (total, record) => total + codePointLength(record.source.text),
    0,
  );
  if (size > MAX_SEGMENT_TEXT_CHARS) {
    throw new Error(
      "native segment exceeds the segment text limit and cannot be split safely",
    );
  }
}

/**
 * Plans exact native message ranges. The first incomplete record is an
 * absolute transcript barrier: records after it are never skipped into a
 * supposedly contiguous segment.
 */
export function planNativeSegments({
  source,
  sessionId,
  records,
  manifest,
  softLimitChars = 20_000,
  allowOpenSnapshot = false,
}: NativeSegmentPlanOptions): NativePlannedSegment[] {
  requireSource(source);
  if (!Number.isInteger(softLimitChars) || softLimitChars <= 0) {
    throw new Error("native soft segment limit must be a positive integer");
  }
  const positions = validateRecords(records);
  const anchors = anchorsFor(manifest, source, sessionId, records, positions);
  const barrier = records.findIndex((record) => !record.complete);
  const end = barrier === -1 ? records.length : barrier;
  const completeRecords = records.slice(0, end);
  const result: NativePlannedSegment[] = [];
  let cursor = 0;

  for (const anchor of anchors) {
    if (anchor.start >= end) break;
    if (anchor.end >= end) break;
    while (cursor < anchor.start) {
      const nextAnchor = anchor.start;
      const chunk: NativeCanonicalRecord[] = [];
      let weight = 0;
      while (cursor < nextAnchor) {
        const candidate = completeRecords[cursor]!;
        if (
          chunk.length > 0 &&
          weight + candidate.weightedChars > softLimitChars
        ) {
          result.push(planned(source, sessionId, chunk, true));
          chunk.length = 0;
          weight = 0;
        }
        chunk.push(candidate);
        weight += candidate.weightedChars;
        cursor += 1;
        if (weight === softLimitChars || weight > softLimitChars) {
          result.push(planned(source, sessionId, chunk, true));
          chunk.length = 0;
          weight = 0;
        }
      }
      if (chunk.length > 0) {
        result.push(planned(source, sessionId, chunk, true));
      }
    }
    if (cursor !== anchor.start)
      throw new Error("native manifest anchor is not contiguous");
    const anchored = completeRecords.slice(anchor.start, anchor.end + 1);
    assertSegmentSize(anchored);
    // The anchor fixes the range even when its current fingerprint differs;
    // the new request then replaces/re-extracts the changed payload in place.
    const closed =
      anchor.end < records.length - 1 ||
      anchored.reduce((total, record) => total + record.weightedChars, 0) >=
        softLimitChars;
    if (closed || allowOpenSnapshot) {
      result.push(planned(source, sessionId, anchored, closed));
    }
    cursor = anchor.end + 1;
  }

  const tail: NativeCanonicalRecord[] = [];
  let weight = 0;
  while (cursor < completeRecords.length) {
    const candidate = completeRecords[cursor]!;
    if (tail.length > 0 && weight + candidate.weightedChars > softLimitChars) {
      result.push(planned(source, sessionId, tail, true));
      tail.length = 0;
      weight = 0;
    }
    tail.push(candidate);
    weight += candidate.weightedChars;
    cursor += 1;
    if (weight >= softLimitChars) {
      result.push(planned(source, sessionId, tail, true));
      tail.length = 0;
      weight = 0;
    }
  }
  if (tail.length > 0 && allowOpenSnapshot) {
    assertSegmentSize(tail);
    result.push(planned(source, sessionId, tail, false));
  }
  return result;
}

export function hydrateNativeRange(
  records: readonly NativeCanonicalRecord[],
  boundary: Pick<
    NativeSegmentCreate,
    "start_source_message_id" | "end_source_message_id"
  >,
): import("@reflection/shared/native").NativeSourceMessage[] {
  const positions = validateRecords(records);
  const start = positions.get(boundary.start_source_message_id);
  const end = positions.get(boundary.end_source_message_id);
  if (start === undefined || end === undefined) {
    throw new Error("native hydration boundary was not found");
  }
  if (end < start) throw new Error("native hydration boundary is out of order");
  const range = records.slice(start, end + 1);
  if (range.some((record) => !record.complete)) {
    throw new Error("native hydration boundary includes an incomplete record");
  }
  return range.map((record) => record.source);
}

export function validateNativeSegmentRequest(
  snapshot: readonly NativeCanonicalRecord[],
  expectedRequest: NativeSegmentCreate,
): void {
  const expected = parseNativeSegmentCreate(expectedRequest);
  const messages = hydrateNativeRange(snapshot, expected);
  const actual = parseNativeSegmentCreate({ ...expected, messages });
  if (nativeSourceFingerprint(actual) !== nativeSourceFingerprint(expected)) {
    throw new Error(
      "native segment request no longer matches the history snapshot",
    );
  }
}
