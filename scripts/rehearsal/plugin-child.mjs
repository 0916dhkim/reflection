import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const home = process.env.HOME;
if (typeof home !== "string" || !resolve(home).startsWith("/state/")) {
  throw new Error("fixture HOME must be an isolated /state path");
}

const bundle = process.env.REHEARSAL_PLUGIN_BUNDLE;
const reflectionUrl = process.env.REHEARSAL_REFLECTION_URL;
const readerUrl = process.env.REHEARSAL_READER_URL;
if (!bundle || !reflectionUrl || !readerUrl) {
  throw new Error("fixture plugin environment is incomplete");
}

const sourceId = process.env.REHEARSAL_SOURCE_ID ?? "rehearsal-legacy";
const version = process.env.REHEARSAL_PLUGIN_VERSION;
if (version !== "old" && version !== "new") {
  throw new Error("fixture plugin version must be old or new");
}

const configDirectory = resolve(home, ".config", "opencode");
const configPath = resolve(configDirectory, "reflection.json");
if (!configPath.startsWith(`${resolve(home)}/`)) {
  throw new Error("fixture config path escapes HOME");
}
mkdirSync(configDirectory, { recursive: true });
writeFileSync(
  configPath,
  `${JSON.stringify({
    url: reflectionUrl,
    apiKey: "fixture-api-key",
    sourceId,
    sources: {
      [sourceId]: { kind: "opencode-v1", url: readerUrl },
      "rehearsal-secondary": { kind: "opencode-v1", url: readerUrl },
    },
    contextProjection: { enabled: true },
  })}\n`,
);

const histories = new Map();
const clone = (value) => structuredClone(value);

function send(message) {
  if (process.send) {
    process.send(message);
  }
}

function sendAndExit(message) {
  if (process.send) {
    process.send(message, () => process.exit(0));
    return;
  }
  process.exit(0);
}

const client = {
  app: {
    async log() {
      send({ event: "log", message: "fixture plugin log" });
      return { data: true };
    },
  },
  provider: {
    async list() {
      return {
        data: {
          all: [
            {
              id: "fixture",
              models: {
                model: {
                  limit: { context: 120_000, input: 120_000, output: 32_000 },
                },
              },
            },
          ],
        },
      };
    },
  },
  session: {
    async get() {
      return { data: { time: { updated: 0 } } };
    },
    async messages({ path }) {
      return { data: clone(histories.get(path.id) ?? []) };
    },
    async list() {
      return { data: [] };
    },
    async status() {
      return { data: {} };
    },
  },
};

const { default: Reflection } = await import(pathToFileURL(bundle).href);
const hooks = await Reflection({ client, directory: "/fixture" });
const pluginConfig = {};
await hooks.config(pluginConfig);
if (pluginConfig.compaction?.auto !== false) {
  throw new Error("fixture plugin did not disable automatic compaction");
}
send({ event: "ready" });

async function command(message) {
  switch (message.cmd) {
    case "set-history":
      histories.set(message.sessionId, clone(message.messages));
      return {};
    case "idle":
      await hooks.event({
        event: {
          type: "session.idle",
          properties: { sessionID: message.sessionId },
        },
      });
      return {};
    case "project": {
      const output = { messages: clone(message.messages) };
      await hooks["experimental.chat.messages.transform"]({}, output);
      return { messages: output.messages };
    }
    case "search": {
      const result = await hooks.tool.memory_search.execute(
        { query: message.query },
        { abort: new AbortController().signal },
      );
      return { result };
    }
    case "read": {
      const args =
        version === "old"
          ? { segment_id: message.segmentId }
          : { source_id: message.sourceId, segment_id: message.segmentId };
      const result = await hooks.tool.memory_read_segment.execute(args, {
        abort: new AbortController().signal,
      });
      return { result };
    }
    case "dispose":
      await hooks.dispose();
      return { dispose: true };
    default:
      throw new Error("unknown fixture plugin command");
  }
}

process.on("message", async (message) => {
  if (!message || typeof message !== "object") {
    return;
  }
  try {
    const result = await command(message);
    if (message.cmd === "dispose") {
      sendAndExit({ id: message.id, ok: true, ...result });
      return;
    }
    send({ id: message.id, ok: true, ...result });
  } catch (error) {
    send({
      id: message.id,
      ok: false,
      error: String(error),
    });
  }
});
