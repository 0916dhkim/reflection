import { describe, expect, it } from "vitest";

import {
  PROJECTION_LOSS_WARNING,
  PROJECTION_LOSS_WARNING_METADATA,
  isModelVisibleMessage,
  isNormalUserMessage,
  isProjectionLossWarningMessage,
  readSegmentMessages,
  segmentMessages,
  textOf,
  modelVisibleCharWeightOf,
  type OpenCodeMessage,
} from "../src/segments.js";

function user(id: string, ...texts: string[]): OpenCodeMessage {
  return {
    info: { id, role: "user" },
    parts: texts.map((text) => ({ type: "text", text })),
  };
}

function assistant(
  id: string,
  parentID: string,
  ...texts: string[]
): OpenCodeMessage {
  return {
    info: {
      id,
      role: "assistant",
      parentID,
      finish: "stop",
      time: { created: 0, completed: 1 },
    },
    parts: texts.map((text) => ({ type: "text", text })),
  };
}

describe("textOf", () => {
  it("concatenates only ordered text parts", () => {
    const message: OpenCodeMessage = {
      info: { id: "a1", role: "assistant", parentID: "u1" },
      parts: [
        { type: "text", text: "first" },
        { type: "reasoning", text: "secret" },
        { type: "text", text: "user-only", ignored: true },
        { type: "tool" },
        { type: "text", text: " second" },
        { type: "file", filename: "image.png", mime: "image/png" },
      ],
    };

    expect(textOf(message)).toBe(
      "firstuser-only second[Attachment image.png (image/png)]",
    );
  });

  it("hides ignored user text", () => {
    const message: OpenCodeMessage = {
      info: { id: "u1", role: "user" },
      parts: [
        { type: "text", text: "visible" },
        { type: "text", text: "hidden", ignored: true },
      ],
    };

    expect(textOf(message)).toBe("visible");
  });

  it("matches assistant error visibility", () => {
    const generic = assistant("generic", "u1", "partial");
    generic.info.error = { name: "UnknownError" };
    const aborted = assistant("aborted", "u1", "");
    aborted.info.error = { name: "MessageAbortedError" };
    aborted.parts = [
      { type: "step-start" },
      { type: "reasoning", text: "internal" },
    ];

    expect(isModelVisibleMessage(generic)).toBe(false);
    expect(isModelVisibleMessage(aborted)).toBe(false);

    aborted.parts = [
      ...aborted.parts,
      { type: "tool", tool: "bash", state: { status: "running" } },
    ];
    expect(isModelVisibleMessage(aborted)).toBe(true);
  });

  it("excludes the exact persisted projection warning from source boundaries", () => {
    const warning: OpenCodeMessage = {
      info: { id: "warning", role: "user" },
      parts: [
        {
          type: "text",
          text: PROJECTION_LOSS_WARNING,
          synthetic: false,
          ignored: false,
          metadata: PROJECTION_LOSS_WARNING_METADATA,
        },
      ],
    };
    const messages = [
      user("u1", "first"),
      assistant("a1", "u1", "answer"),
      warning,
      user("u2", "second"),
    ];

    expect(isProjectionLossWarningMessage(warning)).toBe(true);
    expect(isModelVisibleMessage(warning)).toBe(true);
    expect(isNormalUserMessage(warning)).toBe(false);
    expect(textOf(warning)).toBe("");
    expect(segmentMessages(messages)[0]?.messages).toEqual([
      { role: "user", text: "first" },
      { role: "assistant", text: "answer" },
      { role: "user", text: "second" },
    ]);
    expect(readSegmentMessages(messages, "u1", "u2")).toEqual([
      { role: "user", text: "first" },
      { role: "assistant", text: "answer" },
      { role: "user", text: "second" },
    ]);
  });

  it("retains arbitrary or mixed warning-like metadata as user source", () => {
    const mixed: OpenCodeMessage = {
      info: { id: "mixed", role: "user" },
      parts: [
        {
          type: "text",
          text: PROJECTION_LOSS_WARNING,
          synthetic: false,
          ignored: false,
          metadata: {
            ...PROJECTION_LOSS_WARNING_METADATA,
            unrelated: true,
          },
        },
      ],
    };
    const arbitrary: OpenCodeMessage = {
      info: { id: "arbitrary", role: "user" },
      parts: [
        {
          type: "text",
          text: "ordinary user text",
          synthetic: false,
          ignored: false,
          metadata: PROJECTION_LOSS_WARNING_METADATA,
        },
      ],
    };
    const nestedMixed: OpenCodeMessage = {
      info: { id: "nested-mixed", role: "user" },
      parts: [
        {
          type: "text",
          text: PROJECTION_LOSS_WARNING,
          synthetic: false,
          ignored: false,
          metadata: {
            reflection: {
              ...PROJECTION_LOSS_WARNING_METADATA.reflection,
              unrelated: true,
            },
          },
        },
      ],
    };

    expect(isProjectionLossWarningMessage(mixed)).toBe(false);
    expect(isProjectionLossWarningMessage(arbitrary)).toBe(false);
    expect(isProjectionLossWarningMessage(nestedMixed)).toBe(false);
    expect(
      segmentMessages([mixed, arbitrary, nestedMixed])[0]?.messages,
    ).toEqual([
      { role: "user", text: PROJECTION_LOSS_WARNING },
      { role: "user", text: "ordinary user text" },
      { role: "user", text: PROJECTION_LOSS_WARNING },
    ]);
  });
});

