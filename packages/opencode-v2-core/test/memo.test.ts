import { describe, expect, it } from "vitest";
import type { NativeSessionSegmentsResponse } from "@reflection/shared/native";
import {
  canonicalizeNativeHistory,
  type NativeCanonicalRecord,
} from "../src/history.js";
import { NativeSegmentMemo } from "../src/memo.js";
import {
  planNativeSegments,
  type NativePlannedSegment,
} from "../src/segmentation.js";
import {
  projectNativeContext,
  type ModelMessageLike,
  type NativeProjectionOptions,
} from "../src/projection.js";

const source = {
  id: "source-a",
  kind: "opencode-v2",
  identity_scheme: "source-v1",
} as const;
const user = (id: string, text = "actual request") => ({
  id,
  type: "user",
  text,
  time: { created: 100 },
});
const assistant = (id: string, text = `${id}:` + "x".repeat(12_000)) => ({
  id,
  type: "assistant",
  time: { created: 0, completed: 1 },
  agent: "build",
  model: { providerID: "openai", id: "test" },
  content: [{ type: "text", text }],
});
const history = (turns: number) =>
  Array.from({ length: turns }, (_, turn) => [
    user(`u${turn}`),
    assistant(`a${turn}`),
  ]).flat();

function plan(
  records: readonly NativeCanonicalRecord[],
  memo?: NativeSegmentMemo,
  manifest?: NativeSessionSegmentsResponse,
) {
  return planNativeSegments({
    source,
    sessionId: "s",
    records,
    softLimitChars: 1000,
    ...(manifest ? { manifest } : {}),
    ...(memo ? { memo } : {}),
  });
}

// Summaries exist for every segment of the reference history, so a changed
// segment keeps its old boundary but loses eligibility.
function manifestFor(
  segments: readonly NativePlannedSegment[],
): NativeSessionSegmentsResponse {
  const bounds = (segment: NativePlannedSegment) => ({
    id: segment.id,
    projection_version: 3 as const,
    source_boundary_version: 3 as const,
    start_source_message_id: segment.request.start_source_message_id,
    end_source_message_id: segment.request.end_source_message_id,
  });
  return {
    source_id: source.id,
    session_id: "s",
    manifest_version: 3,
    targets: [],
    boundaries: segments.map((segment) => ({
      ...bounds(segment),
      source_eligible: true,
      source_fingerprint: segment.fingerprint,
    })),
    segments: segments.map((segment) => ({
      ...bounds(segment),
      summary: `Archived ${segment.id}.`,
    })),
  };
}

function options(
  records: readonly NativeCanonicalRecord[],
  segments: readonly NativePlannedSegment[],
  manifest: NativeSessionSegmentsResponse,
  memo?: NativeSegmentMemo,
): NativeProjectionOptions {
  const messages: ModelMessageLike[] = records.map((record) => ({
    id: record.raw.id,
    role: record.raw.type === "assistant" ? "assistant" : "user",
    content:
      record.raw.type === "assistant" ? record.raw.content : record.raw.text,
  }));
  return {
    source,
    sessionId: "s",
    records,
    segments,
    manifest,
    messages,
    system: "system instructions",
    tools: {},
    contextLimit: 12_000,
    outputLimit: 500,
    allowLossy: true,
    ...(memo ? { memo } : {}),
  };
}

// A plan or the exact error it failed with.
function outcome(run: () => unknown) {
  try {
    return { plan: run() };
  } catch (error) {
    return { error: String(error) };
  }
}

// Projects with and without the memo and requires identical plans.
function projectBoth(
  records: readonly NativeCanonicalRecord[],
  manifest: NativeSessionSegmentsResponse,
  memo: NativeSegmentMemo,
  segments = plan(records, memo, manifest),
) {
  const withMemo = projectNativeContext(
    options(records, segments, manifest, memo),
  );
  const without = projectNativeContext(
    options(records, plan(records, undefined, manifest), manifest),
  );
  expect(withMemo).toEqual(without);
  return withMemo;
}

