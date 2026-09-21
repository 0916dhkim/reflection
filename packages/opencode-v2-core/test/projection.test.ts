import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { NativeSessionSegmentsResponse } from "@reflection/shared/native";
import { canonicalizeNativeHistory } from "../src/history.js";
import { planNativeSegments } from "../src/segmentation.js";
import {
  estimateNativeTokens,
  NativeProjectionError,
  projectNativeContext,
  type ModelMessageLike,
  type NativeProjectionOptions,
  type NativeProjectionResult,
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
const assistant = (id: string, text = "x".repeat(12_000)) => ({
  id,
  type: "assistant",
  time: { created: 0, completed: 1 },
  agent: "build",
  model: { providerID: "openai", id: "test" },
  content: [{ type: "text", text }],
});

function fixture(
  history: unknown[] = [user("u"), assistant("a"), assistant("tail", "recent")],
  softLimitChars = 1000,
  sourceInfo: NativeProjectionOptions["source"] = source,
): NativeProjectionOptions {
  const records = canonicalizeNativeHistory(history);
  const segments = planNativeSegments({
    source: sourceInfo,
    sessionId: "s",
    records,
    softLimitChars,
  });
  const manifest: NativeSessionSegmentsResponse = {
    source_id: sourceInfo.id,
    session_id: "s",
    manifest_version: 3,
    targets: [],
    boundaries: segments.map((segment) => ({
      id: segment.id,
      projection_version: 3,
      source_boundary_version: 3,
      start_source_message_id: segment.request.start_source_message_id,
      end_source_message_id: segment.request.end_source_message_id,
      source_eligible: true,
      source_fingerprint: segment.fingerprint,
    })),
    segments: segments.map((segment) => ({
      id: segment.id,
      projection_version: 3,
      source_boundary_version: 3,
      start_source_message_id: segment.request.start_source_message_id,
      end_source_message_id: segment.request.end_source_message_id,
      summary: "Archived work.",
    })),
  };
  const messages: ModelMessageLike[] = records.map((record) => ({
    id: record.raw.id,
    role: record.raw.type === "assistant" ? "assistant" : "user",
    content:
      record.raw.type === "assistant" ? record.raw.content : record.raw.text,
  }));
  return {
    source: sourceInfo,
    sessionId: "s",
    records,
    segments,
    manifest,
    messages,
    system: "system instructions",
    tools: { search: { description: "Search" } },
    contextLimit: 5000,
    outputLimit: 500,
  };
}

function retained(
  plan: NativeProjectionResult,
  input: NativeProjectionOptions,
): number[] {
  return [
    ...plan.preservedPrefixIndices,
    ...input.messages.flatMap((_, index) =>
      index >= plan.tailStartIndex ? [index] : [],
    ),
  ];
}

describe("native projection plans", () => {
  it("labels verified summaries with the actual source and exact segment identities", () => {
    const input = fixture(undefined, 1000, {
      ...source,
      id: "actual-registered-source",
    });
    const plan = projectNativeContext(input);
    const text = plan.notice!.text;
    expect(
      text.startsWith(
        `[Reflection source_id=${JSON.stringify(input.source.id)}]\n`,
      ),
    ).toBe(true);
    expect(text.match(/source_id=/g)).toHaveLength(1);
    expect(text).not.toContain('"source-a"');
    for (const entry of plan.checkpoint!.cachedSummaries) {
      expect(text).toContain(`Segment ${entry.id}\n${entry.summary}`);
      expect(entry.summary).toBe("Archived work.");
    }
    expect(plan.checkpoint!.cachedSummaries).toHaveLength(2);
    expect(estimateNativeTokens(text) + 12).toBeLessThanOrEqual(250);
  });

  it("labels each detailed omission without altering the runtime marker substring", () => {
    const input = fixture();
    input.manifest.segments = [];
    input.allowLossy = true;
    const plan = projectNativeContext(input);
    expect(plan.notice!.text).toContain(`[Reflection source_id="source-a"]`);
    for (const range of plan.checkpoint!.archived) {
      expect(plan.notice!.text).toContain(
        `Segment ${range.id}\n[Reflection omitted ${range.start_source_message_id}..${range.end_source_message_id}: missing-or-stale-summary]`,
      );
    }
    expect(estimateNativeTokens(plan.notice!.text) + 12).toBeLessThanOrEqual(
      250,
    );
  });

  it("retains raw input with no notice below reset pressure", () => {
    const input = fixture([user("u"), assistant("a", "small")]);
    expect(projectNativeContext(input)).toMatchObject({
      tailStartIndex: 0,
      preservedPrefixIndices: [],
      reset: false,
    });
    expect(projectNativeContext(input).notice).toBeUndefined();
  });

  it("restores the latest actual user by index with verbatim multimodal content", () => {
    const input = fixture();
    const content = [
      { type: "text", text: "entire request" },
      { type: "image", image: "https://example.test/image" },
    ];
    input.messages = [
      { ...input.messages[0]!, content },
      ...input.messages.slice(1),
    ];
    input.contextLimit = 12_000;
    input.inputLimit = 6500;
    const plan = projectNativeContext(input);
    expect(plan.notice?.anchorMessageIndex).toBe(0);
    expect(input.messages[plan.notice!.anchorMessageIndex!]!.content).toBe(
      content,
    );
    expect(retained(plan, input)).toEqual([2]);
    expect(plan.estimatedTokens).toBeLessThanOrEqual(5850);
  });

  it("never duplicates a user already in the raw tail", () => {
    const input = fixture([
      user("u"),
      assistant("a"),
      user("latest"),
      assistant("tail", "recent"),
    ]);
    const plan = projectNativeContext(input);
    expect(plan.notice?.anchorMessageIndex).toBeUndefined();
    expect(retained(plan, input)).toEqual([2, 3]);
  });

  it("does not mistake synthetic completion or chronological timestamps for the latest user", () => {
    const input = fixture([
      user("u"),
      assistant("a"),
      { ...user("completion"), type: "synthetic" },
      assistant("tail", "recent"),
    ]);
    const plan = projectNativeContext(input);
    expect(plan.notice?.anchorMessageIndex).toBe(0);
    expect(retained(plan, input)).toEqual([2, 3]);
    expect(plan.checkpoint?.restored_user_id).toBe("u");
  });

  it("pins all unknown control and ID-bearing messages in original order", () => {
    const input = fixture();
    input.messages = [
      { role: "system", content: "effort high" },
      input.messages[0]!,
      {
        id: "opaque-native-checkpoint",
        role: "user",
        content: "native checkpoint",
      },
      input.messages[1]!,
      { role: "system", content: "control" },
      input.messages[2]!,
      { id: "unregistered", role: "user", content: "unknown notification" },
    ];
    const plan = projectNativeContext(input);
    expect(plan.preservedPrefixIndices).toEqual([0, 2, 4]);
    expect(plan.tailStartIndex).toBe(5);
    expect(retained(plan, input)).toEqual([0, 2, 4, 5, 6]);
    expect(plan.notice?.anchorMessageIndex).toBe(1);
  });

  it("groups flattened tool calls/results via raw assistant tool IDs", () => {
    const a = {
      ...assistant("a"),
      content: [
        {
          type: "tool",
          id: "call",
          name: "search",
          time: { created: 0 },
          state: {
            status: "completed",
            input: { query: "untouched" },
            content: [{ type: "text", text: "x".repeat(12_000) }],
          },
        },
      ],
    };
    const input = fixture([user("u"), a, assistant("tail", "recent")]);
    input.messages = [
      input.messages[0]!,
      {
        id: "a",
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call",
            input: { query: "untouched" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", id: "call", output: "x".repeat(12_000) },
        ],
      },
      input.messages[2]!,
    ];
    const plan = projectNativeContext(input);
    expect(retained(plan, input)).toEqual([3]);
    expect(plan.tailStartIndex).toBe(3);
    // Interleaving the result after the live tail cannot split its rendered group.
    input.messages = [
      input.messages[0]!,
      input.messages[1]!,
      input.messages[3]!,
      input.messages[2]!,
    ];
    expect(() => projectNativeContext(input)).toThrow(NativeProjectionError);
  });

  it("archives a background launch separately from its later synthetic notification", () => {
    const input = fixture([
      user("u"),
      assistant("launch"),
      { ...user("notification", "background completed"), type: "synthetic" },
    ]);
    expect(retained(projectNativeContext(input), input)).toEqual([2]);
  });

  it("fails closed on ambiguous/unmapped tool results under hard pressure", () => {
    const input = fixture();
    input.messages = [
      ...input.messages,
      {
        role: "tool",
        content: [{ type: "tool-result", id: "unknown", output: "result" }],
      },
    ];
    expect(() => projectNativeContext(input)).toThrow(/no source-safe/);
    input.messages = [
      ...input.messages.slice(0, -1),
      { role: "tool", content: "unidentifiable result" },
    ];
    expect(() => projectNativeContext(input)).toThrow(/no source-safe/);
  });

  it("preserves stable checkpoints when actual canonical tool-loop history grows", () => {
    const input = fixture();
    const first = projectNativeContext(input);
    const expanded = fixture([
      ...input.records.map((record) => record.raw),
      assistant("next", "ordinary next result"),
    ]);
    expanded.previous = JSON.parse(JSON.stringify(first.checkpoint));
    const next = projectNativeContext(expanded);
    expect(next.reset).toBe(false);
    expect(next.notice?.id).toBe(first.notice?.id);
    expect(retained(next, expanded)).toEqual([2, 3]);
  });

  it("archives hosted tool results together and retains live tool arguments verbatim", () => {
    const hosted = {
      ...assistant("hosted"),
      content: [
        {
          type: "tool",
          id: "hosted-call",
          name: "background",
          time: { created: 0 },
          state: {
            status: "completed",
            input: { prompt: "original argument" },
            content: [{ type: "text", text: "x".repeat(12_000) }],
          },
        },
      ],
    };
    const input = fixture([
      user("u"),
      hosted,
      { ...user("notification", "background completed"), type: "synthetic" },
    ]);
    const plan = projectNativeContext(input);
    expect(retained(plan, input)).toEqual([2]);
    const liveContent = [
      {
        type: "tool-call",
        id: "live-call",
        input: { prompt: "do not truncate ".repeat(10) },
      },
    ];
    const live = {
      ...assistant("live", ""),
      time: { created: 0 },
      content: [
        {
          type: "tool",
          id: "live-call",
          name: "search",
          time: { created: 0 },
          state: {
            status: "running",
            input: { prompt: "do not truncate ".repeat(10) },
            metadata: {},
          },
        },
      ],
    };
    const expanded = fixture([
      ...input.records.map((record) => record.raw),
      live,
    ]);
    expanded.messages = [
      ...expanded.messages.slice(0, -1),
      { id: "live", role: "assistant", content: liveContent },
    ];
    const next = projectNativeContext(expanded);
    expect(retained(next, expanded)).toEqual([2, 3]);
    expect(expanded.messages[3]!.content).toBe(liveContent);
  });

  it("will not trust duplicate raw tool IDs or a group spanning a live source record", () => {
    const tool = (id: string, text: string) => ({
      ...assistant(id),
      content: [
        {
          type: "tool",
          id: "duplicate",
          name: "search",
          time: { created: 0 },
          state: {
            status: "completed",
            input: {},
            content: [{ type: "text", text }],
          },
        },
      ],
    });
    const input = fixture([
      user("u"),
      tool("a", "x".repeat(12_000)),
      tool("tail", "recent"),
    ]);
    input.messages = [
      ...input.messages,
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "duplicate", output: "result" },
        ],
      },
    ];
    expect(() => projectNativeContext(input)).toThrow(NativeProjectionError);
  });

  it("pins rather than discards opaque native compaction context even if it prevents fitting", () => {
    const input = fixture();
    input.messages = [
      {
        id: "native-compaction",
        role: "user",
        content: "opaque ".repeat(4000),
      },
      ...input.messages,
    ];
    expect(() => projectNativeContext(input)).toThrow(NativeProjectionError);
  });

  it("reuses serialized checkpoints through tool loops and ignores summaries outside the archive", () => {
    const input = fixture();
    const first = projectNativeContext(input);
    input.previous = JSON.parse(JSON.stringify(first.checkpoint));
    input.messages = [
      ...input.messages,
      { role: "system", content: "new control" },
    ];
    const second = projectNativeContext(input);
    expect(second.reset).toBe(false);
    expect(second.checkpoint).toBe(input.previous);
    expect(second.notice?.id).toBe(first.notice?.id);
    expect(second.estimatedTokens).toBeGreaterThan(first.estimatedTokens);
    input.manifest.segments.push({
      ...input.manifest.segments[0]!,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      summary: "unrelated",
    });
    expect(projectNativeContext(input).reset).toBe(false);
  });

  it("invalidates checkpoints on rewind, namespace mismatch, and source drift", () => {
    const input = fixture();
    const first = projectNativeContext(input);
    const rewound = fixture([user("u")]);
    rewound.previous = first.checkpoint;
    expect(projectNativeContext(rewound)).toMatchObject({
      tailStartIndex: 0,
      reset: true,
    });
    input.previous = { ...first.checkpoint!, source_id: "other-source" };
    expect(projectNativeContext(input).reset).toBe(true);
    input.previous = first.checkpoint;
    input.records[0]!.source.text = "changed";
    expect(() => projectNativeContext(input)).toThrow(NativeProjectionError);
  });

  it("revalidates changed eligible summaries", () => {
    const input = fixture();
    input.previous = projectNativeContext(input).checkpoint;
    input.manifest.segments[0]!.summary = "Corrected summary";
    const next = projectNativeContext(input);
    expect(next.reset).toBe(true);
    expect(next.notice?.text).toContain("Corrected summary");
    expect(next.notice?.id).not.toBe(input.previous!.notice_id);
  });

  it.each(["fingerprint", "range", "version", "eligibility"])(
    "rejects %s mismatches instead of trusting manifest summaries",
    (mismatch) => {
      const input = fixture();
      if (mismatch === "fingerprint")
        input.manifest.boundaries[0]!.source_fingerprint = "wrong";
      if (mismatch === "range")
        input.manifest.segments[0]!.end_source_message_id = "tail";
      if (mismatch === "version")
        input.manifest.segments[0]!.projection_version = 2;
      if (mismatch === "eligibility")
        input.manifest.boundaries[0]!.source_eligible = false;
      expect(() => projectNativeContext(input)).toThrow(NativeProjectionError);
      input.allowLossy = true;
      const plan = projectNativeContext(input);
      expect(plan.lossy).toBe(true);
      expect(plan.notice?.text).toContain(
        "[Reflection omitted u..u: missing-or-stale-summary]",
      );
      expect(plan.notice?.anchorMessageIndex).toBe(0);
    },
  );

  it("accepts a staged summary for an exact failed target but not a stale target", () => {
    const input = fixture();
    input.manifest.targets = input.manifest.boundaries.map((boundary) => ({
      id: boundary.id,
      projection_version: 3,
      source_boundary_version: 3,
      start_source_message_id: boundary.start_source_message_id,
      end_source_message_id: boundary.end_source_message_id,
      source_fingerprint: boundary.source_fingerprint!,
      status: "failed",
    }));
    input.manifest.boundaries = [];
    expect(projectNativeContext(input).lossy).toBe(false);
    input.manifest.targets[0]!.source_fingerprint = "stale";
    expect(() => projectNativeContext(input)).toThrow(NativeProjectionError);
  });

  it("makes missing and over-budget summaries visibly lossy without truncating the user", () => {
    const input = fixture();
    input.manifest.segments = [];
    input.allowLossy = true;
    let plan = projectNativeContext(input);
    expect(plan.omissions).toHaveLength(2);
    expect(plan.notice?.anchorMessageIndex).toBe(0);
    const large = fixture();
    large.allowLossy = true;
    large.manifest.segments[0]!.summary = "large summary ".repeat(1000);
    plan = projectNativeContext(large);
    expect(plan.notice?.text).toContain("summary-budget");
    expect(plan.omissions[0]?.reason).toBe("summary-budget");
  });

  it("rechecks a smaller model and rejects an oversized mandatory active user", () => {
    const input = fixture();
    input.previous = projectNativeContext(input).checkpoint;
    input.contextLimit = 1500;
    const small = projectNativeContext(input);
    expect(small.reset).toBe(true);
    expect(small.checkpoint!.cachedSummaries).toHaveLength(2);
    for (const entry of small.checkpoint!.cachedSummaries)
      expect(small.notice!.text).toContain(
        `Segment ${entry.id}\n${entry.summary}`,
      );
    expect(estimateNativeTokens(small.notice!.text) + 12).toBeLessThanOrEqual(
      75,
    );
    expect(
      estimateNativeTokens(`[Reflection source_id="source-a"]\n`) -
        estimateNativeTokens("[Reflection archived context]\n"),
    ).toBeLessThanOrEqual(20);
    input.messages = [
      { ...input.messages[0]!, content: "active ".repeat(2000) },
      ...input.messages.slice(1),
    ];
    expect(() => projectNativeContext(input)).toThrow(NativeProjectionError);
  });

  it("defers below hard pressure but never claims an overflow fits", () => {
    const input = fixture();
    input.segments = [];
    const tokens = projectNativeContext({
      ...input,
      contextLimit: 100_000,
    }).estimatedTokens;
    input.outputLimit = 0;
    input.contextLimit = Math.ceil(tokens / 0.8);
    expect(projectNativeContext(input).deferredReason).toContain(
      "retaining raw",
    );
    input.contextLimit = Math.floor(tokens / 0.95);
    expect(() => projectNativeContext(input)).toThrow(NativeProjectionError);
  });

  it("does not archive open segments or restore a missing actual-user model message", () => {
    const input = fixture();
    input.segments = input.segments.map((segment) => ({
      ...segment,
      closed: false,
    }));
    expect(() => projectNativeContext(input)).toThrow(NativeProjectionError);
    const missing = fixture();
    missing.messages = missing.messages.slice(1);
    expect(() => projectNativeContext(missing)).toThrow(NativeProjectionError);
  });

  it("estimates tools/system and unicode structure, rejecting opaque media explicitly", () => {
    expect(estimateNativeTokens("漢".repeat(100))).toBeGreaterThan(
      estimateNativeTokens("a".repeat(100)),
    );
    const input = fixture();
    input.tools = { schema: "x".repeat(20_000) };
    expect(() => projectNativeContext(input)).toThrow(NativeProjectionError);
    expect(() => estimateNativeTokens(new Uint8Array([1, 2]))).toThrow(
      /media policy/,
    );
    expect(() =>
      estimateNativeTokens({ type: "file", data: "binary" }),
    ).toThrow(/media policy/);
  });

  it.each([640, 1200])(
    "bounds %i missing-summary segments and serializes each raw record only once",
    (count) => {
      const input = fixture(
        [
          user("actual-user"),
          ...Array.from({ length: count }, (_, index) =>
            assistant(`a-${index}`, "tiny completed content"),
          ),
          { ...assistant("unfinished", "still working"), time: { created: 0 } },
        ],
        1,
      );
      input.manifest.segments = [];
      input.allowLossy = true;
      const control = {
        role: "system",
        content: "keep this opaque control unchanged",
      };
      input.messages = [control, ...input.messages];
      let serializationReads = 0;
      for (const record of input.records) {
        Object.defineProperty(record.raw, "serializationProbe", {
          enumerable: true,
          get() {
            serializationReads++;
            return "unrendered raw metadata ".repeat(100);
          },
        });
      }
      let contentReads = 0;
      input.messages = input.messages.map((message) => {
        const content = message.content;
        return {
          ...message,
          get content() {
            contentReads++;
            return content;
          },
        };
      });
      const beforeMessages = [...input.messages];
      const plan = projectNativeContext(input);
      expect(serializationReads).toBe(count + 1);
      expect(contentReads).toBeLessThanOrEqual(input.messages.length * 3);
      const archived = plan.checkpoint!.archived;
      expect(archived.length).toBeGreaterThan(500);
      expect(plan.omissions).toEqual(
        archived.map((range) => ({
          segmentId: range.id,
          startSourceMessageId: range.start_source_message_id,
          endSourceMessageId: range.end_source_message_id,
          reason: "missing-or-stale-summary",
        })),
      );
      expect(plan.notice!.text).toContain(
        `missing-or-stale-summary=${archived.length}`,
      );
      expect(plan.notice!.text).toContain(`[Reflection source_id="source-a"]`);
      expect(plan.notice!.text).toContain(`omitted ${archived.length} ranges`);
      expect(plan.notice!.text).toContain(`First Segment ${archived[0]!.id}`);
      expect(plan.notice!.text).toContain(
        `last Segment ${archived.at(-1)!.id}`,
      );
      expect(plan.notice!.text).toContain(
        "Intermediate references omitted for budget",
      );
      expect(plan.notice!.text).not.toContain("checkpoint.archived");
      expect(plan.notice!.text).not.toContain("projection.omissions");
      expect(
        plan.notice!.text.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/g),
      ).toHaveLength(2);
      expect(estimateNativeTokens(plan.notice!.text) + 12).toBeLessThanOrEqual(
        250,
      );
      expect(plan.estimatedTokens).toBeLessThanOrEqual(4050);
      expect(plan.notice!.anchorMessageIndex).toBe(1);
      expect(plan.preservedPrefixIndices).toEqual([0]);
      expect(input.messages[0]).toBe(beforeMessages[0]);
      const expectedRetained = [
        0,
        ...Array.from(
          { length: input.messages.length - plan.tailStartIndex },
          (_, index) => plan.tailStartIndex + index,
        ),
      ];
      expect(retained(plan, input)).toEqual(expectedRetained);
      expect(expectedRetained).toContain(input.messages.length - 1);
      for (const index of expectedRetained)
        expect(input.messages[index]).toBe(beforeMessages[index]);
      expect(input.records.at(-1)!.complete).toBe(false);
      expect(
        archived.flatMap((range) => range.source_message_ids),
      ).not.toContain("unfinished");
      // The optimized source hash must be byte-for-byte compatible with v1.
      const end = input.records.findIndex(
        (record) => record.source.id === archived.at(-1)!.end_source_message_id,
      );
      expect(plan.checkpoint!.source_prefix_fingerprint).toBe(
        createHash("sha256")
          .update(
            JSON.stringify(
              input.records.slice(0, end + 1).map((record) => record.raw),
            ),
          )
          .digest("hex"),
      );
      const summaryEntries = archived.map((range) => [range, null]);
      expect(plan.checkpoint!.manifest_summary_fingerprint).toBe(
        createHash("sha256")
          .update(JSON.stringify(summaryEntries))
          .digest("hex"),
      );
      const costs = input.messages.map(
        (message) =>
          8 +
          estimateNativeTokens({
            role: message.role,
            content: message.content,
          }),
      );
      const tailTokens = costs
        .slice(plan.tailStartIndex)
        .reduce((sum, cost) => sum + cost, 0);
      expect(tailTokens).toBeLessThanOrEqual(1250);
      expect(tailTokens + costs[plan.tailStartIndex - 1]!).toBeGreaterThan(
        1250,
      );
      serializationReads = 0;
      input.previous = JSON.parse(JSON.stringify(plan.checkpoint));
      expect(projectNativeContext(input).reset).toBe(false);
      expect(serializationReads).toBe(count + 1);
    },
  );

  it("keeps newest verified summaries while reporting every older budget omission", () => {
    const input = fixture(
      [
        user("u"),
        ...Array.from({ length: 640 }, (_, index) =>
          assistant(`a-${index}`, "small completed text"),
        ),
        { ...assistant("unfinished", "still working"), time: { created: 0 } },
      ],
      1,
    );
    input.allowLossy = true;
    input.manifest.segments.forEach((summary, index) => {
      summary.summary = `Verified summary ${index}: specific completed work.`;
    });
    const plan = projectNativeContext(input);
    const archived = plan.checkpoint!.archived;
    const summaryById = new Map(
      input.manifest.segments.map((summary) => [summary.id, summary.summary]),
    );
    expect(plan.notice!.text).toContain(summaryById.get(archived.at(-1)!.id));
    expect(plan.notice!.text).not.toContain(summaryById.get(archived[0]!.id));
    expect(plan.notice!.text).toContain(
      `summary-budget=${plan.omissions.length}`,
    );
    expect(plan.omissions.length).toBeGreaterThan(500);
    expect(plan.omissions).toEqual(
      archived.slice(0, plan.omissions.length).map((range) => ({
        segmentId: range.id,
        startSourceMessageId: range.start_source_message_id,
        endSourceMessageId: range.end_source_message_id,
        reason: "summary-budget",
      })),
    );
    for (const range of archived.slice(plan.omissions.length))
      expect(plan.notice!.text).toContain(summaryById.get(range.id));
    expect(estimateNativeTokens(plan.notice!.text) + 12).toBeLessThanOrEqual(
      250,
    );
    expect(plan.notice!.anchorMessageIndex).toBe(0);
  });

  it.each([
    "reasoning",
    "media",
    "truncated-tool",
    "tool-context",
    "truncated-shell",
  ] as const)(
    "warns about renderer %s loss even with a matching verified summary",
    (reason) => {
      const input = fixture();
      input.records[1]!.omissions = [reason, reason];
      const plan = projectNativeContext(input);
      expect(plan.lossy).toBe(true);
      expect(plan.notice!.text).toContain("Archived work.");
      expect(plan.notice!.text).toContain(
        `[Reflection omitted a..a: ${reason}]`,
      );
      expect(plan.omissions).toEqual([
        {
          segmentId: input.segments[1]!.id,
          startSourceMessageId: "a",
          endSourceMessageId: "a",
          reason,
        },
      ]);
      expect(plan.notice!.anchorMessageIndex).toBe(0);
      expect(plan.checkpoint!.restored_user_id).toBe("u");
    },
  );

  it("compacts renderer warnings into exact per-reason counts without flagging ordinary text", () => {
    const input = fixture(
      [
        user("u"),
        ...Array.from({ length: 640 }, (_, index) =>
          assistant(`a-${index}`, "small completed text"),
        ),
        { ...assistant("unfinished", "still working"), time: { created: 0 } },
      ],
      1,
    );
    input.allowLossy = true;
    input.records.slice(1, -1).forEach((record) => {
      record.omissions = ["reasoning", "media", "truncated-tool"];
    });
    const plan = projectNativeContext(input);
    const archived = plan.checkpoint!.archived;
    for (const reason of ["reasoning", "media", "truncated-tool"]) {
      expect(plan.notice!.text).toContain(`${reason}=${archived.length - 1}`);
      expect(
        plan.omissions
          .filter((omission) => omission.reason === reason)
          .map((omission) => omission.segmentId),
      ).toEqual(archived.slice(1).map((range) => range.id));
    }
    expect(estimateNativeTokens(plan.notice!.text) + 12).toBeLessThanOrEqual(
      250,
    );
    expect(projectNativeContext(fixture()).lossy).toBe(false);
  });

  it("does not turn an indivisible unfinished message or oversized anchor into a lossy marker", () => {
    const input = fixture([
      user("u"),
      assistant("a"),
      { ...assistant("unfinished", "live".repeat(5000)), time: { created: 0 } },
    ]);
    input.allowLossy = true;
    input.manifest.segments = [];
    expect(() => projectNativeContext(input)).toThrow(/no source-safe/);
    const active = fixture([
      user("u", "active".repeat(5000)),
      assistant("a"),
      assistant("tail", "recent"),
    ]);
    active.allowLossy = true;
    active.manifest.segments = [];
    expect(() => projectNativeContext(active)).toThrow(/no source-safe/);
  });

  it("fails when even the aggregate marker cannot fit alongside fixed input and the user", () => {
    const input = fixture(
      [
        user("u"),
        ...Array.from({ length: 640 }, (_, index) =>
          assistant(`a-${index}`, "small completed text"),
        ),
        { ...assistant("unfinished", "still working"), time: { created: 0 } },
      ],
      1,
    );
    input.allowLossy = true;
    input.manifest.segments = [];
    input.system = "x".repeat(12_000);
    expect(() => projectNativeContext(input)).toThrow(/no source-safe/);
  });

  it("preserves verified summaries and checkpoint identity through an explicit manifest outage", () => {
    const input = fixture();
    input.manifest.segments[0]!.summary =
      "Verified user intent, not the active-user anchor.";
    input.manifest.segments[1]!.summary =
      "Verified assistant work must survive transport failure.";
    const first = projectNativeContext(input);
    expect(first.checkpoint!.version).toBe(2);
    expect(first.checkpoint!.cachedSummaries).toHaveLength(2);
    input.previous = JSON.parse(JSON.stringify(first.checkpoint));
    input.manifest = {
      ...input.manifest,
      boundaries: [],
      targets: [],
      segments: [],
    };
    input.manifestUnavailable = true;
    const outage = projectNativeContext(input);
    expect(outage.notice).toEqual(first.notice);
    expect(outage.checkpoint).toBe(input.previous);
    expect(outage.reset).toBe(false);
    expect(outage.lossy).toBe(false);
    expect(outage.omissions).toEqual([]);
    expect(outage.estimatedTokens).toBe(first.estimatedTokens);
  });

  it.each(["text", "raw-only"])(
    "rejects cached context on %s source drift",
    (drift) => {
      const before = fixture();
      const checkpoint = projectNativeContext(before).checkpoint;
      const input =
        drift === "text"
          ? fixture([
              user("u", "Changed actual source text"),
              assistant("a"),
              assistant("tail", "recent"),
            ])
          : fixture();
      if (drift === "raw-only") input.records[1]!.raw.time.created = 99;
      input.previous = checkpoint;
      input.manifest = {
        ...input.manifest,
        boundaries: [],
        targets: [],
        segments: [],
      };
      input.manifestUnavailable = true;
      input.allowLossy = true;
      const plan = projectNativeContext(input);
      expect(plan.notice!.text).not.toContain("Archived work.");
      expect(
        plan.omissions.filter(
          (omission) => omission.reason === "missing-or-stale-summary",
        ),
      ).toHaveLength(2);
      expect(plan.checkpoint!.cachedSummaries).toEqual([]);
    },
  );

  it.each(["source_id", "session_id"] as const)(
    "rejects cached summaries owned by another %s",
    (key) => {
      const input = fixture();
      input.previous = {
        ...projectNativeContext(input).checkpoint!,
        [key]: "other-owner",
      };
      input.manifest = {
        ...input.manifest,
        boundaries: [],
        targets: [],
        segments: [],
      };
      input.manifestUnavailable = true;
      input.allowLossy = true;
      expect(projectNativeContext(input).checkpoint!.cachedSummaries).toEqual(
        [],
      );
    },
  );

  it.each([undefined, false])(
    "does not resurrect cached text without an explicit outage (%s)",
    (manifestUnavailable) => {
      const input = fixture();
      input.previous = projectNativeContext(input).checkpoint;
      input.manifest = {
        ...input.manifest,
        boundaries: [],
        targets: [],
        segments: [],
      };
      input.manifestUnavailable = manifestUnavailable;
      input.allowLossy = true;
      const plan = projectNativeContext(input);
      expect(plan.lossy).toBe(true);
      expect(plan.notice!.text).not.toContain("Archived work.");
      expect(plan.checkpoint!.cachedSummaries).toEqual([]);
    },
  );

  it.each(["missing", "stale", "changed-target"])(
    "honors authoritative %s range evidence even when unavailable is set",
    (conflict) => {
      const input = fixture();
      input.previous = projectNativeContext(input).checkpoint;
      input.manifestUnavailable = true;
      input.allowLossy = true;
      if (conflict === "missing") input.manifest.segments = [];
      if (conflict === "stale")
        input.manifest.boundaries.forEach((boundary) => {
          boundary.source_fingerprint = "stale";
        });
      if (conflict === "changed-target") {
        input.manifest.targets = input.manifest.boundaries.map((boundary) => ({
          id: boundary.id,
          projection_version: 3,
          source_boundary_version: 3,
          start_source_message_id: boundary.start_source_message_id,
          end_source_message_id: "tail",
          source_fingerprint: "changed",
          status: "failed",
        }));
      }
      const plan = projectNativeContext(input);
      expect(plan.checkpoint!.cachedSummaries).toEqual([]);
      expect(plan.notice!.text).not.toContain("Archived work.");
      expect(plan.omissions).toHaveLength(2);
    },
  );

  it("does not downgrade malformed or mismatched manifests to cache-only mode", () => {
    const input = fixture();
    input.previous = projectNativeContext(input).checkpoint;
    input.manifestUnavailable = true;
    input.manifest = { ...input.manifest, source_id: "another-source" };
    expect(() => projectNativeContext(input)).toThrow(NativeProjectionError);
    input.manifest = JSON.parse('{"source_id":"source-a"}');
    expect(() => projectNativeContext(input)).toThrow(NativeProjectionError);
  });

  it("extends a source-proven cached prefix with explicit omissions for newly archived unavailable ranges", () => {
    const before = fixture();
    before.manifest.segments[0]!.summary = "Cached user context.";
    before.manifest.segments[1]!.summary = "Cached verified work.";
    const first = projectNativeContext(before);
    const input = fixture([
      ...before.records.map((record) => record.raw),
      assistant("new"),
      assistant("live", "recent"),
    ]);
    input.previous = first.checkpoint;
    input.manifest = {
      ...input.manifest,
      boundaries: [],
      targets: [],
      segments: [],
    };
    input.manifestUnavailable = true;
    input.allowLossy = true;
    const next = projectNativeContext(input);
    expect(next.notice!.text).toContain("Cached user context.");
    expect(next.notice!.text).toContain("Cached verified work.");
    expect(next.checkpoint!.cachedSummaries).toEqual(
      first.checkpoint!.cachedSummaries,
    );
    expect(
      next.omissions.map((omission) => [
        omission.startSourceMessageId,
        omission.endSourceMessageId,
        omission.reason,
      ]),
    ).toEqual([
      ["tail", "tail", "missing-or-stale-summary"],
      ["new", "new", "missing-or-stale-summary"],
    ]);
    expect(next.lossy).toBe(true);
    expect(retained(next, input)).toEqual([4]);
    expect(next.notice!.anchorMessageIndex).toBe(0);
  });

  it("keeps renderer warnings and copies the current user model content rather than cached text", () => {
    const input = fixture();
    input.previous = projectNativeContext(input).checkpoint;
    input.records[1]!.omissions = ["media", "reasoning"];
    const currentContent = [
      { type: "text", text: "current complete user model content" },
    ];
    input.messages = [
      { ...input.messages[0]!, content: currentContent },
      ...input.messages.slice(1),
    ];
    input.manifest = {
      ...input.manifest,
      boundaries: [],
      targets: [],
      segments: [],
    };
    input.manifestUnavailable = true;
    const plan = projectNativeContext(input);
    expect(plan.notice!.text).toContain("Archived work.");
    expect(plan.omissions.map((omission) => omission.reason)).toEqual([
      "media",
      "reasoning",
    ]);
    expect(plan.notice!.anchorMessageIndex).toBe(0);
    expect(input.messages[plan.notice!.anchorMessageIndex!]!.content).toBe(
      currentContent,
    );
    expect(plan.lossy).toBe(true);
  });

  it.each([
    "legacy",
    "digest",
    "text",
    "policy",
    "range",
    "fingerprint",
    "shape",
    "notice",
    "prefix",
    "duplicate",
  ])("ignores malformed %s cache state", (corruption) => {
    const input = fixture();
    const previous = JSON.parse(
      JSON.stringify(projectNativeContext(input).checkpoint),
    );
    if (corruption === "legacy") {
      previous.version = 1;
      delete previous.cachedSummaries;
    }
    if (corruption === "digest")
      previous.cached_summaries_fingerprint = "0".repeat(64);
    if (corruption === "text")
      previous.cachedSummaries[0].summary = "tampered cached text";
    if (corruption === "policy")
      previous.cachedSummaries[0].projection_version = 2;
    if (corruption === "range")
      previous.cachedSummaries[0].end_source_message_id = "a";
    if (corruption === "fingerprint")
      previous.cachedSummaries[0].source_fingerprint = "changed";
    if (corruption === "shape") previous.cachedSummaries[0] = null;
    if (corruption === "notice") previous.notice_id = "invalid";
    if (corruption === "prefix")
      previous.source_prefix_fingerprint = "0".repeat(64);
    if (corruption === "duplicate")
      previous.cachedSummaries[1] = previous.cachedSummaries[0];
    input.previous = previous;
    input.manifest = {
      ...input.manifest,
      boundaries: [],
      targets: [],
      segments: [],
    };
    input.manifestUnavailable = true;
    input.allowLossy = true;
    const plan = projectNativeContext(input);
    expect(plan.checkpoint!.cachedSummaries).toEqual([]);
    expect(plan.notice!.text).not.toContain("Archived work.");
    expect(plan.notice!.text).not.toContain("tampered cached text");
  });

  it("bounds cached summary text to emitted selected ranges instead of copying the whole manifest", () => {
    const input = fixture(
      [
        user("u"),
        ...Array.from({ length: 640 }, (_, index) =>
          assistant(`a-${index}`, "small completed text"),
        ),
        { ...assistant("unfinished", "still working"), time: { created: 0 } },
      ],
      1,
    );
    input.allowLossy = true;
    input.manifest.segments.forEach((entry, index) => {
      entry.summary = `Verified ${index}: ` + "summary content ".repeat(5);
    });
    const plan = projectNativeContext(input);
    const checkpoint = plan.checkpoint!;
    expect(checkpoint.cachedSummaries.length).toBeGreaterThan(0);
    expect(checkpoint.cachedSummaries.length).toBeLessThan(10);
    expect(
      checkpoint.cachedSummaries.reduce(
        (sum, entry) =>
          sum +
          estimateNativeTokens(`Segment ${entry.id}\n${entry.summary}`) +
          2,
        0,
      ),
    ).toBeLessThanOrEqual(250);
    for (const entry of checkpoint.cachedSummaries) {
      expect(plan.notice!.text).toContain(entry.summary);
      expect(checkpoint.archived.some((range) => range.id === entry.id)).toBe(
        true,
      );
      expect(
        plan.omissions.some((omission) => omission.segmentId === entry.id),
      ).toBe(false);
    }
    expect(checkpoint.cached_summaries_fingerprint).toBe(
      createHash("sha256")
        .update(JSON.stringify(checkpoint.cachedSummaries))
        .digest("hex"),
    );
    expect(JSON.stringify(checkpoint.cachedSummaries).length).toBeLessThan(
      5000,
    );
    input.previous = checkpoint;
    input.manifest = {
      ...input.manifest,
      boundaries: [],
      targets: [],
      segments: [],
    };
    input.manifestUnavailable = true;
    const outage = projectNativeContext(input);
    for (const entry of checkpoint.cachedSummaries)
      expect(outage.notice!.text).toContain(entry.summary);
    expect(estimateNativeTokens(outage.notice!.text) + 12).toBeLessThanOrEqual(
      250,
    );
  });

  it("charges cached text against the current smaller model budget", () => {
    const input = fixture();
    const summary = "Verified assistant history ".repeat(18);
    input.manifest.segments[1]!.summary = summary;
    const before = projectNativeContext(input);
    expect(
      before.checkpoint!.cachedSummaries.some(
        (entry) => entry.summary === summary,
      ),
    ).toBe(true);
    input.previous = before.checkpoint;
    input.contextLimit = 3000;
    input.manifest = {
      ...input.manifest,
      boundaries: [],
      targets: [],
      segments: [],
    };
    input.manifestUnavailable = true;
    input.allowLossy = true;
    const plan = projectNativeContext(input);
    expect(plan.notice!.text).not.toContain(summary);
    expect(
      plan.omissions.some(
        (omission) =>
          omission.startSourceMessageId === "a" &&
          omission.reason === "summary-budget",
      ),
    ).toBe(true);
    expect(
      plan.checkpoint!.cachedSummaries.some(
        (entry) => entry.summary === summary,
      ),
    ).toBe(false);
    expect(estimateNativeTokens(plan.notice!.text) + 12).toBeLessThanOrEqual(
      150,
    );
    expect(plan.estimatedTokens).toBeLessThanOrEqual(2250);
    input.system = "x".repeat(9000);
    expect(() => projectNativeContext(input)).toThrow(NativeProjectionError);
  });

  it("accepts unrelated manifest evidence but blocks overlapping evidence for cached ranges", () => {
    const before = fixture();
    const checkpoint = projectNativeContext(before).checkpoint;
    const input = fixture([
      ...before.records.map((record) => record.raw),
      assistant("new"),
      assistant("live", "recent"),
    ]);
    input.previous = checkpoint;
    input.manifestUnavailable = true;
    input.allowLossy = true;
    input.manifest = {
      ...input.manifest,
      boundaries: input.manifest.boundaries.filter(
        (entry) => entry.start_source_message_id === "new",
      ),
      segments: input.manifest.segments.filter(
        (entry) => entry.start_source_message_id === "new",
      ),
      targets: [],
    };
    const plan = projectNativeContext(input);
    expect(
      plan.checkpoint!.cachedSummaries.filter((entry) =>
        checkpoint!.cachedSummaries.some((old) => old.id === entry.id),
      ),
    ).toEqual(checkpoint!.cachedSummaries);
    input.manifest = {
      ...input.manifest,
      segments: [],
      targets: [],
      boundaries: [
        {
          ...input.manifest.boundaries[0]!,
          start_source_message_id: "u",
          end_source_message_id: "a",
          source_fingerprint: "overlap",
        },
      ],
    };
    const conflict = projectNativeContext(input);
    expect(conflict.checkpoint!.cachedSummaries).toEqual([]);
  });
});
