import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  main: vi.fn(async () => 7),
}));

vi.mock("../src/backfill.ts", () => ({ main: mocks.main }));

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
  mocks.main.mockClear();
});

describe("stable backfill launcher", () => {
  it("is inert on import and delegates to main exactly once when launched", async () => {
    const launcherPath = "../backfill.mjs";
    const launcher = (await import(launcherPath)) as {
      launch(): Promise<void>;
    };

    expect(mocks.main).not.toHaveBeenCalled();
    await launcher.launch();

    expect(mocks.main).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(7);
  });

  it("loads the real TypeScript module under Node 24 without running main", () => {
    const launcherUrl = new URL("../backfill.mjs", import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      ["-e", `import(${JSON.stringify(launcherUrl)})`],
      { encoding: "utf8" },
    );

    expect(result).toMatchObject({ status: 0, stdout: "", stderr: "" });
  });
});