describe("per-segment memo", () => {
  it("reuses identical request objects for unchanged records and matches planning without it", () => {
    const memo = new NativeSegmentMemo();
    const records = canonicalizeNativeHistory(history(6));
    const first = plan(records, memo);
    const second = plan(records, memo);
    expect(second).toEqual(plan(records));
    expect(second.map((segment) => segment.request)).toEqual(
      first.map((segment) => segment.request),
    );
    second.forEach((segment, index) =>
      expect(segment.request).toBe(first[index]!.request),
    );

    // Appended records reuse every unchanged prefix segment.
    const grown = [
      ...records,
      ...canonicalizeNativeHistory([user("u6"), assistant("a6")]),
    ];
    const third = plan(grown, memo);
    expect(third).toEqual(plan(grown));
    first.forEach((segment, index) =>
      expect(third[index]!.request).toBe(segment.request),
    );
  });

  it("misses on fresh record objects even when their content is identical", () => {
    const memo = new NativeSegmentMemo();
    const first = plan(canonicalizeNativeHistory(history(4)), memo);
    const again = plan(canonicalizeNativeHistory(history(4)), memo);
    expect(again).toEqual(first);
    again.forEach((segment, index) =>
      expect(segment.request).not.toBe(first[index]!.request),
    );
  });

  it("matches projection without the memo across growing steps", () => {
    const memo = new NativeSegmentMemo();
    const reference = canonicalizeNativeHistory(history(10));
    const manifest = manifestFor(plan(reference));
    let records = reference.slice(0, 12);
    for (let step = 0; step < 4; step++) {
      const result = projectBoth(records, manifest, memo);
      if (step === 3) expect(result.notice).toBeDefined();
      records = [
        ...records,
        ...reference.slice(records.length, records.length + 2),
      ];
    }
  });

  it("rejects changed content under stale segments despite a warm memo", () => {
    const memo = new NativeSegmentMemo();
    const records = canonicalizeNativeHistory(history(8));
    const manifest = manifestFor(plan(records));
    const stale = plan(records, memo, manifest);
    projectBoth(records, manifest, memo, stale);

    const changed = history(8);
    changed[13] = assistant("a6", "a6: changed " + "y".repeat(12_000));
    const rewritten = canonicalizeNativeHistory(changed);
    const withMemo = outcome(() =>
      projectNativeContext(options(rewritten, stale, manifest, memo)),
    );
    expect(withMemo).toEqual(
      outcome(() => projectNativeContext(options(rewritten, stale, manifest))),
    );
    // The stale plan archives up to the changed segment, never past it.
    const archived = (
      withMemo as { plan: ReturnType<typeof projectNativeContext> }
    ).plan.checkpoint!.archived.map((range) => range.id);
    expect(archived.length).toBeGreaterThan(0);
    expect(archived).not.toContain(stale[13]!.id);
    expect(stale[13]!.sourceMessageIds).toEqual(["a6"]);
  });

  it("fully checks a segment whose request is not the memoized object", () => {
    const memo = new NativeSegmentMemo();
    const records = canonicalizeNativeHistory(history(8));
    const manifest = manifestFor(plan(records));
    const segments = plan(records, memo, manifest);
    projectBoth(records, manifest, memo, segments);

    // An equal but distinct request still validates.
    const cloned = segments.map((segment) => ({
      ...segment,
      request: { ...segment.request, messages: [...segment.request.messages] },
    }));
    projectBoth(records, manifest, memo, cloned);

    // A distinct request with foreign content fails its fingerprint check
    // even though the records are memoized.
    const forged = segments.map((segment, index) =>
      index === 13
        ? {
            ...segment,
            request: {
              ...segment.request,
              messages: segment.request.messages.map((message) => ({
                ...message,
                text: "forged",
              })),
            },
          }
        : segment,
    );
    const withMemo = outcome(() =>
      projectNativeContext(options(records, forged, manifest, memo)),
    );
    expect(withMemo).toEqual(
      outcome(() => projectNativeContext(options(records, forged, manifest))),
    );
    // Nothing from the forged segment onward is archived.
    const archived = (
      withMemo as { plan: ReturnType<typeof projectNativeContext> }
    ).plan.checkpoint!.archived.map((range) => range.id);
    expect(archived.length).toBeGreaterThan(0);
    expect(archived).not.toContain(forged[13]!.id);
  });

  it("resumes the raw prefix hash only along an identical chain", () => {
    const memo = new NativeSegmentMemo();
    const records = canonicalizeNativeHistory(history(8));
    const manifest = manifestFor(plan(records));
    projectBoth(records, manifest, memo);

    // Change an early record; later record objects stay identical, so their
    // stored prefix hashes (which include the old content) must not be reused.
    const changed = [...records];
    changed[1] = canonicalizeNativeHistory([
      assistant("a0", "a0: changed " + "z".repeat(12_000)),
    ])[0]!;
    const result = projectBoth(changed, manifest, memo);
    expect(result.checkpoint).toBeDefined();
  });

  it("misses when any record after the first is a different object", () => {
    const memo = new NativeSegmentMemo();
    const small = Array.from({ length: 12 }, (_, index) =>
      index % 2 === 0
        ? user(`u${index}`, `u${index}:` + "q".repeat(200))
        : assistant(`a${index}`, `a${index}:` + "r".repeat(200)),
    );
    const records = canonicalizeNativeHistory(small);
    const first = plan(records, memo);
    expect(first[0]!.sourceMessageIds.length).toBeGreaterThan(2);
    const changed = [...records];
    changed[2] = canonicalizeNativeHistory([
      user("u2", "u2: changed " + "q".repeat(200)),
    ])[0]!;
    const replanned = plan(changed, memo);
    expect(replanned).toEqual(plan(changed));
    expect(replanned[0]!.fingerprint).not.toBe(first[0]!.fingerprint);
  });

  it("fully checks a memoized request carrying a tampered fingerprint or ID", () => {
    const memo = new NativeSegmentMemo();
    const records = canonicalizeNativeHistory(history(8));
    const manifest = manifestFor(plan(records));
    const segments = plan(records, memo, manifest);
    projectBoth(records, manifest, memo, segments);
    for (const tamper of [
      { fingerprint: "f".repeat(64) },
      { id: "00000000-0000-4000-8000-000000000000" },
    ]) {
      const tampered = segments.map((segment, index) =>
        index === 13 ? { ...segment, ...tamper } : segment,
      );
      const withMemo = outcome(() =>
        projectNativeContext(options(records, tampered, manifest, memo)),
      );
      expect(withMemo).toEqual(
        outcome(() =>
          projectNativeContext(options(records, tampered, manifest)),
        ),
      );
      const archived = (
        withMemo as { plan: ReturnType<typeof projectNativeContext> }
      ).plan.checkpoint!.archived;
      expect(archived.length).toBe(13);
    }
  });

  it("never adopts caller-built requests as canonical memo entries", () => {
    const memo = new NativeSegmentMemo();
    const records = canonicalizeNativeHistory(history(8));
    const manifest = manifestFor(plan(records));
    // Unfingerprinted fields such as priority must not leak into planning.
    const external = plan(records, undefined, manifest).map((segment) => ({
      ...segment,
      request: { ...segment.request, processing_priority: 7 },
    }));
    projectBoth(records, manifest, memo, external);
    const planned = plan(records, memo, manifest);
    expect(planned).toEqual(plan(records, undefined, manifest));
    planned.forEach((segment, index) => {
      expect(segment.request).not.toBe(external[index]!.request);
      expect(segment.request.processing_priority).toBe(0);
    });
  });

  it("bounds entries that share a first record", () => {
    const memo = new NativeSegmentMemo();
    const records = canonicalizeNativeHistory(history(6));
    const request = plan(records)[0]!.request;
    for (let length = 1; length <= 9; length++)
      memo.remember(
        source,
        "s",
        records.slice(0, length),
        { request: structuredClone(request), id: "i", fingerprint: "f" },
        0,
      );
    expect(memo.lookup(source, "s", records.slice(0, 1))).toBeUndefined();
    expect(memo.lookup(source, "s", records.slice(0, 9))).toBeDefined();
    expect(memo.lookup(source, "other", records.slice(0, 9))).toBeUndefined();
  });
});
