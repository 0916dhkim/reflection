import { Message } from "@opencode/ai";
import type { NativeSessionSegmentsResponse } from "@reflection/shared/native";
import type {
  NativeProjectionCheckpoint,
  NativeProjectionResult,
} from "@reflection/opencode-v2-core/projection";
import { describe, expect, it } from "vitest";
import {
  cacheProjectionPlan,
  canReuseProjectionPlan,
  manifestPrefixFingerprint,
} from "../src/plan-cache.js";

const checkpoint = {
  version: 2,
  source_id: "native",
  session_id: "s",
  archived: [
    {
      id: "segment",
      start_source_message_id: "u1",
      end_source_message_id: "a1",
      source_fingerprint: "fingerprint",
      source_message_ids: ["u1", "a1"],
    },
  ],
  source_prefix_fingerprint: "prefix",
  tail_start_source_id: "u2",
  restored_user_id: null,
  manifest_summary_fingerprint: "summaries",
  cachedSummaries: [],
  cached_summaries_fingerprint: "cached",
  context_limit: 100,
  input_limit: 90,
  output_limit: 20,
  notice_id: "notice",
} satisfies NativeProjectionCheckpoint;

const plan = {
  tailStartIndex: 1,
  preservedPrefixIndices: [],
  notice: { id: "notice", text: "summary" },
  checkpoint,
  lossy: true,
  omissions: [],
  estimatedTokens: 40,
  reset: false,
} satisfies NativeProjectionResult;

const messages = [
  Message.make({ id: "u1", role: "user", content: "ask" }),
  Message.make({ id: "a1", role: "assistant", content: "answer" }),
  Message.make({ id: "u2", role: "user", content: "latest" }),
];
const segment = {
  id: "segment",
  projection_version: 3 as const,
  source_boundary_version: 3 as const,
  start_source_message_id: "u1",
  end_source_message_id: "a1",
  summary: "old",
};
const manifest = {
  source_id: "native",
  session_id: "s",
  manifest_version: 3 as const,
  segments: [segment],
  boundaries: [],
  targets: [],
} satisfies NativeSessionSegmentsResponse;
const archived = checkpoint.archived;

describe("projection plan cache", () => {
  it("reuses a plan when the settled prefix, manifest, and limits match", () => {
    const cached = cacheProjectionPlan(plan, messages, "manifest");
    expect(cached).toBeDefined();
    expect(
      canReuseProjectionPlan(
        checkpoint,
        cached!,
        [
          ...messages,
          Message.make({ id: "tool", role: "tool", content: "result" }),
        ],
        "manifest",
        100,
        90,
        20,
      ),
    ).toBe(true);
  });

  it("invalidates on prefix, manifest, notice, or limit changes", () => {
    const cached = cacheProjectionPlan(plan, messages, "manifest")!;
    expect(
      canReuseProjectionPlan(
        { ...checkpoint, notice_id: "other" },
        cached,
        messages,
        "manifest",
        100,
        90,
        20,
      ),
    ).toBe(false);
    expect(
      canReuseProjectionPlan(
        checkpoint,
        cached,
        [
          Message.make({ id: "other", role: "user", content: "ask" }),
          ...messages.slice(1),
        ],
        "manifest",
        100,
        90,
        20,
      ),
    ).toBe(false);
    expect(
      canReuseProjectionPlan(
        checkpoint,
        cached,
        messages,
        "changed",
        100,
        90,
        20,
      ),
    ).toBe(false);
    expect(
      canReuseProjectionPlan(
        checkpoint,
        cached,
        messages,
        "manifest",
        100,
        90,
        21,
      ),
    ).toBe(false);
  });

  it("requires a checkpoint and stable manifest fingerprint", () => {
    expect(
      cacheProjectionPlan(
        { ...plan, checkpoint: undefined },
        messages,
        "manifest",
      ),
    ).toBeUndefined();
    const base = manifestPrefixFingerprint(manifest, archived);
    expect(
      manifestPrefixFingerprint(
        {
          ...manifest,
          segments: [
            ...manifest.segments,
            { ...segment, id: "tail", summary: "tail" },
          ],
        },
        archived,
      ),
    ).toBe(base);
    expect(
      manifestPrefixFingerprint(
        {
          ...manifest,
          segments: [{ ...segment, summary: "new" }],
        },
        archived,
      ),
    ).not.toBe(base);
  });
});
