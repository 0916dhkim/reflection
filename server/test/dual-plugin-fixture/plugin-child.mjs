import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

// HOME must be isolated before importing v1: its config path is captured at import time.
assert.equal(await realpath(homedir()), process.cwd());
assert.match(homedir(), /reflection-dual-plugin-[^/]+\/v[12]$/);
const [version, bundle, configPath] = process.argv.slice(2);
assert.equal(
  resolve(configPath),
  resolve(homedir(), ".config/opencode/reflection.json"),
);
const config = JSON.parse(await readFile(configPath, "utf8"));
const own = config.sources[config.sourceId];
let sdkReads = 0,
  dispose,
  idle,
  tools;
const hooks = new Map(),
  storage = new Map(),
  events = [];
let wake = () => {};
const { default: plugin } = await import(pathToFileURL(bundle).href);
if (version === "v1") {
  const client = {
    app: { log: async () => ({ data: true }) },
    provider: {
      list: async () => ({
        data: {
          all: [
            {
              id: "fixture",
              models: {
                model: {
                  limit: { context: 120000, input: 120000, output: 32000 },
                },
              },
            },
          ],
        },
      }),
    },
    session: {
      get: async () => ({ data: { time: { updated: Date.now() } } }),
      status: async () => ({ data: {} }),
      list: async () => ({ data: [] }),
      messages: async ({ path, signal }) => {
        sdkReads++;
        const response = await fetch(`${own.url}/session/${path.id}/message`, {
          headers: {
            authorization: `Basic ${Buffer.from(`${own.username}:${own.password}`).toString("base64")}`,
          },
          signal,
        });
        if (!response.ok)
          throw new Error(`fixture SDK history ${response.status}`);
        return { data: await response.json() };
      },
    },
  };
  const registered = await plugin({ client, directory: "/fixture" });
  const hostConfig = {};
  await registered.config(hostConfig);
  assert.equal(hostConfig.compaction.auto, false);
  tools = new Map(Object.entries(registered.tool));
  idle = async () =>
    registered.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "same-session" },
      },
    });
  dispose = () => registered.dispose();
} else {
  assert.equal(version, "v2");
  tools = new Map();
  dispose = await plugin.setup({
    app: { name: "opencode", version: "2.0.8", channel: "latest" },
    options: { configPath },
    location: { directory: "/fixture" },
    session: {
      hook: async (name, callback) => {
        hooks.set(name, callback);
        return {
          dispose: async () => {
            hooks.delete(name);
          },
        };
      },
    },
    tool: {
      transform: async (callback) => {
        callback({ add: (tool) => tools.set(tool.name, tool) });
        return {
          dispose: async () => {
            tools.clear();
          },
        };
      },
    },
    storage: {
      get: async (key) => storage.get(key),
      set: async (key, value) => {
        storage.set(key, value);
      },
      remove: async (key) => {
        storage.delete(key);
      },
    },
    model: {
      list: async () => ({
        location: { directory: "/fixture" },
        data: [
          {
            id: "model",
            providerID: "fixture",
            limit: { context: 120000, input: 120000, output: 32000 },
          },
        ],
      }),
    },
    event: {
      subscribe: async function* ({ signal }) {
        while (!signal.aborted) {
          if (events.length) {
            yield events.shift();
            continue;
          }
          await new Promise((resolve) => {
            wake = () => {
              signal.removeEventListener("abort", wake);
              resolve();
            };
            signal.addEventListener("abort", wake, { once: true });
          });
        }
      },
    },
  });
  assert.deepEqual([...hooks.keys()].sort(), [
    "compaction",
    "context",
    "model.request",
  ]);
  idle = async () => {
    events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "same-session" },
    });
    wake();
  };
}
assert.deepEqual([...tools.keys()].sort(), [
  "memory_read_segment",
  "memory_search",
]);
process.send({ id: 0, result: "ready", sdkReads });
process.on("message", async ({ id, cmd, args }) => {
  try {
    let result = "";
    if (cmd === "idle") await idle();
    else if (cmd === "dispose") {
      await dispose();
      if (version === "v2") {
        assert.equal(hooks.size, 0);
        assert.equal(tools.size, 0);
      }
    } else {
      const context =
        version === "v1"
          ? { sessionID: "same-session", abort: new AbortController().signal }
          : {
              sessionID: "same-session",
              messageID: "fixture-call",
              agent: "build",
              id: String(id),
              progress: async () => {},
            };
      const output = await tools.get(cmd).execute(args, context);
      result = version === "v1" ? output : output.content;
    }
    process.send({ id, result, sdkReads }, () => {
      if (cmd === "dispose") process.exit(0);
    });
  } catch (error) {
    process.send({ id, error: String(error.stack ?? error) });
  }
});
