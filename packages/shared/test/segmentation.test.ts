import { describe, expect, it } from "vitest";

import { sourceFingerprint } from "../src/domain.js";
import {
  PROJECTION_LOSS_WARNING,
  PROJECTION_LOSS_WARNING_METADATA,
  isModelVisibleMessage,
  isNormalUserMessage,
  isProjectionLossWarningMessage,
  readSegmentMessages,
  segmentMessages,
  submissionSourceFingerprint,
  textOf,
  modelVisibleCharWeightOf,
  type CommittedSegmentBoundary,
  type OpenCodeMessage,
} from "../src/segmentation.js";

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

function v1Boundary(
  startUserMessageId: string,
  endUserMessageId: string,
  overrides: Partial<CommittedSegmentBoundary> = {},
): CommittedSegmentBoundary {
  return {
    startUserMessageId,
    endUserMessageId,
    sourceBoundaryVersion: 1,
    startSourceMessageId: null,
    endSourceMessageId: null,
    ...overrides,
  } as CommittedSegmentBoundary;
}

function v2Boundary(
  userMessageId: string,
  startSourceMessageId: string,
  endSourceMessageId: string,
  overrides: Partial<CommittedSegmentBoundary> = {},
): CommittedSegmentBoundary {
  return {
    startUserMessageId: userMessageId,
    endUserMessageId: userMessageId,
    sourceBoundaryVersion: 2,
    startSourceMessageId,
    endSourceMessageId,
    ...overrides,
  } as CommittedSegmentBoundary;
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
  it("dispatches submission fingerprints by source boundary version", () => {
    const v1 = segmentMessages([
      user("u1", "request"),
      assistant("a1", "u1", "answer"),
    ])[0]!;
    const v2 = segmentMessages([user("u2", "123456")], 5)[0]!;

    expect(submissionSourceFingerprint("session", v1)).toBe(
      sourceFingerprint({
        session_id: "session",
        start_user_message_id: "u1",
        end_user_message_id: "u1",
        source_boundary_version: 1,
        start_source_message_id: null,
        end_source_message_id: null,
        projection_version: 0,
        processing_priority: 0,
        messages: v1.messages,
      }),
    );
    expect(submissionSourceFingerprint("session", v2)).toBe(
      sourceFingerprint({
        session_id: "session",
        start_user_message_id: "u2",
        end_user_message_id: "u2",
        source_boundary_version: 2,
        start_source_message_id: "u2",
        end_source_message_id: "u2",
        projection_version: 0,
        processing_priority: 0,
        messages: v2.messages,
      }),
    );
  });

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
      {
        startUserMessageId: "u1",
        endUserMessageId: "u1",
        sourceBoundaryVersion: 2,
        startSourceMessageId: "u1",
        endSourceMessageId: "a1",
        closed: true,
      },
      {
        startUserMessageId: "u2",
        endUserMessageId: "u2",
        sourceBoundaryVersion: 1,
        closed: false,
      },
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
        v1Boundary("u1", "u2", {
          id: "short",
          sourceEligible: true,
        }),
        v1Boundary("u1", "u3", {
          id: "long",
          sourceEligible: false,
        }),
        v1Boundary("u4", "u4", {
          id: "tail",
          sourceEligible: true,
        }),
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
        sourceBoundaryVersion: 1,
        startSourceMessageId: null,
        endSourceMessageId: null,
        startMessageId: "u1",
        endMessageId: "a1",
        sourceMessageIds: ["u1", "a1"],
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
        sourceBoundaryVersion: 1,
        startSourceMessageId: null,
        endSourceMessageId: null,
        startMessageId: "u2",
        endMessageId: "u3",
        sourceMessageIds: ["u2", "a2", "u3"],
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

  it("uses exact V2 boundaries for an oversized closed turn", () => {
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
        ({
          startUserMessageId,
          endUserMessageId,
          sourceBoundaryVersion,
          startSourceMessageId,
          endSourceMessageId,
          sourceMessageIds,
          charCount,
          closed,
        }) => ({
          startUserMessageId,
          endUserMessageId,
          sourceBoundaryVersion,
          startSourceMessageId,
          endSourceMessageId,
          sourceMessageIds,
          charCount,
          closed,
        }),
      ),
    ).toEqual([
      {
        startUserMessageId: "u1",
        endUserMessageId: "u1",
        sourceBoundaryVersion: 1,
        startSourceMessageId: null,
        endSourceMessageId: null,
        sourceMessageIds: ["u1", "a1"],
        charCount: 3,
        closed: true,
      },
      {
        startUserMessageId: "u2",
        endUserMessageId: "u2",
        sourceBoundaryVersion: 2,
        startSourceMessageId: "u2",
        endSourceMessageId: "a2",
        sourceMessageIds: ["u2", "a2"],
        charCount: 6,
        closed: true,
      },
      {
        startUserMessageId: "u3",
        endUserMessageId: "u3",
        sourceBoundaryVersion: 1,
        startSourceMessageId: null,
        endSourceMessageId: null,
        sourceMessageIds: ["u3", "a3"],
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

    expect(segmentMessages(messages, 20)[0]!.messages).toEqual([
      { role: "user", text: "" },
      { role: "assistant", text: "" },
      { role: "assistant", text: "answer" },
    ]);
  });

  it("uses raw chronological order rather than regrouping by parent", () => {
    const segment = segmentMessages([
      user("u1", "first"),
      user("u2", "second"),
      assistant("late-a1", "u1", "late answer"),
    ])[0]!;

    expect(segment.sourceMessageIds).toEqual(["u1", "u2", "late-a1"]);
    expect(segment.messages).toEqual([
      { role: "user", text: "first" },
      { role: "user", text: "second" },
      { role: "assistant", text: "late answer" },
    ]);
  });

  it("keeps an interleaved oversized turn as one whole-turn range", () => {
    const segments = segmentMessages(
      [
        user("u1", "123456"),
        user("u2", "next"),
        assistant("late-a1", "u1", "789012"),
      ],
      10,
    );

    expect(segments).toMatchObject([
      {
        sourceBoundaryVersion: 1,
        startUserMessageId: "u1",
        endUserMessageId: "u1",
        sourceMessageIds: ["u1", "late-a1"],
        charCount: 12,
        closed: true,
      },
      {
        sourceBoundaryVersion: 1,
        sourceMessageIds: ["u2"],
        closed: false,
      },
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

  it("fragments a multi-assistant oversized turn at whole messages", () => {
    const segments = segmentMessages(
      [
        user("u1", "1234"),
        assistant("a1", "u1", "5678"),
        assistant("a2", "u1", "9012"),
      ],
      10,
    );

    expect(segments).toMatchObject([
      {
        sourceBoundaryVersion: 2,
        startUserMessageId: "u1",
        endUserMessageId: "u1",
        startSourceMessageId: "u1",
        endSourceMessageId: "a1",
        sourceMessageIds: ["u1", "a1"],
        charCount: 8,
        closed: true,
      },
      {
        sourceBoundaryVersion: 2,
        startSourceMessageId: "a2",
        endSourceMessageId: "a2",
        sourceMessageIds: ["a2"],
        charCount: 4,
        closed: false,
      },
    ]);
    expect(segments.flatMap((segment) => segment.sourceMessageIds)).toEqual([
      "u1",
      "a1",
      "a2",
    ]);
  });

  it("cuts an active turn only after a finite completed assistant", () => {
    const incomplete = assistant("a1", "u1", "123456");
    incomplete.info.time = { created: 0, completed: Number.POSITIVE_INFINITY };
    const segments = segmentMessages(
      [
        user("u1", "123456"),
        incomplete,
        assistant("a2", "u1", "x"),
        assistant("a3", "u1", "y"),
      ],
      5,
    );

    expect(segments.map((segment) => segment.sourceMessageIds)).toEqual([
      ["u1", "a1", "a2"],
      ["a3"],
    ]);
    expect(segments.map((segment) => segment.closed)).toEqual([true, false]);
  });

  it("keeps every closed prefix append-stable", () => {
    const initial = [
      user("u1", "1234"),
      assistant("a1", "u1", "5678"),
      assistant("a2", "u1", "9012"),
    ];
    const before = segmentMessages(initial, 10);
    const after = segmentMessages(
      [...initial, assistant("a3", "u1", "abcdefgh")],
      10,
    );

    expect(before[0]!.closed).toBe(true);
    expect(after[0]).toEqual(before[0]);
    expect(after.map((segment) => segment.sourceMessageIds)).toEqual([
      ["u1", "a1"],
      ["a2"],
      ["a3"],
    ]);
  });

  it("never returns a whole-turn V1 segment after a V2 anchor", () => {
    const messages = [
      user("u1", "request"),
      assistant("a1", "u1", "first"),
      assistant("a2", "u1", "second"),
    ];
    const anchor = v2Boundary("u1", "u1", "a1", { id: "prefix" });

    const segments = segmentMessages(messages, 100, [anchor]);
    expect(segments.map((segment) => segment.sourceBoundaryVersion)).toEqual([
      2, 2,
    ]);
    expect(segments.map((segment) => segment.sourceMessageIds)).toEqual([
      ["u1", "a1"],
      ["a2"],
    ]);
    expect(segments.flatMap((segment) => segment.sourceMessageIds)).toEqual([
      "u1",
      "a1",
      "a2",
    ]);
  });

  it("freezes selected V1 coverage before reconciling exact V2 anchors", () => {
    const messages = [
      user("u1", "one"),
      assistant("a1", "u1", "answer one"),
      user("u2", "two"),
      assistant("a2", "u2", "answer two"),
      user("u3", "three"),
      assistant("a3", "u3", "answer three"),
    ];
    const segments = segmentMessages(messages, 100, [
      v1Boundary("u1", "u2", { id: "legacy" }),
      v2Boundary("u2", "a2", "a2", { id: "covered-exact" }),
      v2Boundary("u3", "u3", "a3", { id: "uncovered-exact" }),
    ]);

    expect(
      segments.map((segment) => ({
        version: segment.sourceBoundaryVersion,
        startUser: segment.startUserMessageId,
        endUser: segment.endUserMessageId,
        sourceIds: segment.sourceMessageIds,
      })),
    ).toEqual([
      {
        version: 1,
        startUser: "u1",
        endUser: "u2",
        sourceIds: ["u1", "a1", "u2", "a2"],
      },
      {
        version: 2,
        startUser: "u3",
        endUser: "u3",
        sourceIds: ["u3", "a3"],
      },
    ]);
  });

  it("fails closed for malformed exact source cursors", () => {
    const messages = [
      user("u1", "request"),
      assistant("a1", "u1", "first"),
      assistant("a2", "u1", "second"),
      user("u2", "next"),
    ];
    const missingCursor = {
      startUserMessageId: "u1",
      endUserMessageId: "u1",
      sourceBoundaryVersion: 2,
      startSourceMessageId: "u1",
    } as unknown as CommittedSegmentBoundary;
    for (const boundary of [
      missingCursor,
      v2Boundary("u1", "a2", "a1"),
      v2Boundary("u1", "a1", "u2"),
    ]) {
      expect(() => segmentMessages(messages, 100, [boundary])).toThrow();
    }
  });

  it("drops exact source anchors removed by a local history rewind", () => {
    const messages = [
      user("u1", "request"),
      assistant("a1", "u1", "answer"),
      user("u2", "next"),
    ];

    for (const boundary of [
      v2Boundary("u1", "u1", "removed-assistant"),
      v2Boundary("removed-user", "removed-user", "removed-assistant"),
    ]) {
      expect(segmentMessages(messages, 100, [boundary])).toMatchObject([
        {
          sourceBoundaryVersion: 1,
          sourceMessageIds: ["u1", "a1", "u2"],
        },
      ]);
    }
  });

  it("keeps an unsplittable oversized message intact", () => {
    const active = segmentMessages([user("u1", "123456")], 5);
    expect(active).toMatchObject([
      {
        sourceBoundaryVersion: 2,
        sourceMessageIds: ["u1"],
        charCount: 6,
        closed: false,
      },
    ]);

    const withOversizedAssistant = segmentMessages(
      [
        user("u1", "1"),
        assistant("a1", "u1", "2"),
        assistant("huge", "u1", "123456"),
      ],
      5,
    );
    expect(
      withOversizedAssistant.map((segment) => segment.sourceMessageIds),
    ).toEqual([["u1", "a1"], ["huge"]]);
    expect(withOversizedAssistant[1]).toMatchObject({
      charCount: 6,
      closed: true,
    });

    const closedByFollowingUser = segmentMessages(
      [user("u1", "123456"), user("u2", "next")],
      5,
    );
    expect(closedByFollowingUser[0]).toMatchObject({
      sourceBoundaryVersion: 2,
      sourceMessageIds: ["u1"],
      closed: true,
    });
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

  it("hydrates V2 source spans exactly while V1 reads whole turns", () => {
    const messages = [
      user("u1", "request"),
      assistant("a1", "u1", "first"),
      assistant("a2", "u1", "second"),
      user("u2", "outside"),
    ];

    expect(readSegmentMessages(messages, v2Boundary("u1", "a1", "a2"))).toEqual(
      [
        { role: "assistant", text: "first" },
        { role: "assistant", text: "second" },
      ],
    );
    expect(readSegmentMessages(messages, v1Boundary("u1", "u1"))).toEqual([
      { role: "user", text: "request" },
      { role: "assistant", text: "first" },
      { role: "assistant", text: "second" },
    ]);
    expect(() =>
      readSegmentMessages(messages, v2Boundary("u1", "missing", "a2")),
    ).toThrow("not found");
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
