import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({
  home: `/tmp/reflection-plugin-test-${process.pid}`,
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => paths.home,
}));

import { Reflection } from "../src/index.js";

beforeAll(() => {
  mkdirSync(join(paths.home, ".config", "opencode"), { recursive: true });
  writeFileSync(
    join(paths.home, ".config", "opencode", "reflection.json"),
    JSON.stringify({
      url: "https://reflection.example.com",
      apiKey: "test",
      contextProjection: { enabled: true },
    }),
  );
});

afterAll(() => {
  rmSync(paths.home, { recursive: true, force: true });
});

describe("Reflection plugin hooks", () => {
  it("disables automatic compaction but bypasses projection for manual compaction", async () => {
    const providerList = vi.fn(() => {
      throw new Error("provider lookup must not run during manual compaction");
    });
    const hooks = await Reflection({
      client: { provider: { list: providerList } },
      directory: "/tmp",
    } as never);
    const config: { compaction?: { auto?: boolean } } = {};
    await hooks.config?.(config as never);
    expect(config.compaction?.auto).toBe(false);

    await hooks["experimental.session.compacting"]?.(
      { sessionID: "session" },
      { context: [] },
    );
    const output = {
      messages: [
        {
          info: {
            id: "compaction-user",
            sessionID: "session",
            role: "user",
            time: { created: 0 },
            agent: "build",
            model: { providerID: "provider", modelID: "model" },
          },
          parts: [],
        },
      ],
    };
    const original = structuredClone(output.messages);

    await hooks["experimental.chat.messages.transform"]?.({}, output as never);

    expect(output.messages).toEqual(original);
    expect(providerList).not.toHaveBeenCalled();
  });
});
