import { describe, expect, it } from "vitest";

import {
  readSegmentMessages,
  segmentMessages,
  textOf,
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
    info: { id, role: "assistant", parentID },
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
        { type: "tool" },
        { type: "text", text: " second" },
      ],
    };

    expect(textOf(message)).toBe("first second");
  });
});

describe("segmentMessages", () => {
  it("keeps complete turns together and starts a new segment when a turn crosses the limit", () => {
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
        endUserMessageId: "u2",
        charCount: 6,
        closed: false,
        messages: [
          { role: "user", text: "1234" },
          { role: "assistant", text: "56" },
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

  it("excludes incomplete user messages between completed boundary turns", () => {
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
