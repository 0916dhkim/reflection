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
  estimationValue,
  estimateMessages,
  materializedTokens,
} from "../src/projection.js";
import { estimateNativeTokens } from "@reflection/opencode-v2-core/projection";
it("counts system, tools, and every message in the request estimate", () => {
  const messages = [Message.user("actual user"), Message.assistant("tail")];
  const system = [{ type: "text", text: "system instructions" }];
  const tools = {
    memory_search: { description: "Search", input: { type: "object" } },
  };
  expect(materializedTokens(messages, system, tools)).toBe(
    estimateNativeTokens(system) +
      estimateNativeTokens(tools) +
      8 +
      estimateNativeTokens({ role: "user", content: messages[0]!.content }) +
      8 +
      estimateNativeTokens({
        role: "assistant",
        content: messages[1]!.content,
      }),
  );
});
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
