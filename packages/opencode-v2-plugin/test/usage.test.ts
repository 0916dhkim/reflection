import { Message, ToolCallPart, ToolResultPart } from "@opencode/ai";
import { canonicalizeNativeHistory } from "@reflection/opencode-v2-core/history";
import { estimateNativeTokens } from "@reflection/opencode-v2-core/projection";
import { describe, expect, it } from "vitest";
import { UsageTracker } from "../src/usage.js";

const model = { id: "test", providerID: "openai" };
const system = ["instructions"];
const tools = { search: { description: "lookup" } };
const options = { temperature: 0.4 };
const tokens = {
  input: 100_000,
  output: 2_000,
  reasoning: 3_000,
  cache: { read: 10_000, write: 5_000 },
};
const user = Message.make({ id: "u", role: "user", content: "ask" });
const answer = Message.make({
  id: "a",
  role: "assistant",
  content: "answer",
});
const raw = (usage: unknown = tokens, extra: Record<string, unknown> = {}) => ({
  id: "a",
  type: "assistant",
  time: { created: 2, completed: 3 },
  agent: "build",
  model,
  content: [{ type: "text", text: "answer" }],
  tokens: usage,
  ...extra,
});
const history = (assistant: unknown = raw()) =>
  canonicalizeNativeHistory([
    { id: "u", type: "user", text: "ask", time: { created: 1 } },
    assistant,
  ]);
const prepare = (
  tracker: UsageTracker,
  records = history(),
  overrides: {
    model?: typeof model;
    system?: unknown;
    tools?: unknown;
    options?: unknown;
  } = {},
) =>
  tracker.prepare(
    "s",
    records,
    overrides.model ?? model,
    overrides.system ?? system,
    overrides.tools ?? tools,
    overrides.options ?? options,
  );

