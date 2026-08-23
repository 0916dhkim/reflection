import { describe, expect, it, vi } from "vitest";

import {
  activeModel,
  estimateTokens,
  projectMessages as projectMessagesImplementation,
  type ProjectMessagesInput,
  type StoredSegmentSummary,
} from "../src/projection.js";
import { segmentIdForRequest } from "@reflection/shared/domain";
import {
  PROJECTION_LOSS_WARNING,
  PROJECTION_LOSS_WARNING_METADATA,
  segmentMessages,
  type OpenCodeMessage,
  type ReflectionSegment,
} from "@reflection/shared/segmentation";

const SESSION_ID = "session";
const PROVIDER_ID = "provider";
const MODEL_ID = "model";
const CONTEXT_LIMIT = 120_000;

function user(id: string, text: string): OpenCodeMessage {
  return {
    info: {
      id,
      sessionID: SESSION_ID,
      role: "user",
      agent: "build",
      model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
    },
    parts: [{ type: "text", text }],
  };
}

function assistant(
  id: string,
  parentID: string,
  text: string,
  extraParts: OpenCodeMessage["parts"] = [],
  reportedInput?: number,
): OpenCodeMessage {
  return {
    info: {
      id,
      sessionID: SESSION_ID,
      role: "assistant",
      parentID,
      providerID: PROVIDER_ID,
      modelID: MODEL_ID,
      time: { created: 0, completed: 1 },
      finish: "stop",
      tokens:
        reportedInput === undefined
          ? undefined
          : {
              input: reportedInput,
              output: 1_000,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
    },
    parts: [{ type: "text", text }, ...extraParts],
  };
}

function longSession(turns = 16): OpenCodeMessage[] {
  const messages: OpenCodeMessage[] = [];
  for (let index = 0; index < turns; index += 1) {
    const id = `u${index}`;
    messages.push(user(id, `request ${index} ${"u".repeat(12_500)}`));
    messages.push(
      assistant(
        `a${index}`,
        id,
        `response ${index} ${"a".repeat(12_500)}`,
        index === 0
          ? [
              {
                type: "tool",
                tool: "bash",
                state: {
                  status: "completed",
                  input: { command: "pnpm test" },
                  output: "37 tests passed",
                },
              },
            ]
          : [],
        index * 6_250 + 3_125,
      ),
    );
  }
  messages.push(user("current", "continue"));
  return messages;
}

function summaries(
  messages: readonly OpenCodeMessage[],
): StoredSegmentSummary[] {
  return segmentMessages(messages).map((segment, index) => {
    const common = {
      id: segmentIdForRequest({
        session_id: SESSION_ID,
        start_user_message_id: segment.startUserMessageId,
        source_boundary_version: segment.sourceBoundaryVersion,
        start_source_message_id: segment.startSourceMessageId,
      }),
      start_user_message_id: segment.startUserMessageId,
      end_user_message_id: segment.endUserMessageId,
      projection_version: 1,
      summary: `Summary ${index}`,
    };
    return segment.sourceBoundaryVersion === 1
      ? {
          ...common,
          source_boundary_version: 1,
          start_source_message_id: null,
          end_source_message_id: null,
        }
      : {
          ...common,
          source_boundary_version: 2,
          start_source_message_id: segment.startSourceMessageId!,
          end_source_message_id: segment.endSourceMessageId!,
        };
  });
}

function v1Summary(
  startUserMessageId: string,
  endUserMessageId: string,
  summary: string,
  projectionVersion = 1,
): StoredSegmentSummary {
  return {
    id: segmentIdForRequest({
      session_id: SESSION_ID,
      start_user_message_id: startUserMessageId,
      source_boundary_version: 1,
      start_source_message_id: null,
    }),
    start_user_message_id: startUserMessageId,
    end_user_message_id: endUserMessageId,
    source_boundary_version: 1,
    start_source_message_id: null,
    end_source_message_id: null,
    projection_version: projectionVersion,
    summary,
  };
}

type TestProjectionInput = Omit<
  ProjectMessagesInput,
  "loadCanonicalSegments"
> & {
  loadCanonicalSegments?: ProjectMessagesInput["loadCanonicalSegments"];
};

function projectMessages(input: TestProjectionInput) {
  return projectMessagesImplementation({
    ...input,
    loadCanonicalSegments:
      input.loadCanonicalSegments ??
      (async () => segmentMessages(input.messages)),
  });
}

function projectedContext(messages: readonly OpenCodeMessage[]): string {
  return (
    messages
      .flatMap((message) => message.parts)
      .find((part) => part.synthetic === true)?.text ?? ""
  );
}

describe("activeModel", () => {
  it("reads the active model and session from the latest user message", () => {
    expect(activeModel(longSession(1))).toEqual({
      sessionId: SESSION_ID,
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
    });
  });

  it("requires model metadata on the latest user message", () => {
    const messages = longSession(1);
    messages.push({
      info: { id: "control", sessionID: SESSION_ID, role: "user" },
      parts: [
        {
          type: "text",
          text: PROJECTION_LOSS_WARNING,
          synthetic: false,
          ignored: true,
          metadata: { reflection: { control: "projection-loss-warning" } },
        },
      ],
    });

    expect(activeModel(messages)).toBeNull();
  });

  it("ignores the exact persisted projection warning for active-model selection", () => {
    const messages = longSession(1);
    messages.push({
      info: { id: "warning", sessionID: SESSION_ID, role: "user" },
      parts: [
        {
          type: "text",
          text: PROJECTION_LOSS_WARNING,
          synthetic: false,
          ignored: false,
          metadata: PROJECTION_LOSS_WARNING_METADATA,
        },
      ],
    });

    expect(activeModel(messages)).toEqual({
      sessionId: SESSION_ID,
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
    });
  });
});

describe("projectMessages", () => {
  it("leaves history untouched below 75% without loading summaries", async () => {
    const messages = longSession(2);
    const loadSummaries = vi.fn(async () => summaries(messages));
    const loadCanonicalSegments = vi.fn(async () => segmentMessages(messages));

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadCanonicalSegments,
      loadSummaries,
    });

    expect(result.reset).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(loadCanonicalSegments).not.toHaveBeenCalled();
    expect(loadSummaries).not.toHaveBeenCalled();
  });

  it("uses provider-reported input and output reservation instead of message size alone", async () => {
    const messages = longSession(2);
    const latestAssistant = [...messages]
      .reverse()
      .find((message) => message.info.role === "assistant");
    if (latestAssistant) {
      latestAssistant.info.tokens = {
        input: 90_000,
        output: 1_000,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      };
    }

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      outputLimit: 50_000,
      loadSummaries: async () => summaries(messages),
    });

    expect(estimateTokens(messages)).toBeLessThan(CONTEXT_LIMIT * 0.25);
    expect(result.reset).toBe(true);
    expect(result.state.checkpoint?.lossy).toBeUndefined();
  });

  it("resets a 75% context to a segment-aligned tail near 25%", async () => {
    const messages = longSession();
    expect(estimateTokens(messages)).toBeGreaterThan(CONTEXT_LIMIT * 0.75);

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });

    expect(result.reset).toBe(true);
    expect(result.estimatedTokens).toBeLessThan(CONTEXT_LIMIT * 0.75);
    expect(result.state.checkpoint?.tailStartMessageId).toMatch(/^u/);
    expect(result.messages[2]?.info.id).toBe(
      result.state.checkpoint?.tailStartMessageId,
    );
    expect(projectedContext(result.messages)).toContain("<reflection-context>");
    expect(projectedContext(result.messages)).toContain("37 tests passed");
    expect(result.messages[0]?.parts[0]).toMatchObject({
      type: "compaction",
      sessionID: SESSION_ID,
      messageID: result.messages[0]?.info.id,
    });
    expect(result.messages[1]?.parts[0]).toMatchObject({
      type: "text",
      sessionID: SESSION_ID,
      messageID: result.messages[1]?.info.id,
    });
    expect(result.messages[1]?.info).toMatchObject({
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    });
    expect(result.messages.at(-1)?.info.id).toBe("current");
  });

  it("soft resets after a completed assistant tool step", async () => {
    const messages = longSession();
    const first = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });
    const currentAssistant = assistant(
      "current-assistant",
      "current",
      "working",
      [
        {
          type: "tool",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "large.txt" },
            output: "x".repeat(120_000),
          },
        },
      ],
      30_000,
    );
    const continued = [...messages, currentAssistant];
    const loadSummaries = vi.fn(async () => summaries(continued));

    const result = await projectMessages({
      messages: continued,
      contextLimit: CONTEXT_LIMIT,
      inputLimit: 100_000,
      outputLimit: 20_000,
      previous: first.state,
      loadSummaries,
    });

    expect(result.reset).toBe(true);
    expect(result.state.checkpoint).not.toEqual(first.state.checkpoint);
    expect(loadSummaries).toHaveBeenCalledOnce();
  });

  it("resets at the hard limit during an assistant tool loop", async () => {
    const messages = longSession();
    const first = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });
    const continued = [
      ...messages,
      assistant("current-assistant", "current", "working", [], 95_000),
    ];
    const loadSummaries = vi.fn(async () => summaries(continued));

    const result = await projectMessages({
      messages: continued,
      contextLimit: CONTEXT_LIMIT,
      previous: first.state,
      loadSummaries,
    });

    expect(result.reset).toBe(true);
    expect(result.state.checkpoint?.tailStartMessageId).not.toBe(
      first.state.checkpoint?.tailStartMessageId,
    );
    expect(loadSummaries).toHaveBeenCalledOnce();
  });

  it("invalidates a checkpoint when canonical projection sources change", async () => {
    const messages = longSession();
    const first = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });
    const validateCheckpoint = vi.fn(async () => false);
    const updatedSummaries = summaries(messages).map((summary) => ({
      ...summary,
      summary: "UPDATED CANONICAL SUMMARY",
    }));

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      previous: first.state,
      validateCheckpoint,
      loadSummaries: async () => updatedSummaries,
    });

    expect(validateCheckpoint).toHaveBeenCalledOnce();
    expect(result.reset).toBe(true);
    expect(projectedContext(result.messages)).toContain(
      "UPDATED CANONICAL SUMMARY",
    );
  });

  it("uses tool-aware segment boundaries without modifying the retained tail", async () => {
    const messages: OpenCodeMessage[] = [];
    for (let index = 0; index < 11; index += 1) {
      const userId = `tool-user-${index}`;
      messages.push(user(userId, `request ${index}`));
      messages.push(
        assistant(`tool-answer-${index}`, userId, "working", [
          {
            type: "tool",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "logs" },
              output: "x".repeat(30_000),
            },
          },
        ]),
      );
    }
    messages.push(user("current", "continue"));

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });
    const tailId = result.state.checkpoint?.tailStartMessageId;
    const tailIndex = messages.findIndex(
      (message) => message.info.id === tailId,
    );

    expect(result.reset).toBe(true);
    expect(tailIndex).toBeGreaterThan(0);
    expect(result.messages.slice(2)).toEqual(messages.slice(tailIndex));
    result.messages.slice(2).forEach((message, index) => {
      expect(message).toBe(messages[tailIndex + index]);
      expect(message.parts).toBe(messages[tailIndex + index]?.parts);
    });
    expect(
      result.messages
        .slice(2)
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool")
        .every((part) =>
          typeof part.state === "object" && part.state !== null
            ? !("compacted" in ((part.state as { time?: object }).time ?? {}))
            : true,
        ),
    ).toBe(true);
  });

  it("does not archive an interleaved source that survives in the raw tail", async () => {
    const messages = [
      user("first", "u".repeat(12_000)),
      user("intervening", "v".repeat(20_000)),
      assistant("late-first-answer", "first", "a".repeat(10_000), [], 100_000),
      user("current", "continue"),
    ];
    const canonical = segmentMessages(messages);
    expect(canonical[0]?.sourceMessageIds).toEqual([
      "first",
      "late-first-answer",
    ]);

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });

    expect(result.reset).toBe(true);
    expect(result.state.checkpoint?.tailStartMessageId).toBe("current");
    expect(result.messages.slice(2)).toEqual(messages.slice(3));
  });

  it("marks an interior orphan assistant outside canonical coverage as lossy", async () => {
    const messages = longSession();
    messages.splice(
      4,
      0,
      assistant("orphan", "missing-user", "ORPHAN_VISIBLE_TEXT"),
    );

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });

    expect(result.reset).toBe(true);
    expect(result.diagnostic?.lossy).toBe(true);
    expect(result.diagnostic?.omissionReasons).toContain(
      "unsegmented-archived-messages-omitted",
    );
    expect(projectedContext(result.messages)).not.toContain(
      "ORPHAN_VISIBLE_TEXT",
    );
    expect(projectedContext(result.messages)).toContain(
      "outside canonical source segments",
    );
  });

  it("ignores host-invisible orphan messages when reporting coverage loss", async () => {
    const messages = longSession();
    const invisible = assistant("orphan", "missing-user", "");
    invisible.parts = [{ type: "step-start" }];
    messages.splice(4, 0, invisible);

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });

    expect(result.reset).toBe(true);
    expect(result.diagnostic?.omissionReasons).not.toContain(
      "unsegmented-archived-messages-omitted",
    );
  });

  it("archives an exact user-ending anchor after later same-turn source", async () => {
    const messages = [
      user("u1", "request"),
      assistant("a1", "u1", "done", [], 100_000),
    ];
    const canonical = segmentMessages(messages, 100, [
      {
        startUserMessageId: "u1",
        endUserMessageId: "u1",
        sourceBoundaryVersion: 2,
        startSourceMessageId: "u1",
        endSourceMessageId: "u1",
      },
    ]);
    const archived = canonical[0]!;
    const summary: StoredSegmentSummary = {
      id: segmentIdForRequest({
        session_id: SESSION_ID,
        start_user_message_id: archived.startUserMessageId,
        source_boundary_version: 2,
        start_source_message_id: archived.startSourceMessageId,
      }),
      start_user_message_id: archived.startUserMessageId,
      end_user_message_id: archived.endUserMessageId,
      source_boundary_version: 2,
      start_source_message_id: archived.startSourceMessageId!,
      end_source_message_id: archived.endSourceMessageId!,
      projection_version: 1,
      summary: "User request",
    };

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadCanonicalSegments: async () => canonical,
      loadSummaries: async () => [summary],
    });

    expect(canonical.map((segment) => segment.closed)).toEqual([true, false]);
    expect(result.reset).toBe(true);
    expect(result.state.checkpoint?.tailStartMessageId).toBe("a1");
  });

  it("retains an assistant-starting canonical tail by exact identity", async () => {
    const messages = [
      user("turn", "request"),
      assistant("step-1", "turn", "a".repeat(30_000), [], 100_000),
      assistant("step-2", "turn", "b".repeat(30_000)),
      user("current", "continue"),
    ];
    const canonical = segmentMessages(messages);

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadCanonicalSegments: async () => canonical,
      loadSummaries: async () => summaries(messages),
    });

    expect(canonical.map((segment) => segment.startMessageId)).toContain(
      "step-2",
    );
    expect(result.reset).toBe(true);
    expect(result.state.checkpoint?.tailStartMessageId).toBe("step-2");
    expect(result.messages[2]).toBe(messages[2]);
    expect(result.messages[2]?.parts).toBe(messages[2]?.parts);
    expect(result.messages[3]).toBe(messages[3]);
    expect(result.messages[0]?.info).toMatchObject({
      role: "user",
      sessionID: SESSION_ID,
      model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
    });
    expect(result.messages[1]?.info).toMatchObject({
      role: "assistant",
      sessionID: SESSION_ID,
      providerID: PROVIDER_ID,
      modelID: MODEL_ID,
      parentID: result.messages[0]?.info.id,
    });
  });

  it("maps canonical raw cutoffs into native-compacted model order", async () => {
    const raw = longSession();
    const retainedIndex = raw.findIndex((message) => message.info.id === "u8");
    const compactionUser = user("compaction-user", "");
    compactionUser.parts = [{ type: "compaction" }];
    const compactionSummary = assistant(
      "compaction-summary",
      "compaction-user",
      "Previous native summary",
    );
    compactionSummary.info.summary = true;
    const filtered = [
      compactionUser,
      compactionSummary,
      ...raw.slice(retainedIndex),
    ];
    const canonical = segmentMessages(raw);
    const loadSummaries = vi.fn(
      async (_required: readonly ReflectionSegment[]) => summaries(raw),
    );

    const result = await projectMessages({
      messages: filtered,
      contextLimit: CONTEXT_LIMIT,
      loadCanonicalSegments: async () => canonical,
      loadSummaries,
    });

    expect(result.reset).toBe(true);
    expect(projectedContext(result.messages)).toContain(
      "Previous native summary",
    );
    expect(loadSummaries.mock.calls[0]?.[0][0]?.startMessageId).toBe("u0");
    const tailId = result.state.checkpoint?.tailStartMessageId;
    const tailIndex = filtered.findIndex(
      (message) => message.info.id === tailId,
    );
    expect(tailIndex).toBeGreaterThan(1);
    result.messages.slice(2).forEach((message, index) => {
      expect(message).toBe(filtered[tailIndex + index]);
    });
  });

  it("skips canonical cutoffs that are nonmonotonic in model order", async () => {
    const raw = [
      user("u0", "request 0"),
      assistant("a0", "u0", "a".repeat(30_000)),
      user("u1", "request 1"),
      assistant("a1", "u1", "b".repeat(30_000), [], 100_000),
      user("u2", "request 2"),
      assistant("a2", "u2", "c".repeat(30_000)),
      user("current", "continue"),
    ];
    const filtered = [
      raw[0]!,
      raw[1]!,
      raw[4]!,
      raw[5]!,
      raw[2]!,
      raw[3]!,
      raw[6]!,
    ];
    const canonical = segmentMessages(raw);

    const result = await projectMessages({
      messages: filtered,
      contextLimit: CONTEXT_LIMIT,
      loadCanonicalSegments: async () => canonical,
      loadSummaries: async () => summaries(raw),
    });

    expect(result.reset).toBe(true);
    expect(result.state.checkpoint?.tailStartMessageId).toBe("current");
    expect(result.messages[2]).toBe(raw[6]);
  });

  it("immediately resets when switching to a smaller context model", async () => {
    const messages = longSession();
    const first = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });

    const result = await projectMessages({
      messages,
      contextLimit: 60_000,
      outputLimit: 20_000,
      previous: first.state,
      loadSummaries: async () => summaries(messages),
    });

    expect(result.reset).toBe(true);
    expect(result.state.contextLimit).toBe(60_000);
    expect(result.estimatedTokens).toBeLessThan(45_000);
  });

  it("resets a smaller model during an assistant loop below the hard limit", async () => {
    const messages = longSession();
    const first = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });
    const continued = [
      ...messages,
      assistant("current-assistant", "current", "working", [], 30_000),
    ];
    const loadSummaries = vi.fn(async () => summaries(continued));

    const result = await projectMessages({
      messages: continued,
      contextLimit: 80_000,
      outputLimit: 20_000,
      previous: first.state,
      loadSummaries,
    });

    expect(result.hardLimitTokens).toBe(60_000);
    expect(result.reset).toBe(true);
    expect(loadSummaries).toHaveBeenCalledOnce();
  });

  it("keeps a lossy checkpoint stable until the next normal compaction", async () => {
    const messages = longSession();
    const first = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });
    const lossy = await projectMessages({
      messages,
      contextLimit: 90_000,
      inputLimit: 80_000,
      outputLimit: 20_000,
      previous: first.state,
      loadSummaries: async () => [],
    });

    expect(lossy.reset).toBe(true);
    expect(lossy.state.checkpoint?.lossy).toBe(true);
    expect(projectedContext(lossy.messages)).toContain(PROJECTION_LOSS_WARNING);

    const answered = [
      ...messages,
      assistant("current-answer", "current", "done", [], 55_000),
    ];
    const loadSummaries = vi.fn(async () => summaries(answered));
    const toolLoop = await projectMessages({
      messages: answered,
      contextLimit: 90_000,
      inputLimit: 80_000,
      outputLimit: 20_000,
      previous: lossy.state,
      loadSummaries,
    });

    expect(toolLoop.reset).toBe(false);
    expect(toolLoop.state.checkpoint).toEqual(lossy.state.checkpoint);
    expect(loadSummaries).not.toHaveBeenCalled();

    const continued = [
      ...answered,
      user("next", `continue ${"x".repeat(20_000)}`),
    ];
    const retried = await projectMessages({
      messages: continued,
      contextLimit: 90_000,
      inputLimit: 80_000,
      outputLimit: 20_000,
      previous: toolLoop.state,
      loadSummaries: async () => summaries(continued),
    });

    expect(retried.reset).toBe(true);
    expect(retried.state.contextLimit).toBe(90_000);
  });

  it("compacts lossily with explicit markers when coverage is incomplete", async () => {
    const messages = longSession();
    const incomplete = summaries(messages).slice(1);

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      inputLimit: 110_000,
      outputLimit: 10_000,
      loadSummaries: async () => incomplete,
    });

    expect(result.reset).toBe(true);
    expect(result.state.checkpoint?.lossy).toBe(true);
    expect(result.diagnostic?.omissionReasons).toContain(
      "missing-segment-summaries",
    );
    expect(result.diagnostic?.includedSummaryCount).toBeGreaterThan(0);
    expect(projectedContext(result.messages)).toContain(
      "one or more archived closed segments had no exact committed Reflection summary",
    );
  });

  it("requires the deterministic ID and complete V2 source boundary for coverage", async () => {
    const messages = [
      user("turn", "request"),
      assistant("step-1", "turn", "a".repeat(30_000), [], 100_000),
      assistant("step-2", "turn", "b".repeat(30_000)),
      user("current", "continue"),
    ];
    const canonical = segmentMessages(messages);
    const first = summaries(messages)[0];
    if (!first || first.source_boundary_version !== 2) {
      throw new Error("expected a V2 summary");
    }
    const wrongBoundary: StoredSegmentSummary = {
      ...first,
      end_source_message_id: "step-2",
    };

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadCanonicalSegments: async () => canonical,
      loadSummaries: async () => [wrongBoundary],
    });

    expect(result.reset).toBe(true);
    expect(result.state.checkpoint?.lossy).toBe(true);
    expect(result.diagnostic?.omissionReasons).toContain(
      "missing-segment-summaries",
    );
  });

  it("retains the open segment raw and uses only closed segment summaries", async () => {
    const messages: OpenCodeMessage[] = [];
    for (let index = 0; index < 20; index += 1) {
      const userId = `boundary-user-${index}`;
      messages.push(user(userId, "u".repeat(5_000)));
      messages.push(
        assistant(`boundary-assistant-${index}`, userId, "a".repeat(5_000)),
      );
    }
    messages.push(user("open-user", "retain this open turn"));
    const localSegments = segmentMessages(messages);
    const closedSegments = localSegments.filter((segment) => segment.closed);
    const closedSummaries = summaries(messages).slice(0, closedSegments.length);

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => closedSummaries,
    });

    expect(result.reset).toBe(true);
    expect(result.state.checkpoint?.lossy).toBeUndefined();
    expect(
      localSegments.map((segment) => segment.startUserMessageId),
    ).toContain(result.state.checkpoint?.tailStartMessageId);
    expect(result.messages).toContain(messages.at(-1));
    expect(closedSummaries).not.toContainEqual(
      expect.objectContaining({ end_user_message_id: "open-user" }),
    );
  });

  it("compacts lossily when the summary service errors", async () => {
    const messages = longSession();

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      outputLimit: 0,
      loadSummaries: async () => {
        throw new Error("service unavailable");
      },
    });

    expect(result.reset).toBe(true);
    expect(result.diagnostic?.omissionReasons).toContain(
      "summary-service-unavailable",
    );
    expect(projectedContext(result.messages)).not.toContain(
      "service unavailable",
    );
  });

  it("fails closed for malformed model-visible media", async () => {
    const messages = longSession();
    const current = messages.at(-1);
    if (current) {
      current.parts = [
        ...current.parts,
        {
          type: "file",
          filename: "malformed.pdf",
          mime: "application/pdf",
          url: "data:application/pdf;base64",
        },
      ];
    }

    await expect(
      projectMessages({
        messages,
        contextLimit: CONTEXT_LIMIT,
        loadSummaries: async () => [],
      }),
    ).rejects.toThrow("safe message-aligned projection tail");
  });

  it("keeps a cutoff when switching to a larger context model", async () => {
    const messages = longSession();
    const first = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });
    const loadSummaries = vi.fn(async () => summaries(messages));

    const result = await projectMessages({
      messages,
      contextLimit: 240_000,
      previous: first.state,
      loadSummaries,
    });

    expect(result.reset).toBe(false);
    expect(result.state.checkpoint).toEqual(first.state.checkpoint);
    expect(result.state.contextLimit).toBe(240_000);
    expect(loadSummaries).not.toHaveBeenCalled();
  });

  it("carries forward an existing native summary and marks missing tail coverage", async () => {
    const tail = longSession();
    const compactionUser: OpenCodeMessage = {
      info: {
        id: "compaction-user",
        sessionID: SESSION_ID,
        role: "user",
        model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
      },
      parts: [{ type: "compaction" }],
    };
    const compactionSummary: OpenCodeMessage = {
      info: {
        id: "compaction-summary",
        sessionID: SESSION_ID,
        role: "assistant",
        parentID: "compaction-user",
        summary: true,
      },
      parts: [{ type: "text", text: "Previous anchored summary" }],
    };
    const messages = [compactionUser, compactionSummary, ...tail];
    const available = summaries(tail).slice(1);

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => available,
    });

    const context = projectedContext(result.messages);
    expect(result.reset).toBe(true);
    expect(context).toContain("Previous anchored summary");
    expect(context).toContain(
      "archived closed segments had no exact committed Reflection summary",
    );
    expect(result.state.checkpoint?.lossy).toBe(true);
  });

  it("compacts lossily when no Reflection segment follows native compaction", async () => {
    const compactionUser: OpenCodeMessage = {
      info: {
        id: "compaction-user",
        sessionID: SESSION_ID,
        role: "user",
        model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
      },
      parts: [{ type: "compaction" }],
    };
    const compactionSummary: OpenCodeMessage = {
      info: {
        id: "compaction-summary",
        sessionID: SESSION_ID,
        role: "assistant",
        parentID: "compaction-user",
        summary: true,
      },
      parts: [{ type: "text", text: "Previous anchored summary" }],
    };
    const messages = [compactionUser, compactionSummary, ...longSession()];

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      inputLimit: 110_000,
      outputLimit: 10_000,
      loadSummaries: async () => [],
    });

    expect(result.reset).toBe(true);
    expect(result.state.checkpoint?.lossy).toBe(true);
    expect(projectedContext(result.messages)).toContain(
      "Previous anchored summary",
    );
  });

  it("does not treat a cross-segment summary as closed-segment coverage", async () => {
    const messages = [
      user("u0", "x".repeat(400_000)),
      assistant("a0", "u0", "answer", [], 100_000),
      user("unanswered", `do not erase me ${"x".repeat(200_000)}`),
      user("current", "continue"),
    ];

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => [
        v1Summary(
          "u0",
          "unanswered",
          "Summary including the unanswered request",
          0,
        ),
      ],
    });

    expect(result.reset).toBe(true);
    expect(result.state.checkpoint?.lossy).toBe(true);
    expect(result.diagnostic?.omissionReasons).toContain(
      "missing-segment-summaries",
    );
  });

  it("projects an unanswered turn even when no assistant exists to clone", async () => {
    const messages = [
      user("unanswered", "x".repeat(400_000)),
      user("current", "continue"),
    ];

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });

    expect(result.reset).toBe(true);
    expect(result.state.checkpoint?.lossy).toBeUndefined();
    expect(result.messages[1]?.info).toMatchObject({
      role: "assistant",
      providerID: PROVIDER_ID,
      modelID: MODEL_ID,
      finish: "stop",
      cost: 0,
    });
  });

  it("does not resurrect compacted tool output", async () => {
    const messages = longSession();
    const firstAssistant = messages.find(
      (message) => message.info.role === "assistant",
    );
    const tool = firstAssistant?.parts.find((part) => part.type === "tool");
    if (tool) {
      tool.state = {
        status: "completed",
        input: { command: "pnpm test" },
        output: "PRUNED_SECRET",
        time: { compacted: 1 },
        attachments: [{ filename: "report.pdf", mime: "application/pdf" }],
      };
    }

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });
    const context = projectedContext(result.messages);

    expect(context).not.toContain("PRUNED_SECRET");
    expect(context).toContain("tool output was compacted by OpenCode");
    expect(context).toContain("report.pdf (application/pdf)");
  });

  it("invalidates a checkpoint when archived tool state is compacted", async () => {
    const messages = longSession();
    const firstAssistant = messages.find(
      (message) => message.info.role === "assistant",
    );
    const tool = firstAssistant?.parts.find((part) => part.type === "tool");
    if (!tool || typeof tool.state !== "object" || tool.state === null) {
      throw new Error("expected archived tool state");
    }
    tool.state = {
      ...(tool.state as Record<string, unknown>),
      output: "CHECKPOINT_SECRET",
    };
    const first = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });
    expect(projectedContext(first.messages)).toContain("CHECKPOINT_SECRET");

    tool.state = {
      ...(tool.state as Record<string, unknown>),
      time: { compacted: 1 },
    };
    const loadSummaries = vi.fn(async () => summaries(messages));
    const second = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      previous: first.state,
      loadSummaries,
    });

    expect(second.reset).toBe(true);
    expect(loadSummaries).toHaveBeenCalledOnce();
    expect(projectedContext(second.messages)).not.toContain(
      "CHECKPOINT_SECRET",
    );
    expect(projectedContext(second.messages)).toContain(
      "tool output was compacted by OpenCode",
    );
  });

  it("archives provider-visible ignored assistant tool records", async () => {
    const messages = longSession();
    const firstAssistant = messages.find(
      (message) => message.info.role === "assistant",
    );
    if (firstAssistant) {
      firstAssistant.parts = [
        ...firstAssistant.parts,
        {
          type: "tool",
          tool: "bash",
          ignored: true,
          state: {
            status: "completed",
            input: { command: "read secret" },
            output: "IGNORED_SECRET",
          },
        },
      ];
    }

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });

    expect(projectedContext(result.messages)).toContain("IGNORED_SECRET");
    expect(result.diagnostic?.omissionReasons).not.toContain(
      "tool-record-truncation",
    );
  });

  it("counts 600k of ignored assistant text as provider-visible", async () => {
    const ignoredAssistant = assistant("a0", "u0", "");
    ignoredAssistant.parts = [
      { type: "text", text: "x".repeat(600_000), ignored: true },
    ];
    const messages = [
      user("u0", "old request"),
      ignoredAssistant,
      user("current", "continue"),
    ];
    const loadSummaries = vi.fn(async () => summaries(messages));

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries,
    });

    expect(result.reset).toBe(true);
    expect(loadSummaries).toHaveBeenCalledOnce();
  });

  it("marks summary and tool budget omissions as lossy", async () => {
    const messages = longSession();
    const firstAssistant = messages.find(
      (message) => message.info.role === "assistant",
    );
    if (firstAssistant) {
      firstAssistant.parts = [
        ...firstAssistant.parts,
        ...Array.from({ length: 10 }, (_, index) => ({
          type: "tool",
          tool: `tool-${index}`,
          state: {
            status: "completed",
            input: { index },
            output: "t".repeat(1_000),
          },
        })),
      ];
    }
    const oversized = summaries(messages).map((summary) => ({
      ...summary,
      summary: "s".repeat(30_000),
    }));

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => oversized,
    });

    expect(result.reset).toBe(true);
    expect(result.diagnostic?.omissionReasons).toEqual(
      expect.arrayContaining([
        "summary-budget-omission",
        "tool-budget-omission",
      ]),
    );
    expect(projectedContext(result.messages)).toContain(
      "older summary context exceeded",
    );
    expect(projectedContext(result.messages)).toContain(
      "older tool records exceeded",
    );
  });

  it("marks unfinished tools and archived media as lossy", async () => {
    const messages = longSession();
    const firstUser = messages.find((message) => message.info.role === "user");
    const firstAssistant = messages.find(
      (message) => message.info.role === "assistant",
    );
    if (firstUser) {
      firstUser.parts = [
        ...firstUser.parts,
        {
          type: "file",
          filename: "reference.png",
          mime: "image/png",
          url: "data:image/png;base64,YQ==",
        },
      ];
    }
    if (firstAssistant) {
      firstAssistant.parts = [
        ...firstAssistant.parts,
        {
          type: "tool",
          tool: "bash",
          state: { status: "running", input: { command: "sleep 10" } },
        },
      ];
    }

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });

    expect(result.diagnostic?.omissionReasons).toEqual(
      expect.arrayContaining([
        "unfinished-tool-records-omitted",
        "archived-media-omitted",
      ]),
    );
    expect(projectedContext(result.messages)).toContain(
      "pending, running, or unsupported archived tool records",
    );
    expect(projectedContext(result.messages)).toContain(
      "archived media content",
    );
  });

  it("does not count 400k of generic errored assistant text", async () => {
    const failed = assistant("a0", "u0", "x".repeat(400_000));
    failed.info.error = { name: "UnknownError" };
    const messages = [
      user("u0", "request"),
      failed,
      user("current", "continue"),
    ];
    const loadSummaries = vi.fn(async () => summaries(messages));

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries,
    });

    expect(result.reset).toBe(false);
    expect(result.estimatedTokens).toBeLessThan(CONTEXT_LIMIT * 0.75);
    expect(loadSummaries).not.toHaveBeenCalled();
    expect(segmentMessages(messages)[0]?.messages).not.toContainEqual({
      role: "assistant",
      text: expect.any(String),
    });
  });

  it("does not archive or classify generic errored assistant parts", async () => {
    const failed = assistant("a0", "u0", "HIDDEN_ERROR_TEXT", [
      { type: "reasoning", text: "HIDDEN_ERROR_REASONING" },
      {
        type: "file",
        filename: "hidden.png",
        mime: "image/png",
        url: "data:image/png;base64,YQ==",
      },
      {
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "read secret" },
          output: "HIDDEN_ERROR_TOOL",
        },
      },
    ]);
    failed.info.error = { name: "UnknownError" };
    const messages = [
      user("u0", "x".repeat(400_000)),
      failed,
      user("current", "continue"),
    ];

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });
    const context = projectedContext(result.messages);

    expect(result.reset).toBe(true);
    expect(result.state.checkpoint?.lossy).toBeUndefined();
    expect(result.diagnostic?.omissionReasons).toEqual([]);
    expect(context).not.toContain("HIDDEN_ERROR_TEXT");
    expect(context).not.toContain("HIDDEN_ERROR_REASONING");
    expect(context).not.toContain("HIDDEN_ERROR_TOOL");
    expect(context).not.toContain("hidden.png");
  });

  it("counts an aborted assistant with visible text", async () => {
    const aborted = assistant("a0", "u0", "x".repeat(400_000));
    aborted.info.error = { name: "MessageAbortedError" };
    aborted.parts = [
      { type: "step-start" },
      { type: "reasoning", text: "internal" },
      ...aborted.parts,
    ];
    const messages = [user("u0", "request"), aborted, user("current", "go")];
    const loadSummaries = vi.fn(async () => summaries(messages));

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries,
    });

    expect(result.reset).toBe(true);
    expect(loadSummaries).toHaveBeenCalledOnce();
    expect(result.diagnostic?.omissionReasons).toContain(
      "archived-reasoning-omitted",
    );
    expect(segmentMessages(messages)[0]?.messages).toContainEqual({
      role: "assistant",
      text: "x".repeat(400_000),
    });
  });

  it("does not count opaque attachment bytes as text tokens", async () => {
    const messages = longSession();
    const current = messages.at(-1);
    if (current) {
      current.parts = [
        ...current.parts,
        {
          type: "file",
          filename: "image.png",
          mime: "image/png",
          url: `data:image/png;base64,${"a".repeat(1_000_000)}`,
        },
      ];
    }

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });

    expect(result.reset).toBe(true);
    expect(result.estimatedTokens).toBeLessThan(CONTEXT_LIMIT * 0.75);
    expect(result.messages.at(-1)?.parts.at(-1)?.filename).toBe("image.png");
  });

  it("counts model-visible tool attachments toward request pressure", async () => {
    const messages = longSession(2);
    const latestAssistant = [...messages]
      .reverse()
      .find((message) => message.info.role === "assistant");
    if (latestAssistant) {
      latestAssistant.parts = [
        ...latestAssistant.parts,
        {
          type: "tool",
          tool: "render",
          state: {
            status: "completed",
            input: {},
            output: "rendered",
            time: { start: 0, end: 1 },
            attachments: Array.from({ length: 10 }, (_, index) => ({
              filename: `image-${index}.png`,
              mime: "image/png",
              url: `data:image/png;base64,${"a".repeat(10_000)}`,
            })),
          },
        },
      ];
    }

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });

    expect(result.reset).toBe(true);
  });

  it.each(["input", "output"] as const)(
    "counts inline tool data in uncompacted %s toward request pressure",
    async (location) => {
      const messages = longSession(2);
      const latestAssistant = [...messages]
        .reverse()
        .find((message) => message.info.role === "assistant");
      const payload = `data:application/octet-stream;base64,${"a".repeat(500_000)}`;
      if (latestAssistant) {
        latestAssistant.parts = [
          ...latestAssistant.parts,
          {
            type: "tool",
            tool: "custom",
            state: {
              status: "completed",
              input: location === "input" ? { payload } : {},
              output: location === "output" ? payload : "done",
            },
          },
        ];
      }

      const result = await projectMessages({
        messages,
        contextLimit: CONTEXT_LIMIT,
        loadSummaries: async () => summaries(messages),
      });

      expect(result.reset).toBe(true);
    },
  );

  it("counts deeply nested tool input toward request pressure", async () => {
    const messages = longSession(2);
    const latestAssistant = [...messages]
      .reverse()
      .find((message) => message.info.role === "assistant");
    let nested: unknown = "x".repeat(500_000);
    for (let depth = 0; depth < 12; depth += 1) nested = { nested };
    if (latestAssistant) {
      latestAssistant.parts = [
        ...latestAssistant.parts,
        {
          type: "tool",
          tool: "custom",
          state: { status: "completed", input: nested, output: "done" },
        },
      ];
    }

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });

    expect(result.reset).toBe(true);
  });

  it("counts multibyte model-visible text using UTF-8 pressure", async () => {
    const messages = [
      user("u0", "漢".repeat(150_000)),
      assistant("a0", "u0", "done"),
      user("current", "continue"),
    ];

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });

    expect(result.reset).toBe(true);
    expect(result.state.checkpoint?.tailStartMessageId).toBe("current");
  });

  it("marks an uncovered unanswered gap after a native summary as lossy", async () => {
    const compactionUser = user("compaction-user", "");
    compactionUser.parts = [{ type: "compaction" }];
    const compactionSummary = assistant(
      "compaction-summary",
      "compaction-user",
      "Previous summary",
    );
    compactionSummary.info.summary = true;
    const messages = [
      compactionUser,
      compactionSummary,
      user("unanswered", "x".repeat(200_000)),
      user("covered", "y".repeat(200_000)),
      assistant("covered-answer", "covered", "answer", [], 100_000),
      user("current", "continue"),
    ];

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => [
        v1Summary("covered", "covered", "Covered summary"),
      ],
    });

    expect(result.reset).toBe(true);
    expect(result.diagnostic?.omissionReasons).toContain(
      "missing-segment-summaries",
    );
  });

  it("preserves an assistant-first native compaction tail", async () => {
    const tail = longSession();
    const compactionUser = user("compaction-user", "");
    compactionUser.parts = [{ type: "compaction" }];
    const compactionSummary = assistant(
      "compaction-summary",
      "compaction-user",
      "Previous summary",
    );
    compactionSummary.info.summary = true;
    const retainedAssistant = assistant(
      "retained-assistant",
      "older-user-not-in-tail",
      "CRITICAL RETAINED ASSISTANT TEXT",
    );
    const messages = [
      compactionUser,
      compactionSummary,
      retainedAssistant,
      ...tail,
    ];

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(tail),
    });

    expect(projectedContext(result.messages)).toContain(
      "CRITICAL RETAINED ASSISTANT TEXT",
    );
  });

  it("omits inherited reasoning with a lossy warning", async () => {
    const tail = longSession();
    const compactionUser = user("compaction-user", "");
    compactionUser.parts = [{ type: "compaction" }];
    const compactionSummary = assistant(
      "compaction-summary",
      "compaction-user",
      "Previous summary",
    );
    compactionSummary.info.summary = true;
    const retainedReasoning = assistant(
      "retained-reasoning",
      "older-user-not-in-tail",
      "",
    );
    retainedReasoning.parts = [
      {
        type: "reasoning",
        text: "CRITICAL RETAINED REASONING",
        ignored: true,
      },
    ];
    const messages = [
      compactionUser,
      compactionSummary,
      retainedReasoning,
      ...tail,
    ];

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(tail),
    });

    expect(result.reset).toBe(true);
    expect(projectedContext(result.messages)).not.toContain(
      "CRITICAL RETAINED REASONING",
    );
    expect(projectedContext(result.messages)).toContain(
      "inherited reasoning could not be retained safely",
    );
  });

  it("uses a finite reserve for remote images", async () => {
    const messages = longSession();
    const current = messages.at(-1);
    if (current) {
      current.parts = [
        ...current.parts,
        {
          type: "file",
          filename: "remote.png",
          mime: "image/png",
          url: "https://example.com/remote.png",
        },
      ];
    }

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });

    expect(result.reset).toBe(true);
    expect(result.messages.at(-1)?.parts.at(-1)?.filename).toBe("remote.png");
  });

  it("does not let reported tokens hide unknown remote media size", async () => {
    const messages = longSession();
    messages[0]!.parts = [
      ...messages[0]!.parts,
      {
        type: "file",
        filename: "mutable.pdf",
        mime: "application/pdf",
        url: "https://example.com/mutable.pdf",
      },
    ];

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });

    expect(result.reset).toBe(true);
  });

  it("fails at the hard limit for one unsplittable source message", async () => {
    const messages = [user("only", "x".repeat(500_000))];

    await expect(
      projectMessages({
        messages,
        contextLimit: CONTEXT_LIMIT,
        loadSummaries: async () => [],
      }),
    ).rejects.toThrow("safe message-aligned projection cutoff");
  });
});

