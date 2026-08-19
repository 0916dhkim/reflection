import { describe, expect, it, vi } from "vitest";

import {
  activeModel,
  estimateTokens,
  projectMessages,
  ProjectionCoverageError,
  type StoredSegmentSummary,
} from "../src/projection.js";
import { segmentMessages, type OpenCodeMessage } from "../src/segments.js";

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
  return segmentMessages(messages).map((segment, index) => ({
    id: `segment-${index}`,
    start_user_message_id: segment.startUserMessageId,
    end_user_message_id: segment.endUserMessageId,
    projection_version: 1,
    summary: `Summary ${index}`,
  }));
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
});

describe("projectMessages", () => {
  it("leaves history untouched below 75% without loading summaries", async () => {
    const messages = longSession(2);
    const loadSummaries = vi.fn(async () => summaries(messages));

    const result = await projectMessages({
      messages,
      contextLimit: CONTEXT_LIMIT,
      loadSummaries,
    });

    expect(result.reset).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(loadSummaries).not.toHaveBeenCalled();
  });

  it("uses provider-reported input and output reservation instead of message size alone", async () => {
    const messages = longSession(2);
    const latestAssistant = [...messages]
      .reverse()
      .find((message) => message.info.role === "assistant");
    if (latestAssistant) {
      latestAssistant.info.tokens = {
        input: 80_000,
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
    expect(result.state.checkpoint?.tailStartUserMessageId).toMatch(/^u/);
    expect(result.messages[2]?.info.id).toBe(
      result.state.checkpoint?.tailStartUserMessageId,
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
    expect(result.messages.at(-1)?.info.id).toBe("current");
  });

  it("keeps the checkpoint stable during an assistant tool loop", async () => {
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
      previous: first.state,
      loadSummaries,
    });

    expect(result.reset).toBe(false);
    expect(result.state.checkpoint).toEqual(first.state.checkpoint);
    expect(loadSummaries).not.toHaveBeenCalled();
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
      previous: first.state,
      loadSummaries: async () => summaries(messages),
    });

    expect(result.reset).toBe(true);
    expect(result.state.contextLimit).toBe(60_000);
    expect(result.estimatedTokens).toBeLessThan(45_000);
  });

  it("fails closed when the archived prefix lacks contiguous summaries", async () => {
    const messages = longSession();
    const incomplete = summaries(messages).slice(1);

    await expect(
      projectMessages({
        messages,
        contextLimit: CONTEXT_LIMIT,
        loadSummaries: async () => incomplete,
      }),
    ).rejects.toThrow(ProjectionCoverageError);
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

  it("carries forward an existing native summary and its partial leading segment", async () => {
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
    expect(context).toContain("Unsummarized User context");
    expect(context).toContain("request 0");
  });

  it("rejects legacy summaries that span an unanswered user message", async () => {
    const messages = [
      user("u0", "x".repeat(400_000)),
      assistant("a0", "u0", "answer", [], 100_000),
      user("unanswered", "do not erase me"),
      user("current", "continue"),
    ];

    await expect(
      projectMessages({
        messages,
        contextLimit: CONTEXT_LIMIT,
        loadSummaries: async () => [
          {
            id: "legacy",
            start_user_message_id: "u0",
            end_user_message_id: "unanswered",
            projection_version: 0,
            summary: "Incorrectly bridged summary",
          },
        ],
      }),
    ).rejects.toThrow(ProjectionCoverageError);
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

  it("does not project away a failed assistant turn", async () => {
    const failed = assistant("a0", "u0", "partial", [], 100_000);
    failed.info.error = { name: "UnknownError" };
    const messages = [
      user("u0", "must remain raw"),
      failed,
      user("current", "continue"),
    ];

    await expect(
      projectMessages({
        messages,
        contextLimit: CONTEXT_LIMIT,
        loadSummaries: async () => [
          {
            id: "failed",
            start_user_message_id: "u0",
            end_user_message_id: "u0",
            projection_version: 0,
            summary: "Partial turn",
          },
        ],
      }),
    ).rejects.toThrow(ProjectionCoverageError);
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

  it("does not archive an unanswered gap after a native summary", async () => {
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

    await expect(
      projectMessages({
        messages,
        contextLimit: CONTEXT_LIMIT,
        loadSummaries: async () => [
          {
            id: "covered-segment",
            start_user_message_id: "covered",
            end_user_message_id: "covered",
            projection_version: 1,
            summary: "Covered summary",
          },
        ],
      }),
    ).rejects.toThrow("Native compaction tail contains an unanswered turn");
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

  it("fails closed on reasoning in an assistant-first native tail", async () => {
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
      { type: "reasoning", text: "CRITICAL RETAINED REASONING" },
    ];
    const messages = [
      compactionUser,
      compactionSummary,
      retainedReasoning,
      ...tail,
    ];

    await expect(
      projectMessages({
        messages,
        contextLimit: CONTEXT_LIMIT,
        loadSummaries: async () => summaries(tail),
      }),
    ).rejects.toThrow("reasoning that cannot be archived safely");
  });

  it("fails closed when non-image media size is unknown", async () => {
    const messages = longSession();
    const current = messages.at(-1);
    if (current) {
      current.parts = [
        ...current.parts,
        {
          type: "file",
          filename: "remote.pdf",
          mime: "application/pdf",
          url: "https://example.com/remote.pdf",
        },
      ];
    }

    await expect(
      projectMessages({
        messages,
        contextLimit: CONTEXT_LIMIT,
        loadSummaries: async () => summaries(messages),
      }),
    ).rejects.toThrow("could not reduce projected context");
  });
});