describe("provider usage continuity", () => {
  it("sums normalized cache and reasoning once, adds only new user/tool content, and permits tool-only continuation", () => {
    const tracker = new UsageTracker();
    prepare(tracker, history().slice(0, 1)).remember([user]);
    const step = prepare(tracker);
    const tool = Message.tool(
      ToolResultPart.make({
        id: "call",
        name: "search",
        result: "found",
        resultType: "text",
      }),
    );
    const next = Message.make({
      id: "next",
      role: "user",
      content: "continue",
    });
    expect(step.estimate([user, answer])).toBe(120_000);
    const cost = (message: Message) =>
      8 +
      estimateNativeTokens({ role: message.role, content: message.content });
    expect(step.estimate([user, answer, tool, next])).toBe(
      120_000 + cost(tool) + cost(next),
    );
    step.remember([user, answer, tool]);
    expect(prepare(tracker).estimate([user, answer, tool])).toBe(
      120_000 + cost(tool),
    );
    expect(prepare(tracker).estimate([user, answer, tool, next])).toBe(
      120_000 + cost(tool) + cost(next),
    );
    expect(prepare(tracker).estimate([user, answer, next])).toBeUndefined();
  });

  it("counts tool results emitted by an anchor but not its encrypted content or tool-call arguments", () => {
    const tracker = new UsageTracker();
    prepare(tracker, history().slice(0, 1)).remember([user]);
    const input = { query: "x".repeat(300_000) };
    const reasoningState = {
      itemId: "rs_1",
      reasoningEncryptedContent: "x".repeat(400_000),
    };
    const providerState = { itemId: "fc_1" };
    const records = history(
      raw(tokens, {
        content: [
          { type: "reasoning", text: "", state: reasoningState },
          {
            type: "tool",
            id: "call",
            name: "search",
            providerState,
            time: { created: 2, completed: 3 },
            state: {
              status: "completed",
              input,
              content: [{ type: "text", text: "found" }],
            },
          },
        ],
      }),
    );
    const call = Message.make({
      id: "a",
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "",
          providerMetadata: { openai: reasoningState },
        },
        ToolCallPart.make({
          id: "call",
          name: "search",
          input,
          providerMetadata: { openai: providerState },
        }),
      ],
    });
    const result = Message.tool(
      ToolResultPart.make({
        id: "call",
        name: "search",
        result: "found",
        resultType: "text",
        providerMetadata: { openai: providerState },
      }),
    );
    expect(prepare(tracker, records).estimate([user, call, result])).toBe(
      120_000 +
        8 +
        estimateNativeTokens({ role: result.role, content: result.content }),
    );
    for (const replacement of [
      { id: "other" },
      { name: "other" },
      { input: { query: `${input.query}expanded` } },
      { providerMetadata: { openai: { itemId: "changed" } } },
      { providerExecuted: true },
    ]) {
      const changed = Message.make({
        id: "a",
        role: "assistant",
        content: [
          call.content[0]!,
          ToolCallPart.make({
            id: "call",
            name: "search",
            input,
            providerMetadata: { openai: providerState },
            ...replacement,
          }),
        ],
      });
      expect(
        prepare(tracker, records).estimate([user, changed, result]),
      ).toBeUndefined();
    }
  });

  it("rejects expanded first assistants before anchoring even with unchanged identity and prefix", () => {
    const tracker = new UsageTracker();
    prepare(tracker, history().slice(0, 1)).remember([user]);
    const expanded = Message.make({
      id: "a",
      role: "assistant",
      content: "answer".repeat(50_000),
    });
    const step = prepare(tracker);
    expect(step.estimate([user, expanded])).toBeUndefined();
    step.remember([user, expanded]);
    expect(prepare(tracker).estimate([user, expanded])).toBeUndefined();
  });

  it.each(["text", "reasoning"] as const)(
    "matches %s provider state and rejects transformed or unknown payloads",
    (type) => {
      const tracker = new UsageTracker();
      prepare(tracker, history().slice(0, 1)).remember([user]);
      const reasoningState = {
        itemId: "rs_1",
        reasoningEncryptedContent: "x".repeat(400_000),
      };
      const content = [
        {
          type,
          text: "generated",
          providerMetadata: { openai: reasoningState },
        },
      ];
      const records = history(
        raw(tokens, {
          content: [{ type, text: "generated", state: reasoningState }],
        }),
      );
      const rendered = Message.make({ id: "a", role: "assistant", content });
      expect(prepare(tracker, records).estimate([user, rendered])).toBe(
        120_000,
      );
      for (const part of [
        { ...content[0]!, text: "expanded".repeat(50_000) },
        {
          ...content[0]!,
          providerMetadata: {
            openai: { ...reasoningState, reasoningEncryptedContent: "changed" },
          },
        },
        { ...content[0]!, providerMetadata: undefined },
        { ...content[0]!, providerMetadata: { unknown: reasoningState } },
        { ...content[0]!, metadata: { unknown: "unmapped" } },
        { ...content[0]!, type: "reasoning" as const, encrypted: "unmapped" },
      ]) {
        expect(
          prepare(tracker, records).estimate([
            user,
            Message.make({ id: "a", role: "assistant", content: [part] }),
          ]),
        ).toBeUndefined();
      }
      for (const extra of [
        { providerMetadata: { openai: reasoningState } },
        { native: { opaque: "extra" } },
        { metadata: { extra: "unmapped" } },
      ]) {
        expect(
          prepare(tracker, records).estimate([
            user,
            Message.make({ id: "a", role: "assistant", content, ...extra }),
          ]),
        ).toBeUndefined();
      }
    },
  );

  it.each(["completed", "error"])(
    "matches provider-executed %s tool calls and embedded results",
    (status) => {
      const tracker = new UsageTracker();
      prepare(tracker, history().slice(0, 1)).remember([user]);
      const input = { query: "lookup" };
      const providerState = { itemId: "hosted_1" };
      const providerResultState = { output: "opaque provider result" };
      const content = [{ type: "text", text: "found" }];
      const error = { type: "tool", message: "failed" };
      const records = history(
        raw(tokens, {
          content: [
            {
              type: "tool",
              id: "call",
              name: "search",
              executed: true,
              providerState,
              providerResultState,
              time: { created: 2, completed: 3 },
              state: {
                status,
                input,
                content,
                ...(status === "error" ? { error } : {}),
              },
            },
          ],
        }),
      );
      const call = ToolCallPart.make({
        id: "call",
        name: "search",
        input,
        providerExecuted: true,
        providerMetadata: { openai: providerState },
      });
      const result = ToolResultPart.make({
        id: "call",
        name: "search",
        providerExecuted: true,
        providerMetadata: { openai: providerResultState },
        result:
          status === "completed"
            ? { type: "text", value: "found" }
            : { error, content },
        resultType: status === "error" ? "error" : "text",
      });
      expect(
        prepare(tracker, records).estimate([
          user,
          Message.make({ id: "a", role: "assistant", content: [call, result] }),
        ]),
      ).toBe(120_000);
      expect(
        prepare(tracker, records).estimate([
          user,
          Message.make({
            id: "a",
            role: "assistant",
            content: [
              call,
              {
                ...result,
                providerMetadata: { openai: { output: "changed" } },
              },
            ],
          }),
        ]),
      ).toBeUndefined();
    },
  );

  it.each([
    undefined,
    {},
    { ...tokens, input: 0, cache: { read: 0, write: 0 } },
    { ...tokens, input: -1 },
    { ...tokens, output: Infinity },
    { ...tokens, cache: { read: NaN, write: 0 } },
    { ...tokens, reasoning: -1 },
  ])("rejects malformed or missing normalized usage %j", (value) => {
    const tracker = new UsageTracker();
    prepare(tracker, history().slice(0, 1)).remember([user]);
    expect(
      prepare(tracker, history(raw(tokens, { tokens: value }))).estimate([
        user,
        answer,
      ]),
    ).toBeUndefined();
  });

  it("rejects errors, unfinished assistants, raw model changes and stale duplicate identities", () => {
    const tracker = new UsageTracker();
    prepare(tracker, history().slice(0, 1)).remember([user]);
    expect(
      prepare(
        tracker,
        history(
          raw(tokens, { error: { type: "provider", message: "failed" } }),
        ),
      ).estimate([user, answer]),
    ).toBeUndefined();
    expect(
      prepare(tracker, history(raw(tokens, { time: { created: 2 } }))).estimate(
        [user, answer],
      ),
    ).toBeUndefined();
    expect(
      prepare(
        tracker,
        history(raw(tokens, { model: { id: "other", providerID: "openai" } })),
      ).estimate([user, answer]),
    ).toBeUndefined();
    expect(prepare(tracker).estimate([user, answer, answer])).toBeUndefined();
    expect(prepare(tracker).estimate([answer, user])).toBeUndefined();
  });

  it("accepts fully cached input and distinguishes differently nested configuration", () => {
    const tracker = new UsageTracker();
    prepare(tracker, history().slice(0, 1), {
      tools: { a: { b: 1 }, c: 2 },
    }).remember([user]);
    const records = history(raw({ ...tokens, input: 0 }));
    expect(
      prepare(tracker, records, { tools: { a: { b: 1 }, c: 2 } }).estimate([
        user,
        answer,
      ]),
    ).toBe(20_000);
    expect(
      prepare(tracker, records, { tools: { a: { b: 1, c: 2 } } }).estimate([
        user,
        answer,
      ]),
    ).toBeUndefined();
  });

  it("compares actual media bytes, not just equal-size estimation placeholders", () => {
    const tracker = new UsageTracker();
    const image = (bytes: number[]) =>
      Message.make({
        id: "image",
        role: "user",
        content: [
          {
            type: "media",
            mediaType: "image/png",
            data: new Uint8Array(bytes),
          },
        ],
      });
    prepare(tracker, history().slice(0, 1)).remember([image([1, 2, 3])]);
    expect(
      prepare(tracker).estimate([image([1, 2, 4]), answer]),
    ).toBeUndefined();
    expect(prepare(tracker).estimate([image([1, 2, 3]), answer])).toBe(120_000);
  });

  it("invalidates changes to model, system, tools, options, prefix, assistant, and reverted content", () => {
    const tracker = new UsageTracker();
    prepare(tracker, history().slice(0, 1)).remember([user]);
    for (const changed of [
      { model: { ...model, id: "other" } },
      { system: ["changed"] },
      { tools: { search: "changed" } },
      { options: { temperature: 0.9 } },
    ])
      expect(
        prepare(tracker, history(), changed).estimate([user, answer]),
      ).toBeUndefined();
    expect(
      prepare(tracker).estimate([
        Message.make({ id: "u", role: "user", content: "changed" }),
        answer,
      ]),
    ).toBeUndefined();
    const step = prepare(tracker);
    step.remember([user, answer]);
    expect(
      prepare(
        tracker,
        history(raw(tokens, { time: { created: 2, completed: 4 } })),
      ).estimate([user, answer]),
    ).toBeUndefined();
    expect(
      prepare(tracker).estimate([
        user,
        Message.make({ id: "a", role: "assistant", content: "changed" }),
      ]),
    ).toBeUndefined();
    const result = Message.user("next");
    prepare(tracker).remember([user, answer, result]);
    expect(prepare(tracker).estimate([user, answer])).toBeUndefined();
  });

  it("falls back after changed projection then reanchors on its next response", () => {
    const tracker = new UsageTracker();
    prepare(tracker, history().slice(0, 1)).remember([user]);
    const notice = Message.make({
      id: "notice",
      role: "user",
      content: "new summary",
    });
    const changed = prepare(tracker);
    expect(changed.estimate([notice, answer])).toBeUndefined();
    changed.remember([notice, answer]);
    const later = Message.make({
      id: "b",
      role: "assistant",
      content: "next answer",
    });
    const records = canonicalizeNativeHistory([
      ...history().map((record) => record.raw),
      {
        ...raw(tokens, { content: [{ type: "text", text: "next answer" }] }),
        id: "b",
        time: { created: 4, completed: 5 },
      },
    ]);
    expect(prepare(tracker, records).estimate([notice, answer, later])).toBe(
      120_000,
    );
  });

  it("evicts old sessions, deletes sessions and clears on disposal", () => {
    const tracker = new UsageTracker(1);
    prepare(tracker, history().slice(0, 1)).remember([user]);
    tracker.prepare("another", [], model, system, tools, options).remember([]);
    expect(prepare(tracker).estimate([user, answer])).toBeUndefined();
    prepare(tracker, history().slice(0, 1)).remember([user]);
    tracker.delete("s");
    expect(prepare(tracker).estimate([user, answer])).toBeUndefined();
    prepare(tracker, history().slice(0, 1)).remember([user]);
    tracker.clear();
    expect(prepare(tracker).estimate([user, answer])).toBeUndefined();
  });
});
