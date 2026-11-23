import { Message } from "@opencode/ai";
import { describe, expect, it } from "vitest";
import {
  OMITTED_TURN_STUB,
  applyOmittedTurns,
  detectRejectedTurnIds,
  isRejectingRequestError,
} from "../src/quarantine.js";

const user = (id: string, text = id) =>
  Message.make({ id, role: "user", content: text });
const reply = (id: string, text = "answer") =>
  Message.make({ id, role: "assistant", content: text });
const call = (id: string, callId: string, name = "read") =>
  Message.make({
    id,
    role: "assistant",
    content: [{ type: "tool-call", id: callId, name, input: { path: "/img" } }],
  });
const toolResult = (callId: string, output = "ok", name = "read") =>
  Message.tool({ id: callId, name, result: output });

const rawUser = (id: string, text = id) => ({
  id,
  type: "user",
  text,
  time: { created: 1 },
});
const rawReply = (id: string, text = "answer") => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "m", providerID: "p" },
  time: { created: 1, completed: 2 },
  content: [{ type: "text", text }],
});
const rawToolAssistant = (id: string, callId = "c1") => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "m", providerID: "p" },
  time: { created: 1, completed: 2 },
  content: [
    {
      type: "tool",
      id: callId,
      name: "read",
      time: { created: 1 },
      state: {
        status: "completed",
        input: { path: "/img.png" },
        content: [
          {
            type: "file",
            uri: "data:image/png;base64,AA==",
            mime: "image/png",
          },
        ],
      },
    },
  ],
});
const rawFailed = (
  id: string,
  error: { type: string; message?: string; status?: number },
  content: unknown[] = [],
) => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "m", providerID: "p" },
  time: { created: 1, completed: 2 },
  content,
  finish: "error",
  error: { message: "failed", ...error },
});

describe("isRejectingRequestError", () => {
  it("matches deterministic content/format/size rejections", () => {
    expect(
      isRejectingRequestError({
        type: "provider.invalid-request",
        status: 413,
      }),
    ).toBe(true);
    expect(
      isRejectingRequestError({
        type: "provider.invalid-request",
        status: 400,
      }),
    ).toBe(true);
    expect(
      isRejectingRequestError({
        type: "provider.invalid-request",
        status: 422,
      }),
    ).toBe(true);
    expect(
      isRejectingRequestError({
        type: "provider.invalid-request",
        message: "OpenAI Chat does not support media type application/pdf",
      }),
    ).toBe(true);
    expect(isRejectingRequestError({ type: "provider.content-filter" })).toBe(
      true,
    );
  });

  it("ignores transient, auth, routing 404, rate-limit, and abort errors", () => {
    expect(
      isRejectingRequestError({
        type: "provider.invalid-request",
        status: 404,
      }),
    ).toBe(false);
    expect(
      isRejectingRequestError({
        type: "provider.invalid-request",
        status: 401,
      }),
    ).toBe(false);
    expect(
      isRejectingRequestError({
        type: "provider.invalid-request",
        status: 403,
      }),
    ).toBe(false);
    expect(
      isRejectingRequestError({
        type: "provider.invalid-request",
        status: 408,
      }),
    ).toBe(false);
    expect(
      isRejectingRequestError({
        type: "provider.invalid-request",
        status: 429,
      }),
    ).toBe(false);
    expect(
      isRejectingRequestError({ type: "provider.auth", status: 401 }),
    ).toBe(false);
    expect(
      isRejectingRequestError({ type: "provider.rate-limit", status: 429 }),
    ).toBe(false);
    expect(
      isRejectingRequestError({ type: "provider.internal", status: 500 }),
    ).toBe(false);
    expect(isRejectingRequestError({ type: "provider.transport" })).toBe(false);
    expect(
      isRejectingRequestError({
        type: "provider",
        message: "WebSocket closed",
      }),
    ).toBe(false);
    expect(isRejectingRequestError({ type: "aborted" })).toBe(false);
    expect(isRejectingRequestError(null)).toBe(false);
    expect(isRejectingRequestError(undefined)).toBe(false);
  });
});

