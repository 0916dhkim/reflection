import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { snapshot } from "./snapshot.mjs";
import { assertFixtureEnvironment } from "./fixture-env.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "cp012-snapshot-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  return {
    root,
    destination: join(root, "output"),
    write(path, text = "fixture", tracked = false) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
      if (tracked)
        execFileSync("git", ["add", "--force", "--", path], { cwd: root });
    },
  };
}

test("snapshot allows only tracked files and owned new harness files, using NUL-delimited names", (t) => {
  const f = fixture(t);
  f.write("tracked\nname.txt", "tracked", true);
  f.write("scripts/dual-runtime/new.mjs");
  f.write("plugin/delivery/untracked-template.txt");
  f.write("untracked-private.txt");
  const files = snapshot(f.root, f.destination);
  assert.deepEqual(Object.keys(files), [
    "scripts/dual-runtime/new.mjs",
    "tracked\nname.txt",
  ]);
  assert.equal(
    readFileSync(join(f.destination, "tracked\nname.txt"), "utf8"),
    "tracked",
  );
});

test("snapshot excludes .env and .env.* at every depth even when tracked", (t) => {
  const f = fixture(t);
  for (const path of [
    ".env",
    "nested/.env.local",
    "nested/.env",
    "scripts/dual-runtime/.env.test",
  ])
    f.write(path, "not copied", true);
  f.write("safe.txt", "safe", true);
  assert.deepEqual(Object.keys(snapshot(f.root, f.destination)), ["safe.txt"]);
});

test("snapshot refuses tracked symlinks", (t) => {
  const f = fixture(t);
  f.write("target");
  symlinkSync("target", join(f.root, "link"));
  execFileSync("git", ["add", "link"], { cwd: f.root });
  assert.throws(
    () => snapshot(f.root, f.destination),
    /symlinks and special files/,
  );
});

test("snapshot refuses a symlink replacing a tracked parent directory", (t) => {
  const f = fixture(t);
  f.write("parent/file", "tracked", true);
  f.write("outside/file");
  rmSync(join(f.root, "parent"), { recursive: true });
  symlinkSync("outside", join(f.root, "parent"));
  assert.throws(
    () => snapshot(f.root, f.destination),
    /symlinks and special files/,
  );
});

test("snapshot refuses special files instead of reading a FIFO", (t) => {
  const f = fixture(t);
  f.write("fifo", "tracked", true);
  rmSync(join(f.root, "fifo"));
  execFileSync("mkfifo", [join(f.root, "fifo")]);
  assert.throws(
    () => snapshot(f.root, f.destination),
    /symlinks and special files/,
  );
});

test("database/environment guard accepts only exact isolated fixture values without changing global environment", () => {
  const original = { ...process.env };
  const environment = {
    DATABASE_URL: "postgresql://fixture:fixture-only@fixture-pg:5432/fixture",
    REFLECTION_API_KEY: "fixture-reflection",
    OPENROUTER_API_KEY: "fixture-openrouter",
    VOYAGE_API_KEY: "fixture-voyage",
    OPENROUTER_BASE_URL: "http://127.0.0.1:4101/v1",
    VOYAGE_BASE_URL: "http://127.0.0.1:4102/v1",
    HOME: "/state/home",
  };
  assert.doesNotThrow(() => assertFixtureEnvironment(environment));
  for (const key of Object.keys(environment))
    assert.throws(
      () => assertFixtureEnvironment({ ...environment, [key]: "not-fixture" }),
      (error) =>
        error.message === `Refusing non-fixture ${key}` && !("actual" in error),
    );
  assert.deepEqual({ ...process.env }, original);
});
