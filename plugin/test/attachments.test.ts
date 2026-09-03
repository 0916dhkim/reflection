import { describe, expect, it } from "vitest";

import {
  stripStaleToolAttachments,
  DEFAULT_ATTACHMENT_LAG_TURNS,
} from "../src/attachments.js";
import type { OpenCodeMessage } from "@reflection/shared/segmentation";

const SESSION_ID = "session";

function user(id: string, text = "request"): OpenCodeMessage {
  return {
    info: { id, sessionID: SESSION_ID, role: "user", agent: "build" },
    parts: [{ type: "text", text }],
  } as OpenCodeMessage;
}

function image(filename = "shot.png") {
  return {
    type: "file",
    mime: "image/png",
    filename,
    url: `data:image/png;base64,${"A".repeat(2_000)}`,
  };
}

function assistantWithAttachment(
  id: string,
  parentID: string,
  output = "read 1 file",
  attachments: unknown[] = [image()],
): OpenCodeMessage {
  return {
    info: {
      id,
      sessionID: SESSION_ID,
      role: "assistant",
      parentID,
      providerID: "provider",
      modelID: "model",
      time: { created: 0, completed: 1 },
      finish: "stop",
    },
    parts: [
      {
        type: "tool",
        tool: "read",
        callID: `call-${id}`,
        state: { status: "completed", input: {}, output, attachments },
      },
    ],
  } as unknown as OpenCodeMessage;
}

function attachmentsAt(messages: readonly OpenCodeMessage[], index: number) {
  const part = messages[index]?.parts[0] as { state?: { attachments?: [] } };
  return part.state?.attachments ?? [];
}

function outputAt(messages: readonly OpenCodeMessage[], index: number) {
  const part = messages[index]?.parts[0] as { state?: { output?: string } };
  return part.state?.output ?? "";
}

describe("stripStaleToolAttachments", () => {
  it("keeps attachments for the newest turn and strips older ones", () => {
    const messages = [
      user("u0"),
      assistantWithAttachment("a0", "u0"),
      user("u1"),
      assistantWithAttachment("a1", "u1"),
    ];

    const result = stripStaleToolAttachments(messages);

    expect(attachmentsAt(result, 1)).toHaveLength(0);
    expect(attachmentsAt(result, 3)).toHaveLength(1);
  });

  it("names the omitted attachment ahead of the tool output", () => {
    const messages = [
      user("u0"),
      assistantWithAttachment("a0", "u0", "read 1 file", [
        image("diagram.png"),
      ]),
      user("u1"),
    ];

    const output = outputAt(stripStaleToolAttachments(messages), 1);

    expect(output).toContain("image/png: diagram.png");
    expect(output).toContain("re-run the tool");
    expect(output.endsWith("read 1 file")).toBe(true);
  });

  it("does not mutate the caller's messages or parts", () => {
    const messages = [
      user("u0"),
      assistantWithAttachment("a0", "u0"),
      user("u1"),
    ];
    const original = structuredClone(messages);

    stripStaleToolAttachments(messages);

    expect(messages).toEqual(original);
  });

  it("returns the same array when nothing needs stripping", () => {
    const messages = [user("u0"), assistantWithAttachment("a0", "u0")];

    expect(stripStaleToolAttachments(messages)).toBe(messages);
  });

  it("keeps every attachment while the session is within the lag", () => {
    const messages = [user("u0"), assistantWithAttachment("a0", "u0")];

    expect(attachmentsAt(stripStaleToolAttachments(messages), 1)).toHaveLength(
      1,
    );
  });

  it("honours a wider lag", () => {
    const messages = [
      user("u0"),
      assistantWithAttachment("a0", "u0"),
      user("u1"),
      assistantWithAttachment("a1", "u1"),
      user("u2"),
      assistantWithAttachment("a2", "u2"),
    ];

    const result = stripStaleToolAttachments(messages, 2);

    expect(attachmentsAt(result, 1)).toHaveLength(0);
    expect(attachmentsAt(result, 3)).toHaveLength(1);
    expect(attachmentsAt(result, 5)).toHaveLength(1);
  });

  it("leaves user file parts untouched", () => {
    const upload = {
      info: { id: "u0", sessionID: SESSION_ID, role: "user", agent: "build" },
      parts: [image("pasted.png")],
    } as unknown as OpenCodeMessage;
    const messages = [upload, user("u1")];

    const result = stripStaleToolAttachments(messages);

    expect(result).toBe(messages);
    expect(result[0]?.parts).toHaveLength(1);
  });

  it("preserves non-string tool output", () => {
    const messages = [
      user("u0"),
      assistantWithAttachment("a0", "u0", {
        text: "structured",
      } as unknown as string),
      user("u1"),
    ];

    const part = stripStaleToolAttachments(messages)[1]?.parts[0] as {
      state: { output: unknown; attachments: [] };
    };

    expect(part.state.output).toEqual({ text: "structured" });
    expect(part.state.attachments).toHaveLength(0);
  });

  it("rejects a negative lag", () => {
    expect(() => stripStaleToolAttachments([], -1)).toThrow(
      "non-negative integer",
    );
  });

  it("defaults to a one turn lag", () => {
    expect(DEFAULT_ATTACHMENT_LAG_TURNS).toBe(1);
  });
});