describe("segmentMessages", () => {
  it("counts model-visible tool output and reasoning toward segment boundaries", () => {
    const first = assistant("a1", "u1", "answer");
    first.parts = [
      ...first.parts,
      { type: "reasoning", text: "reason" },
      {
        type: "tool",
        tool: "bash",
        state: { status: "completed", input: {}, output: "x".repeat(20) },
      },
    ];
    const messages = [user("u1", "request"), first, user("u2", "next")];

    expect(modelVisibleCharWeightOf(first)).toBeGreaterThan(20);
    expect(segmentMessages(messages, 20)).toMatchObject([
      { startUserMessageId: "u1", endUserMessageId: "u1", closed: true },
      { startUserMessageId: "u2", endUserMessageId: "u2", closed: false },
    ]);
  });

  it("reserves model-visible media carried by tool results", () => {
    const message = assistant("a1", "u1", "done");
    message.parts = [
      {
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          output: "image",
          attachments: [
            { mime: "image/png", url: "https://example.com/image.png" },
          ],
        },
      },
    ];

    expect(modelVisibleCharWeightOf(message)).toBeGreaterThanOrEqual(32_000);

    const embedded = structuredClone(message);
    const tool = embedded.parts[0];
    if (tool?.type === "tool" && typeof tool.state === "object" && tool.state) {
      (
        tool.state as { attachments: Array<{ mime: string; url: string }> }
      ).attachments[0]!.url = `data:image/png;base64,${"x".repeat(1_000_000)}`;
    }
    expect(
      Math.abs(
        modelVisibleCharWeightOf(embedded) - modelVisibleCharWeightOf(message),
      ),
    ).toBeLessThan(100);
  });

  it("preserves maximum non-overlapping committed coverage and segments gaps", () => {
    const messages = [
      user("u1", "1"),
      user("u2", "2"),
      user("u3", "3"),
      user("u4", "4"),
      user("u5", "5"),
    ];

    expect(
      segmentMessages(messages, 2, [
        {
          id: "short",
          startUserMessageId: "u1",
          endUserMessageId: "u2",
          sourceEligible: true,
        },
        {
          id: "long",
          startUserMessageId: "u1",
          endUserMessageId: "u3",
          sourceEligible: false,
        },
        {
          id: "tail",
          startUserMessageId: "u4",
          endUserMessageId: "u4",
          sourceEligible: true,
        },
      ]).map(({ startUserMessageId, endUserMessageId, closed }) => ({
        startUserMessageId,
        endUserMessageId,
        closed,
      })),
    ).toEqual([
      { startUserMessageId: "u1", endUserMessageId: "u3", closed: true },
      { startUserMessageId: "u4", endUserMessageId: "u4", closed: true },
      { startUserMessageId: "u5", endUserMessageId: "u5", closed: false },
    ]);
  });

  it("keeps turns together and starts a new segment when a turn crosses the limit", () => {
    const messages = [
      user("u1", "123"),
      assistant("a1", "u1", "45"),
      user("u2", "1234"),
      assistant("a2", "u2", "56"),
      user("u3", "x"),
    ];

    expect(segmentMessages(messages, 10)).toEqual([
      {
        startUserMessageId: "u1",
        endUserMessageId: "u1",
        charCount: 5,
        closed: true,
        messages: [
          { role: "user", text: "123" },
          { role: "assistant", text: "45" },
        ],
      },
      {
        startUserMessageId: "u2",
        endUserMessageId: "u3",
        charCount: 7,
        closed: false,
        messages: [
          { role: "user", text: "1234" },
          { role: "assistant", text: "56" },
          { role: "user", text: "x" },
        ],
      },
    ]);
  });

  it("closes a single turn that reaches the limit exactly", () => {
    const messages = [user("u1", "123"), assistant("a1", "u1", "45")];

    expect(segmentMessages(messages, 5)).toMatchObject([
      { charCount: 5, closed: true },
    ]);
  });

  it("closes multiple turns that cumulatively reach the limit and starts a new tail", () => {
    const messages = [
      user("u1", "12"),
      assistant("a1", "u1", "3"),
      user("u2", "4"),
      assistant("a2", "u2", "5"),
      user("u3", "6"),
      assistant("a3", "u3", "7"),
    ];

    expect(
      segmentMessages(messages, 5).map(
        ({ startUserMessageId, endUserMessageId, charCount, closed }) => ({
          startUserMessageId,
          endUserMessageId,
          charCount,
          closed,
        }),
      ),
    ).toEqual([
      {
        startUserMessageId: "u1",
        endUserMessageId: "u2",
        charCount: 5,
        closed: true,
      },
      {
        startUserMessageId: "u3",
        endUserMessageId: "u3",
        charCount: 2,
        closed: false,
      },
    ]);
  });

  it("places an oversized turn in a closed standalone segment", () => {
    const messages = [
      user("u1", "12"),
      assistant("a1", "u1", "3"),
      user("u2", "123456"),
      assistant("a2", "u2", ""),
      user("u3", "4"),
      assistant("a3", "u3", "5"),
    ];

    expect(
      segmentMessages(messages, 5).map(
        ({ startUserMessageId, endUserMessageId, charCount, closed }) => ({
          startUserMessageId,
          endUserMessageId,
          charCount,
          closed,
        }),
      ),
    ).toEqual([
      {
        startUserMessageId: "u1",
        endUserMessageId: "u1",
        charCount: 3,
        closed: true,
      },
      {
        startUserMessageId: "u2",
        endUserMessageId: "u2",
        charCount: 6,
        closed: true,
      },
      {
        startUserMessageId: "u3",
        endUserMessageId: "u3",
        charCount: 2,
        closed: false,
      },
    ]);
  });

  it("preserves empty messages and all assistants parented to a user", () => {
    const messages = [
      user("u1"),
      assistant("a1", "u1"),
      assistant("a2", "u1", "answer"),
      assistant("orphan", "missing", "ignored"),
    ];

    expect(segmentMessages(messages, 20)[0].messages).toEqual([
      { role: "user", text: "" },
      { role: "assistant", text: "" },
      { role: "assistant", text: "answer" },
    ]);
  });

  it("ingests unanswered normal user turns without changing user boundaries", () => {
    const messages = [
      user("u1", "first"),
      assistant("a1", "u1", "answer"),
      user("u2", "unanswered"),
      user("u3", "third"),
      assistant("a3", "u3", "answer"),
    ];

    expect(segmentMessages(messages)).toMatchObject([
      {
        startUserMessageId: "u1",
        endUserMessageId: "u3",
        closed: false,
        messages: [
          { role: "user", text: "first" },
          { role: "assistant", text: "answer" },
          { role: "user", text: "unanswered" },
          { role: "user", text: "third" },
          { role: "assistant", text: "answer" },
        ],
      },
    ]);
  });

  it("excludes errored assistant text but retains model-visible intermediates", () => {
    const failed = assistant("a1", "u1", "partial");
    failed.info.error = { name: "UnknownError" };
    const intermediate = assistant("a2", "u2", "working");
    intermediate.info.finish = "tool-calls";

    expect(
      segmentMessages([
        user("u1", "failed"),
        failed,
        user("u2", "unfinished"),
        intermediate,
      ])[0]?.messages,
    ).toEqual([
      { role: "user", text: "failed" },
      { role: "user", text: "unfinished" },
      { role: "assistant", text: "working" },
    ]);
  });
});