describe("projectMessages request estimate", () => {
  // Every assistant turn reports the small input count it was billed for while
  // a checkpoint was in effect. Once that checkpoint is gone the payload is the
  // full raw history, so the reported anchor no longer describes what is sent.
  function compactedAnchorSession(turns: number): OpenCodeMessage[] {
    const messages: OpenCodeMessage[] = [];
    for (let index = 0; index < turns; index += 1) {
      const id = `u${index}`;
      messages.push(user(id, `request ${index} ${"u".repeat(12_500)}`));
      messages.push(
        assistant(
          `a${index}`,
          id,
          `response ${index} ${"a".repeat(12_500)}`,
          [],
          4_000,
        ),
      );
    }
    messages.push(user("current", "continue"));
    return messages;
  }

  it("never reports fewer tokens than the payload it returns", async () => {
    const messages = compactedAnchorSession(40);

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });

    expect(result.estimatedTokens).toBeGreaterThanOrEqual(
      estimateTokens(result.messages),
    );
    expect(result.estimatedTokens).toBeLessThan(result.thresholdTokens);
  });

  it("compacts a session whose stale anchor understates the raw history", async () => {
    const messages = compactedAnchorSession(40);

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries: async () => summaries(messages),
    });

    expect(result.reset).toBe(true);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(estimateTokens(result.messages)).toBeLessThan(CONTEXT_LIMIT);
  });
});