describe("detectRejectedTurnIds & applyOmittedTurns", () => {
  it("replaces a rejected tool-call turn and drops its local tool results atomically", () => {
    const messages = [
      user("u1"),
      reply("a1"),
      user("u2"),
      call("a2", "c2"),
      toolResult("c2", "huge-image"),
      user("u3", "?"),
    ];
    const history = [
      rawUser("u1"),
      rawReply("a1"),
      rawUser("u2"),
      rawToolAssistant("a2", "c2"),
      rawFailed("f1", { type: "provider.invalid-request", status: 413 }),
      rawUser("u3", "?"),
    ];
    const omitted = detectRejectedTurnIds({
      history,
      messages,
      historyAfterId: null,
    });
    expect(omitted).toEqual(["a2"]);

    const projected = applyOmittedTurns(messages, new Set(omitted));
    expect(projected.map((m) => ({ id: m.id, role: m.role }))).toEqual([
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
      { id: "u2", role: "user" },
      { id: "a2", role: "assistant" },
      { id: "u3", role: "user" },
    ]);
    expect(projected[3]!.content).toEqual([
      { type: "text", text: OMITTED_TURN_STUB },
    ]);
  });

  it("keeps earlier accepted tool steps intact in a multi-step agent loop", () => {
    const messages = [
      user("u1"),
      call("a1", "c1"),
      toolResult("c1", "ok1"),
      call("a2", "c2"),
      toolResult("c2", "too-big"),
      user("u2"),
    ];
    const history = [
      rawUser("u1"),
      rawToolAssistant("a1", "c1"),
      rawToolAssistant("a2", "c2"),
      rawFailed("f1", { type: "provider.invalid-request", status: 413 }),
      rawUser("u2"),
    ];
    const omitted = detectRejectedTurnIds({
      history,
      messages,
      historyAfterId: null,
    });
    expect(omitted).toEqual(["a2"]);

    const projected = applyOmittedTurns(messages, new Set(omitted));
    expect(projected.map((m) => ({ id: m.id, role: m.role }))).toEqual([
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
      { id: undefined, role: "tool" },
      { id: "a2", role: "assistant" },
      { id: "u2", role: "user" },
    ]);
  });

  it("replaces only the rejected user message after a normal completed reply", () => {
    const messages = [
      user("u1"),
      reply("a1"),
      user("u_bad", "corrupt"),
      user("u2", "continue"),
    ];
    const history = [
      rawUser("u1"),
      rawReply("a1"),
      rawUser("u_bad", "corrupt"),
      rawFailed("f1", { type: "provider.invalid-request", status: 400 }),
      rawUser("u2", "continue"),
    ];
    const omitted = detectRejectedTurnIds({
      history,
      messages,
      historyAfterId: null,
    });
    expect(omitted).toEqual(["u_bad"]);

    const projected = applyOmittedTurns(messages, new Set(omitted));
    expect(projected[2]!.role).toBe("user");
    expect(projected[2]!.id).toBe("u_bad");
    expect(projected[2]!.content).toEqual([
      { type: "text", text: OMITTED_TURN_STUB },
    ]);
    expect(projected[3]).toBe(messages[3]);
  });

  it("handles a first-turn user failure before any assistant reply", () => {
    const messages = [user("u_bad"), user("u2")];
    const history = [
      rawUser("u_bad"),
      rawFailed("f1", { type: "provider.invalid-request", status: 413 }),
      rawUser("u2"),
    ];
    const omitted = detectRejectedTurnIds({
      history,
      messages,
      historyAfterId: null,
    });
    expect(omitted).toEqual(["u_bad"]);
  });

  it("omits both an unaccepted tool step and a steering user message before the failure", () => {
    const messages = [
      user("u1"),
      call("a1", "c1"),
      toolResult("c1"),
      user("u_steer"),
      user("u2"),
    ];
    const history = [
      rawUser("u1"),
      rawToolAssistant("a1", "c1"),
      rawUser("u_steer"),
      rawFailed("f1", { type: "provider.invalid-request", status: 400 }),
      rawUser("u2"),
    ];
    const omitted = detectRejectedTurnIds({
      history,
      messages,
      historyAfterId: null,
    });
    expect(new Set(omitted)).toEqual(new Set(["a1", "u_steer"]));
  });

  it("handles consecutive rejections across an already-wedged session", () => {
    const messages = [
      user("u1"),
      call("a_e", "c_e"),
      toolResult("c_e", "805kb"),
      user("u_q", "?"),
      user("u_new", "continue"),
    ];
    const history = [
      rawUser("u1"),
      rawToolAssistant("a_e", "c_e"),
      rawFailed("f1", { type: "provider.invalid-request", status: 413 }),
      { id: "idle1", type: "idle", outcome: "failed", time: { created: 2 } },
      rawUser("u_q", "?"),
      rawFailed("f2", { type: "provider.invalid-request", status: 413 }),
      { id: "idle2", type: "idle", outcome: "failed", time: { created: 3 } },
      rawUser("u_new", "continue"),
    ];
    const omitted = detectRejectedTurnIds({
      history,
      messages,
      historyAfterId: null,
    });
    expect(new Set(omitted)).toEqual(new Set(["a_e", "u_q"]));

    const projected = applyOmittedTurns(messages, new Set(omitted));
    expect(projected.map((m) => ({ id: m.id, role: m.role }))).toEqual([
      { id: "u1", role: "user" },
      { id: "a_e", role: "assistant" },
      { id: "u_q", role: "user" },
      { id: "u_new", role: "user" },
    ]);
    expect(projected[3]).toBe(messages[4]);
  });

  it("recovers the preceding turn via historyAfterId when history starts at the failure", () => {
    const messages = [
      user("u1"),
      call("a_e", "c_e"),
      toolResult("c_e"),
      user("u2"),
    ];
    const history = [
      rawFailed("f1", { type: "provider.invalid-request", status: 413 }),
      rawUser("u2"),
    ];
    const omitted = detectRejectedTurnIds({
      history,
      messages,
      historyAfterId: "a_e",
    });
    expect(omitted).toEqual(["a_e"]);
  });

  it("walks past an intervening transient error to find the rejected turn", () => {
    const messages = [user("u1"), reply("a1"), user("u_bad"), user("u2")];
    const history = [
      rawUser("u1"),
      rawReply("a1"),
      rawUser("u_bad"),
      rawFailed("f_transient", { type: "provider.internal", status: 500 }),
      rawFailed("f_reject", { type: "provider.invalid-request", status: 400 }),
      rawUser("u2"),
    ];
    expect(
      detectRejectedTurnIds({ history, messages, historyAfterId: null }),
    ).toEqual(["u_bad"]);
  });

  it("does not omit anything for transient or routing errors", () => {
    const messages = [user("u1"), reply("a1"), user("u2")];
    const history = [
      rawUser("u1"),
      rawReply("a1"),
      user("u2"),
      rawFailed("f1", { type: "provider.invalid-request", status: 404 }),
      rawFailed("f2", { type: "provider.transport" }),
      rawFailed("f3", { type: "aborted" }),
    ];
    const omitted = detectRejectedTurnIds({
      history,
      messages,
      historyAfterId: null,
    });
    expect(omitted).toEqual([]);
    expect(applyOmittedTurns(messages, new Set(omitted))).toBe(messages);
  });

  it("keeps existing omissions sticky and prunes reverted IDs", () => {
    const messages = [
      user("u1"),
      reply("a1"),
      user("u2"),
      reply("a2"),
      user("u3"),
    ];
    const omitted = detectRejectedTurnIds({
      history: [rawUser("u3")],
      messages,
      historyAfterId: "a2",
      existing: ["u1", "reverted_id"],
    });
    expect(omitted).toEqual(["u1"]);
  });

  it("omits a partial failed assistant message if it appears in event messages", () => {
    const messages = [user("u1"), reply("f1", "partial"), user("u2")];
    const history = [
      rawUser("u1"),
      rawFailed("f1", { type: "provider.content-filter" }, [
        { type: "text", text: "partial" },
      ]),
      rawUser("u2"),
    ];
    const omitted = detectRejectedTurnIds({
      history,
      messages,
      historyAfterId: null,
    });
    expect(new Set(omitted)).toEqual(new Set(["u1", "f1"]));
  });

  it("filters only dropped tool results from a mixed tool message", () => {
    const mixedTool = Message.make({
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "c1",
          name: "read",
          result: { type: "text", value: "drop" },
        },
        {
          type: "tool-result",
          id: "c_keep",
          name: "read",
          result: { type: "text", value: "keep" },
        },
      ],
    });
    const messages = [call("a1", "c1"), reply("a_keep"), mixedTool, user("u2")];
    const projected = applyOmittedTurns(messages, new Set(["a1"]));
    expect(projected).toHaveLength(4);
    expect(projected[0]!.content).toEqual([
      { type: "text", text: OMITTED_TURN_STUB },
    ]);
    expect(projected[2]!.role).toBe("tool");
    expect(projected[2]!.content).toHaveLength(1);
    expect((projected[2]!.content[0] as { id: string }).id).toBe("c_keep");
  });
});
