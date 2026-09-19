import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, readFileSync: vi.fn(original.readFileSync) };
});

import { ProjectionStateStore } from "../src/projection-state.js";

const directories: string[] = [];

afterEach(() => {
  vi.mocked(readFileSync).mockReset();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ProjectionStateStore", () => {
  it.each(["set", "delete"])(
    "does not clobber a direct concurrent %s while reading legacy state",
    async (action) => {
      const original =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const directory = mkdtempSync(join(tmpdir(), "reflection-projection-"));
      directories.push(directory);
      const legacyPath = join(directory, "session.json");
      const envelope = JSON.stringify({
        version: 4,
        state: { contextLimit: 100 },
      });
      writeFileSync(legacyPath, envelope);
      const first = new ProjectionStateStore(directory, "own", "legacy");
      const second = new ProjectionStateStore(directory, "own", "legacy");
      vi.mocked(readFileSync)
        .mockImplementationOnce(original.readFileSync)
        .mockImplementationOnce((path, options) => {
          expect(path).toBe(legacyPath);
          const value = original.readFileSync(path, options);
          if (action === "delete") second.delete("session");
          else second.set("session", { contextLimit: 200 });
          expect(existsSync(legacyPath)).toBe(true);
          return value;
        });
      expect(first.get("session")).toEqual(
        action === "delete" ? undefined : { contextLimit: 200 },
      );
      expect(second.get("session")).toEqual(
        action === "delete" ? undefined : { contextLimit: 200 },
      );
      expect(readFileSync(legacyPath, "utf8")).toBe(envelope);
      first.delete("session");
      writeFileSync(legacyPath, envelope);
      expect(second.get("session")).toBeUndefined();
    },
  );

  it("atomically persists and reloads session checkpoints", () => {
    const directory = mkdtempSync(join(tmpdir(), "reflection-projection-"));
    directories.push(directory);
    const path = join(directory, "nested", "projection");
    const store = new ProjectionStateStore(path);
    const state = {
      contextLimit: 1_000_000,
      checkpoint: {
        tailStartMessageId: "assistant-10",
        archivedPrefixFingerprint: "a".repeat(64),
        canonicalSourceFingerprint: "d".repeat(64),
        summaryText: "summary",
        createdAtMessageId: "user-20",
        lossy: true,
        archivedSegments: [
          {
            id: "seg-1",
            sourceFingerprint: "b".repeat(64),
            startUserMessageId: "user-1",
            endUserMessageId: "user-1",
            sourceBoundaryVersion: 1 as const,
            startSourceMessageId: null,
            endSourceMessageId: null,
          },
        ],
        summaryFingerprint: "c".repeat(64),
      },
    };

    store.set("session", state);

    expect(new ProjectionStateStore(path).get("session")).toEqual(state);
    expect(
      JSON.parse(readFileSync(join(path, "session.json"), "utf8")),
    ).toMatchObject({
      version: 4,
      state,
    });
  });

  it("discards a version 1 checkpoint while preserving its context limit", () => {
    const directory = mkdtempSync(join(tmpdir(), "reflection-projection-"));
    directories.push(directory);
    const path = join(directory, "projection");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "session.json"),
      JSON.stringify({
        version: 1,
        state: {
          contextLimit: 100,
          checkpoint: {
            tailStartUserMessageId: "user-1",
            summaryText: "summary",
            createdAtMessageId: "user-2",
            lossy: true,
          },
        },
      }),
    );

    expect(new ProjectionStateStore(path).get("session")).toEqual({
      contextLimit: 100,
    });
    expect(
      JSON.parse(readFileSync(join(path, "session.json"), "utf8")),
    ).toMatchObject({ version: 1 });
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

  it("retains only context from a malformed legacy checkpoint", () => {
    const directory = mkdtempSync(join(tmpdir(), "reflection-projection-"));
    directories.push(directory);
    const path = join(directory, "projection");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "session.json"),
      JSON.stringify({
        version: 1,
        state: {
          contextLimit: 100,
          checkpoint: {
            tailStartUserMessageId: "user-1",
            tailStartMessageId: "assistant-1",
            summaryText: "summary",
            createdAtMessageId: "user-2",
            lossy: "yes",
          },
        },
      }),
    );

    expect(new ProjectionStateStore(path).get("session")).toEqual({
      contextLimit: 100,
    });
  });

  it("discards a version 2 checkpoint without prefix provenance", () => {
    const directory = mkdtempSync(join(tmpdir(), "reflection-projection-"));
    directories.push(directory);
    const path = join(directory, "projection");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "session.json"),
      JSON.stringify({
        version: 2,
        state: {
          contextLimit: 100,
          checkpoint: {
            tailStartUserMessageId: "user-1",
            summaryText: "summary",
            createdAtMessageId: "user-2",
          },
        },
      }),
    );

    expect(new ProjectionStateStore(path).get("session")).toEqual({
      contextLimit: 100,
    });
  });

  it("discards a version 3 checkpoint while preserving its context limit", () => {
    const directory = mkdtempSync(join(tmpdir(), "reflection-projection-"));
    directories.push(directory);
    const path = join(directory, "projection");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "session.json"),
      JSON.stringify({
        version: 3,
        state: {
          contextLimit: 100,
          checkpoint: {
            tailStartMessageId: "assistant-1",
            archivedPrefixFingerprint: "a".repeat(64),
            summaryText: "summary",
            createdAtMessageId: "user-2",
          },
        },
      }),
    );

    expect(new ProjectionStateStore(path).get("session")).toEqual({
      contextLimit: 100,
    });
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

  it("reads legacy state without mutation and adopts it only on the next set", () => {
    const directory = mkdtempSync(join(tmpdir(), "reflection-projection-"));
    directories.push(directory);
    const path = join(directory, "projection");
    mkdirSync(path, { recursive: true });
    const envelope = { version: 4, state: { contextLimit: 100 } };
    const legacyPath = join(path, "session.json");
    writeFileSync(legacyPath, JSON.stringify(envelope));
    const sourceDirectory = join(
      path,
      `source-${createHash("sha256").update("legacy-source").digest("hex")}`,
    );
    const statePath = join(sourceDirectory, "session.json");
    const markerPath = `${statePath}.legacy-migrated`;
    const store = new ProjectionStateStore(path, "legacy-source", "legacy");
    expect(store.get("session")).toEqual({ contextLimit: 100 });
    expect(store.get("session")).toEqual({ contextLimit: 100 });
    expect(existsSync(sourceDirectory)).toBe(false);
    expect(readFileSync(legacyPath, "utf8")).toBe(JSON.stringify(envelope));

    store.set("session", envelope.state);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual(envelope);
    expect(statSync(sourceDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(statSync(markerPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(legacyPath, "utf8")).toBe(JSON.stringify(envelope));

    writeFileSync(join(path, "other.json"), JSON.stringify(envelope));
    expect(
      new ProjectionStateStore(path, "source-v1", "source-v1").get("other"),
    ).toBeUndefined();
  });

  it("isolates identical session IDs even for path-shaped sources", () => {
    const directory = mkdtempSync(join(tmpdir(), "reflection-projection-"));
    directories.push(directory);
    const first = new ProjectionStateStore(directory, "..", "source-v1");
    const second = new ProjectionStateStore(directory, "a/b", "source-v1");
    first.set("session", { contextLimit: 100 });
    second.set("session", { contextLimit: 200 });
    expect(first.get("session")).toEqual({ contextLimit: 100 });
    expect(second.get("session")).toEqual({ contextLimit: 200 });
    first.delete("session");
    expect(second.get("session")).toEqual({ contextLimit: 200 });
  });

  it("never writes on namespaced reads or falls back through an invalid destination", () => {
    const directory = mkdtempSync(join(tmpdir(), "reflection-projection-"));
    directories.push(directory);
    const sourceDirectory = join(
      directory,
      `source-${createHash("sha256").update("own").digest("hex")}`,
    );
    mkdirSync(sourceDirectory, { mode: 0o700 });
    const path = join(sourceDirectory, "session.json");
    const envelope = JSON.stringify({
      version: 4,
      state: { contextLimit: 200 },
    });
    writeFileSync(path, envelope, { mode: 0o600 });
    writeFileSync(
      join(directory, "session.json"),
      JSON.stringify({ version: 4, state: { contextLimit: 100 } }),
    );
    const store = new ProjectionStateStore(directory, "own", "legacy");
    expect(store.get("session")).toEqual({ contextLimit: 200 });
    expect(existsSync(`${path}.legacy-migrated`)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(envelope);
    writeFileSync(path, "invalid");
    expect(store.get("session")).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("invalid");
    expect(existsSync(`${path}.legacy-migrated`)).toBe(false);
  });

  it("isolates case-sensitive source IDs on case-insensitive filesystems", () => {
    const directory = mkdtempSync(join(tmpdir(), "reflection-projection-"));
    directories.push(directory);
    const first = new ProjectionStateStore(directory, "Source", "source-v1");
    const second = new ProjectionStateStore(directory, "source", "source-v1");
    first.set("session", { contextLimit: 100 });
    second.set("session", { contextLimit: 200 });
    expect(first.get("session")).toEqual({ contextLimit: 100 });
    expect(second.get("session")).toEqual({ contextLimit: 200 });
  });

  it.each(["legacy read", "set", "delete"])(
    "does not resurrect unscoped state after %s",
    (action) => {
      const directory = mkdtempSync(join(tmpdir(), "reflection-projection-"));
      directories.push(directory);
      const envelope = JSON.stringify({
        version: 4,
        state: { contextLimit: 100 },
      });
      const legacyPath = join(directory, "session.json");
      writeFileSync(legacyPath, envelope);
      const store = new ProjectionStateStore(directory, "own", "legacy");
      if (action === "legacy read")
        expect(store.get("session")).toEqual({ contextLimit: 100 });
      if (action === "set") store.set("session", { contextLimit: 200 });
      store.delete("session");
      writeFileSync(legacyPath, envelope);
      expect(
        new ProjectionStateStore(directory, "own", "legacy").get("session"),
      ).toBeUndefined();
    },
  );
});
