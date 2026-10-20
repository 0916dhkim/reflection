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

  it("keeps summaries and the raw tail after the summary boundary", () => {
    const summaries = cursorSummaryState(manifest, source).summaries;
    const result = selectCursorProjection({
      sourceId: "native",
      messages: [
        Message.make({ id: "u1", role: "user", content: "one" }),
        Message.make({ id: "a1", role: "assistant", content: "answer" }),
        Message.make({ id: "u2", role: "user", content: "two" }),
        Message.make({ id: "a2", role: "assistant", content: "answer" }),
        Message.make({ id: "u3", role: "user", content: "latest" }),
      ],
      summarizedThrough: "a2",
      summaries,
      hardTokens: 10_000,
      systemTokens: 100,
    });
    expect(result).toBeDefined();
    expect(result!.messages[0]?.id).toContain("reflection-cursor-");
    expect(result!.messages.at(-1)?.id).toBe("u3");
    expect(result!.omittedSummaries).toBe(0);
  });

  it("drops older summaries with one marker when they do not fit", () => {
    const summaries = cursorSummaryState(manifest, source).summaries;
    const result = selectCursorProjection({
      sourceId: "native",
      messages: [Message.make({ id: "u3", role: "user", content: "latest" })],
      summarizedThrough: null,
      summaries,
      hardTokens: 130,
      systemTokens: 100,
    });
    expect(result).toBeDefined();
    expect(result!.omittedSummaries).toBeGreaterThan(0);
    expect(JSON.stringify(result!.messages)).toContain(
      "older summaries omitted",
    );
  });
});
