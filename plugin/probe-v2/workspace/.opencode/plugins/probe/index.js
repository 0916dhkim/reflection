import { appendFileSync } from "node:fs";
const eventsPath = "/state/events.jsonl";
const serverURL = process.env.PROBE_SERVER_URL;
const password = process.env.PROBE_SERVER_PASSWORD;
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

function append(kind, value) {
  appendFileSync(
    eventsPath,
    `${JSON.stringify({ at: new Date().toISOString(), kind, ...value })}\n`,
  );
}

function includesAbort(value) {
  return JSON.stringify(value).includes("CP002_ABORT");
}

async function fullHistory(sessionID) {
  const messages = [];
  const seenCursors = new Set();
  let cursor;
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ limit: "7" });
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw new Error("CP002 repeated history cursor");
      }
      seenCursors.add(cursor);
      query.set("cursor", cursor);
    } else {
      query.set("order", "asc");
    }
    const response = await fetch(
      `${serverURL}/api/session/${encodeURIComponent(sessionID)}/message?${query}`,
      {
        headers: { authorization: auth },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      throw new Error(`CP002 history fetch failed: ${response.status}`);
    }
    const body = await response.json();
    if (!Array.isArray(body.data) || !body.cursor || !("next" in body.cursor)) {
      throw new Error("CP002 history response shape invalid");
    }
    messages.push(...body.data);
    cursor = body.cursor.next;
    if (cursor == null) {
      return messages;
    }
    if (typeof cursor !== "string") {
      throw new Error("CP002 history cursor invalid");
    }
  }
  throw new Error("CP002 history pagination exceeded 100 pages");
}

export default {
  id: "reflection.cp002.probe",
  async setup(ctx) {
    append("setup", {
      appLocation: process.execPath,
      versions: process.versions,
    });

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "probe_echo",
        description: "Return the CP-002 fixture tool result.",
        input: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          append("tool.execute", {
            input,
            sessionID: context.sessionID,
          });
          return { content: "CP002_TOOL_RESULT" };
        },
      });
    });

    await ctx.session.hook("title", (event) => {
      event.result = "CP002 fixture";
    });

    await ctx.session.hook("context", async (event) => {
      if (includesAbort(event.messages)) {
        append("context.abort", {
          sessionID: event.sessionID,
          messages: event.messages,
        });
        throw new Error("CP002_ABORT rejected before provider dispatch");
      }

      event.system.push({ type: "text", text: "CP002_CONTEXT_MARKER" });
      if (JSON.stringify(event.messages).includes("CP002_CANCEL")) {
        append("context.cancel.wait", { sessionID: event.sessionID });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        append("context.cancel.delay.complete", { sessionID: event.sessionID });
      }
      const history = await fullHistory(event.sessionID);
      const activeContext = await ctx.session.context({
        sessionID: event.sessionID,
      });
      append("context", {
        sessionID: event.sessionID,
        model: event.model,
        messages: event.messages,
        history,
        activeContext,
        system: event.system,
      });
    });
  },
};
