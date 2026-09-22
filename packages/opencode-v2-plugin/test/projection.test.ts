import {
  Message,
  ToolCallPart,
  ToolResultPart,
  TextPart,
  MediaPart,
  ReasoningPart,
} from "@opencode/ai";
import { expect, it } from "vitest";
import {
  materialize,
  estimationValue,
  checkpoint,
  estimateMessages,
  materializedTokens,
  NOTICE_PREFIX,
  ANCHOR_HEADER,
  ANCHOR_FOOTER,
} from "../src/projection.js";
import {
  estimateNativeTokens,
  type NativeProjectionResult,
} from "@reflection/opencode-v2-core/projection";
const plan: NativeProjectionResult = {
  tailStartIndex: 2,
  preservedPrefixIndices: [0],
  notice: { id: "notice", text: "summary", anchorMessageIndex: 1 },
  estimatedTokens: 100,
  reset: true,
  lossy: false,
  omissions: [],
};
it("materializes prefix original refs, latest user content verbatim including media, and unchanged tail", () => {
  const media = {
    type: "media" as const,
    mediaType: "image/png",
    data: new Uint8Array([1, 2, 3]),
  };
  const messages = [
    Message.system("pinned"),
    Message.user([{ type: "text", text: "actual user" }, media]),
    Message.assistant("tail"),
  ];
  const result = materialize(plan, messages);
  expect(result[0]).toBe(messages[0]);
  expect(result[2]).toBe(messages[2]);
  // SDK Message.make validates and clones parts; content must remain verbatim,
  // while the preserved prefix and raw tail retain their original references.
  expect(result[1]?.content).toContainEqual(messages[1]!.content[0]);
  expect(result[1]?.content).toContainEqual(messages[1]!.content[1]);
  expect(result.filter((message) => message === messages[1])).toHaveLength(0);
});
it("does not duplicate latest user when it remains in raw tail", () => {
  const messages = [Message.assistant("old"), Message.user("latest")];
  const result = materialize(
    {
      ...plan,
      tailStartIndex: 1,
      preservedPrefixIndices: [],
      notice: { id: "notice", text: "summary" },
    },
    messages,
  );
  expect(result[1]).toBe(messages[1]);
  expect(result[0]?.content).toHaveLength(1);
});
it.each([true, false])(
  "materialized token budget counts exact notice wrappers and original anchor (anchor=%s)",
  (anchor) => {
    const messages = [
      Message.system("pinned"),
      Message.user("actual user"),
      Message.assistant("tail"),
    ];
    const system = [{ type: "text", text: "system instructions" }];
    const tools = {
      memory_search: { description: "Search", input: { type: "object" } },
    };
    const summary = "Verified cached summary";
    const output = materialize(
      {
        ...plan,
        notice: {
          id: "notice",
          text: summary,
          ...(anchor ? { anchorMessageIndex: 1 } : {}),
        },
      },
      messages,
    );
    const noticeContent = [
      { type: "text", text: NOTICE_PREFIX + summary },
      ...(anchor
        ? [
            { type: "text", text: ANCHOR_HEADER },
            ...messages[1]!.content,
            { type: "text", text: ANCHOR_FOOTER },
          ]
        : []),
    ];
    const expected =
      estimateNativeTokens(system) +
      estimateNativeTokens(tools) +
      8 +
      estimateNativeTokens({ role: "system", content: messages[0]!.content }) +
      8 +
      estimateNativeTokens({ role: "user", content: noticeContent }) +
      8 +
      estimateNativeTokens({
        role: "assistant",
        content: messages[2]!.content,
      });
    expect(output[1]!.content).toEqual(noticeContent);
    expect(materializedTokens(output, system, tools)).toBe(expected);
  },
);
it("budgets binary images without mutating them and rejects opaque/non-image content", () => {
  const data = new Uint8Array([1, 2]);
  const media = { type: "media", mediaType: "image/png", data };
  expect(estimationValue(media)).toHaveProperty("type", "image");
  expect(media.data).toBe(data);
  expect(() =>
    estimationValue({ type: "file", mime: "video/mp4", uri: "x" }),
  ).toThrow("non-image");
  expect(() => estimationValue({ type: "compaction", text: "old" })).toThrow(
    "checkpoint",
  );
  expect(checkpoint({ version: 1 }, "source", "session")).toBeUndefined();
});
it("estimates actual SDK-produced tool/text/media content and preserves the original messages", () => {
  const call = ToolCallPart.make({
    id: "call",
    name: "memory_search",
    input: { query: "remember" },
  });
  const result = ToolResultPart.make({
    id: "call",
    name: "memory_search",
    result: "found",
    resultType: "text",
  });
  const text = TextPart.make({ type: "text", text: "latest" });
  const media = MediaPart.make({
    type: "media",
    mediaType: "image/png",
    data: new Uint8Array([1, 2, 3]),
  });
  const messages = [
    Message.assistant([call]),
    Message.tool(result),
    Message.user([text, media]),
  ];
  const estimated = estimateMessages(messages);
  expect(estimated[0]!.content).toEqual([call]);
  expect(estimated[1]!.content).toEqual([result]);
  expect(estimated[2]!.content).toEqual([
    text,
    expect.objectContaining({ type: "image" }),
  ]);
  expect(materializedTokens(messages, [], {})).toBeGreaterThan(16000);
  const output = materialize(
    {
      ...plan,
      notice: undefined,
      preservedPrefixIndices: [],
      tailStartIndex: 0,
    },
    messages,
  );
  output.forEach((message, index) => expect(message).toBe(messages[index]));
  expect(messages[2]!.content[1]).toEqual(media);
});
it("normalizes supported SDK data shapes across foreign class prototypes without invoking methods", () => {
  const call = ToolCallPart.make({
    id: "call",
    name: "tool",
    input: { query: "q" },
  });
  const result = ToolResultPart.make({
    id: "call",
    name: "tool",
    result: "done",
    resultType: "text",
  });
  const media = MediaPart.make({
    type: "media",
    mediaType: "image/png",
    data: new Uint8Array([1]),
  });
  // Host and bundle may have different schema prototypes. Reuse SDK-produced
  // fields and exercise the non-plain representation separately from .make.
  const prototype = {
    toJSON() {
      throw new Error("must not execute");
    },
  };
  for (const part of [call, result, media])
    Object.setPrototypeOf(part, prototype);
  Object.setPrototypeOf(result.result, prototype);
  expect(estimationValue(call)).toEqual({
    type: "tool-call",
    id: "call",
    name: "tool",
    input: { query: "q" },
  });
  expect(estimationValue(result)).toHaveProperty("result", {
    type: "text",
    value: "done",
  });
  expect(estimationValue(media)).toHaveProperty("type", "image");
});
it("rejects accessors, cycles, functions, and unhandled binary without evaluating getters", () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, "type", {
    get() {
      reads++;
      return "text";
    },
  });
  const array = Object.defineProperty(["text"], "0", {
    get() {
      reads++;
      return "text";
    },
  });
  expect(() => estimationValue(accessor)).toThrow("accessor");
  expect(() => estimationValue(array)).toThrow("accessor");
  expect(reads).toBe(0);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const opaque of [
    cycle,
    new Map(),
    new Set(),
    () => {},
    { value: () => {} },
    new Uint8Array([1]),
    Object.create({ hidden: true }),
  ]) {
    expect(() => estimationValue(opaque)).toThrow();
  }
});
it.each([{}, { provider: { encrypted: new Uint8Array([1, 2]) } }])(
  "rejects real SDK messages with any top-level native payload",
  (native) => {
    const message = Message.make({
      role: "assistant",
      content: "ordinary text",
      native,
    });
    expect(() => estimateMessages([message])).toThrow(
      "opaque provider-native message payload is unsupported",
    );
    expect(() => materializedTokens([message], [], {})).toThrow(
      "before dispatch",
    );
  },
);
it("counts large top-level provider metadata through an estimation-only content descriptor", () => {
  const providerMetadata = {
    provider: { serializedState: "x".repeat(120000), flags: ["a", "b"] },
  };
  const message = Message.make({
    role: "assistant",
    content: "answer",
    providerMetadata,
  });
  const baseline = Message.assistant("answer");
  const expectedContent = [
    ...message.content,
    { type: "reflection-provider-metadata", providerMetadata },
  ];
  expect(estimateMessages([message])[0]!.content).toEqual(expectedContent);
  expect(materializedTokens([message], [], {})).toBe(
    estimateNativeTokens([]) +
      estimateNativeTokens({}) +
      8 +
      estimateNativeTokens({ role: "assistant", content: expectedContent }),
  );
  expect(
    materializedTokens([message], [], {}) -
      materializedTokens([baseline], [], {}),
  ).toBeGreaterThanOrEqual(40000);
  expect(message.content).toEqual(baseline.content);
  expect(message.providerMetadata).toEqual(providerMetadata);
});
it("restores anchor provider metadata without host metadata and preserves raw tail references and fields", () => {
  const user = Message.make({
    role: "user",
    content: [
      TextPart.make({
        type: "text",
        text: "actual user",
        providerMetadata: { provider: { partFlag: true } },
      }),
    ],
    providerMetadata: { provider: { messageFlag: "retain", state: [1, 2] } },
    metadata: { hostOnly: new Map([["internal", "not provider-visible"]]) },
  });
  const tail = Message.make({
    role: "assistant",
    content: [
      ReasoningPart.make({
        type: "reasoning",
        text: "reasoning",
        encrypted: "signed-state",
      }),
    ],
    providerMetadata: { provider: { tailFlag: true } },
  });
  const originalProviderMetadata = user.providerMetadata;
  const originalHostMetadata = user.metadata;
  const messages = [Message.system("pinned"), user, tail];
  const output = materialize(plan, messages);
  expect(output[0]).toBe(messages[0]);
  expect(output[2]).toBe(tail);
  expect(output[2]!.providerMetadata).toBe(tail.providerMetadata);
  expect(output[2]!.content).toBe(tail.content);
  expect(output[1]!.providerMetadata).toEqual(originalProviderMetadata);
  expect(output[1]!.metadata).toBeUndefined();
  expect(output[1]!.content).toContainEqual(user.content[0]);
  expect(user.providerMetadata).toBe(originalProviderMetadata);
  expect(user.metadata).toBe(originalHostMetadata);
  expect(JSON.stringify(output[1]!.content)).not.toContain(
    "reflection-provider-metadata",
  );
  expect(materializedTokens(output, [], {})).toBeGreaterThan(0);
  const noAnchor = materialize(
    {
      ...plan,
      notice: { id: "notice", text: "summary" },
      preservedPrefixIndices: [],
      tailStartIndex: 1,
    },
    messages,
  );
  expect(noAnchor[0]!.providerMetadata).toBeUndefined();
  expect(noAnchor[1]).toBe(user);
});
it("does not budget host-only message metadata", () => {
  const message = Message.make({
    role: "user",
    content: "input",
    metadata: { hostState: new Map(), large: "x".repeat(120000) },
  });
  expect(estimateMessages([message])).toEqual(
    estimateMessages([Message.user("input")]),
  );
});
it.each([new Uint8Array([1, 2]), new Map(), () => {}])(
  "rejects unsupported values in real SDK providerMetadata",
  (value) => {
    const message = Message.make({
      role: "assistant",
      content: "text",
      providerMetadata: { provider: { payload: value } },
    });
    expect(() => estimateMessages([message])).toThrow("opaque model payload");
  },
);
