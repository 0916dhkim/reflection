import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectionStateStore } from "../src/projection-state.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ProjectionStateStore", () => {
  it("atomically persists and reloads session checkpoints", () => {
    const directory = mkdtempSync(join(tmpdir(), "reflection-projection-"));
    directories.push(directory);
    const path = join(directory, "nested", "projection");
    const store = new ProjectionStateStore(path);
    const state = {
      contextLimit: 1_000_000,
      checkpoint: {
        tailStartUserMessageId: "user-10",
        summaryText: "summary",
        createdAtMessageId: "user-20",
      },
    };

    store.set("session", state);

    expect(new ProjectionStateStore(path).get("session")).toEqual(state);
    expect(
      JSON.parse(readFileSync(join(path, "session.json"), "utf8")),
    ).toMatchObject({
      version: 1,
      state,
    });
  });

  it("removes deleted sessions and ignores invalid state", () => {
    const directory = mkdtempSync(join(tmpdir(), "reflection-projection-"));
    directories.push(directory);
    const path = join(directory, "projection");
    const store = new ProjectionStateStore(path);
    store.set("session", { contextLimit: 100 });

    store.delete("session");

    expect(new ProjectionStateStore(path).get("session")).toBeUndefined();
  });

  it("isolates writes from stores owned by different plugin instances", () => {
    const directory = mkdtempSync(join(tmpdir(), "reflection-projection-"));
    directories.push(directory);
    const path = join(directory, "projection");
    const first = new ProjectionStateStore(path);
    const second = new ProjectionStateStore(path);

    first.set("first", { contextLimit: 100 });
    second.set("second", { contextLimit: 200 });

    const stored = new ProjectionStateStore(path);
    expect(stored.get("first")).toEqual({ contextLimit: 100 });
    expect(stored.get("second")).toEqual({ contextLimit: 200 });
  });
});