describe("readSegmentMessages", () => {
  it("resolves inclusive user boundaries and preserves result order", () => {
    const messages = [
      user("u1", "outside"),
      assistant("a1", "u1", "outside answer"),
      user("u2"),
      assistant("a2", "u2", "inside"),
      user("u3", "also inside"),
      assistant("orphan", "missing", "ignored"),
      assistant("a3", "u3"),
      user("u4", "outside"),
    ];

    expect(readSegmentMessages(messages, "u2", "u3")).toEqual([
      { role: "user", text: "" },
      { role: "assistant", text: "inside" },
      { role: "user", text: "also inside" },
      { role: "assistant", text: "" },
    ]);
  });

  it("includes unanswered user messages between inclusive boundaries", () => {
    const messages = [
      user("u1", "first"),
      assistant("a1", "u1", "first answer"),
      user("u2", "incomplete"),
      user("u3", "last"),
      assistant("a3", "u3", "last answer"),
    ];

    expect(readSegmentMessages(messages, "u1", "u3")).toEqual([
      { role: "user", text: "first" },
      { role: "assistant", text: "first answer" },
      { role: "user", text: "incomplete" },
      { role: "user", text: "last" },
      { role: "assistant", text: "last answer" },
    ]);
  });

  it("rejects missing and reversed boundaries", () => {
    const messages = [
      user("u1"),
      assistant("a1", "u1"),
      user("u2"),
      assistant("a2", "u2"),
    ];

    expect(() => readSegmentMessages(messages, "missing", "u2")).toThrow(
      "not found",
    );
    expect(() => readSegmentMessages(messages, "u2", "u1")).toThrow(
      "out of order",
    );
  });
});
