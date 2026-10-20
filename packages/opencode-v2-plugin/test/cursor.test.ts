import { Message } from "@opencode/ai";
import type { SourceInfo } from "@reflection/shared/sources";
import { describe, expect, it } from "vitest";
import {
  cursorSummaryState,
  emptyCursorState,
  parseCursorState,
  selectCursorProjection,
} from "../src/cursor.js";

const source: SourceInfo = {
  id: "native",
  kind: "opencode-v2",
  identity_scheme: "source-v1",
};
const segment = (id: string, start: string, end: string, summary: string) => ({
  id,
  projection_version: 3,
  source_boundary_version: 3,
  start_source_message_id: start,
  end_source_message_id: end,
  summary,
});
const manifest = {
  source_id: "native",
  session_id: "s",
  manifest_version: 3 as const,
  segments: [
    segment("11111111-1111-4111-8111-111111111111", "u1", "a1", "first"),
    segment("22222222-2222-4222-8222-222222222222", "u2", "a2", "second"),
  ],
  boundaries: [],
  targets: [],
};

describe("cursor projection", () => {
  it("round-trips cursor state", () => {
    const state = emptyCursorState("native", "s");
    expect(parseCursorState(state, "native", "s")).toEqual(state);
    expect(parseCursorState({ ...state, version: 2 }, "native", "s")).toBe(
      undefined,
    );
  });

  it("derives summaries and contiguous tail", () => {
    const result = cursorSummaryState(manifest, source);
    expect(result.summaries).toHaveLength(2);
    expect(result.summarizedThrough).toBe("a2");
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  const summaries = cursorSummaryState(manifest, source).summaries;
  const big = "x ".repeat(800);
  const user = (id: string, content = id) =>
    Message.make({ id, role: "user", content });
  const reply = (id: string, content = "answer") =>
    Message.make({ id, role: "assistant", content });
  const call = (id: string, callId: string, command = id) =>
    Message.make({
      id,
      role: "assistant",
      content: [
        { type: "tool-call", id: callId, name: "bash", input: { command } },
      ],
    });
  const result = (callId: string, output = "ok") =>
    Message.tool({ id: callId, name: "bash", result: output });
  // Context 1,000: projection fires above 700, hard ceiling 750, raw tail
  // target 250, summary budget 50.
  const project = (
    messages: Message[],
    options: Partial<Parameters<typeof selectCursorProjection>[0]> = {},
  ) =>
    selectCursorProjection({
      sourceId: "native",
      messages,
      summaries,
      projectedThrough: null,
      contextLimit: 1000,
      softTokens: 700,
      hardTokens: 750,
      systemTokens: 10,
      ...options,
    });

  it("sends raw history below the projection threshold", () => {
    const messages = [
      user("u1"),
      reply("a1"),
      user("u2"),
      reply("a2"),
      user("u3"),
    ];
    const projection = project(messages);
    expect(projection.mode).toBe("raw");
    expect(projection.messages).toEqual(messages);
    expect(projection.projectedThrough).toBe(null);
  });

  it("fires above the threshold and keeps a raw tail within the target", () => {
    const projection = project([
      user("u1"),
      reply("a1", big),
      user("u2"),
      reply("a2"),
      user("u3"),
    ]);
    expect(projection.mode).toBe("fired");
    expect(projection.projectedThrough).toBe("a1");
    expect(projection.messages[0]?.id).toContain("reflection-cursor-");
    expect(projection.messages.slice(1).map((message) => message.id)).toEqual([
      "u2",
      "a2",
      "u3",
    ]);
    expect(JSON.stringify(projection.messages[0])).toContain("first");
    expect(JSON.stringify(projection.messages[0])).not.toContain("second");
    expect(projection.estimatedTokens).toBeLessThanOrEqual(700);
  });

  it("keeps the previous cut until the projection crosses the threshold", () => {
    const history = [
      user("u1"),
      reply("a1", big),
      user("u2"),
      reply("a2"),
      user("u3"),
    ];
    const fired = project(history);
    const kept = project([...history, reply("a3"), user("u4")], {
      projectedThrough: fired.projectedThrough,
    });
    expect(kept.mode).toBe("kept");
    expect(kept.messages[0]).toEqual(fired.messages[0]);

    const grown = project(
      [user("u1"), reply("a1", big), user("u2"), reply("a2", big), user("u3")],
      { projectedThrough: fired.projectedThrough },
    );
    expect(grown.mode).toBe("fired");
    expect(grown.projectedThrough).toBe("a2");
    expect(grown.messages.slice(1).map((message) => message.id)).toEqual([
      "u3",
    ]);
  });

  it("keeps the tool call when the cut ends on a tool-calling message", () => {
    const messages = [
      user("u1"),
      reply("a1"),
      user("u2", big),
      call("a2", "c2"),
      result("c2"),
    ];
    const projection = project(messages);
    expect(projection.projectedThrough).toBe("a2");
    expect(projection.messages.slice(1)).toEqual(messages.slice(3));
  });

  it("starts a budget-trimmed tail after a complete tool exchange", () => {
    const messages = [
      user("u1"),
      call("a1", "c1", "x ".repeat(2_000)),
      result("c1"),
      call("a2", "c2"),
      result("c2"),
    ];
    const projection = project(messages, {
      summaries: [],
      softTokens: 560,
      hardTokens: 600,
      systemTokens: 100,
    });
    expect(projection.messages).toEqual(messages.slice(3));
    expect(projection.estimatedTokens).toBeLessThanOrEqual(600);
  });

  it("never starts the tail with an orphaned tool result", () => {
    const messages = [
      user("u1"),
      call("a1", "c1"),
      result("c1", "x ".repeat(2_000)),
    ];
    const projection = project(messages, {
      summaries: [],
      softTokens: 560,
      hardTokens: 600,
      systemTokens: 100,
    });
    expect(projection.messages).toEqual(messages.slice(1));
    expect(projection.estimatedTokens).toBeGreaterThan(600);
  });

  it("drops older summaries with one marker when they do not fit", () => {
    const projection = project(
      [user("u1"), reply("a1"), user("u2", big), reply("a2"), user("u3")],
      { contextLimit: 600, softTokens: 420, hardTokens: 450 },
    );
    expect(projection.projectedThrough).toBe("a2");
    expect(projection.omittedSummaries).toBe(1);
    expect(JSON.stringify(projection.messages[0])).toContain(
      "older summaries omitted",
    );
  });
});
