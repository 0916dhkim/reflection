import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let root;
const allowed = new Set(["memory_search", "memory_read_segment"]);
const toolResults = [];
const report = {
  setup: false,
  onlyMemoryTools: false,
  search: 0,
  read: 0,
  readExact: 0,
  refused: 0,
  primaryRequests: 0,
};
const save = () =>
  writeFileSync(join(root, "observer.json"), JSON.stringify(report), {
    mode: 0o600,
  });

export default {
  id: "macos-readiness-observer",
  async setup(ctx) {
    root = ctx.options.fixtureRoot;
    report.setup = true;
    await ctx.session.hook("title", (event) => {
      event.result = "macOS native Reflection fixture";
    });
    await ctx.session.hook("retry", (event) => {
      event.decision = { retry: false };
    });
    await ctx.tool.transform((editor) => {
      for (const tool of [...editor.list()])
        if (!allowed.has(tool.name)) editor.remove(tool.id);
      report.onlyMemoryTools =
        editor.list().length === 2 &&
        editor.list().every((tool) => allowed.has(tool.name));
      save();
    });
    await ctx.tool.hook("execute.before", (event) => {
      if (
        !allowed.has(event.tool) ||
        (event.tool === "memory_read_segment" &&
          event.input?.source_id !== "fixture-mac-v2")
      ) {
        report.refused++;
        save();
        throw Error("Fixture refuses tool/source");
      }
      report[event.tool === "memory_search" ? "search" : "read"]++;
      save();
    });
    await ctx.tool.hook("execute.after", (event) => {
      if (allowed.has(event.tool) && event.status === "completed") {
        const content = event.result.content;
        toolResults.push(
          typeof content === "string"
            ? content
            : content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(""),
        );
        writeFileSync(
          join(root, "tool-results.json"),
          JSON.stringify(toolResults),
          { mode: 0o600 },
        );
      }
      if (
        event.tool === "memory_read_segment" &&
        event.status === "completed"
      ) {
        const content = event.result.content;
        const value = JSON.parse(
          typeof content === "string"
            ? content
            : content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(""),
        );
        if (
          value.source_id === "fixture-mac-v2" &&
          value.messages?.length === 1 &&
          value.messages[0].text ===
            readFileSync(join(root, "seed-text"), "utf8") &&
          value.verification?.includes("deterministic segment ID")
        )
          report.readExact++;
      }
      save();
    });
    const steps = new Map();
    await ctx.session.hook("context", (event) => {
      if (event.sessionID === readFileSync(join(root, "seed-session"), "utf8"))
        throw Error("Seed recorded without provider dispatch");
      for (const name of Object.keys(event.tools))
        if (!allowed.has(name)) delete event.tools[name];
      if (Object.keys(event.tools).length !== 2)
        throw Error("Memory tools missing");
      const n = (steps.get(event.sessionID) ?? 0) + 1;
      steps.set(event.sessionID, n);
      if (n > 3) throw Error("Fixture step budget");
      event.options.maxTokens = 2048;
    });
    await ctx.session.hook("model.request", (event) => {
      const expected = readFileSync(join(root, "provider-origin"), "utf8");
      if (event.kind !== "primary" || event.baseURL !== `${expected}/v1`)
        throw Error("Fixture refuses model destination");
      report.primaryRequests++;
      save();
    });
    save();
  },
};
