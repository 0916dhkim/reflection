import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/package-opencode.mjs");
const packageModulePath = "../package-opencode.mjs";
const { isWithin, parseArguments, validateOutputLocation } = (await import(
  packageModulePath
)) as {
  isWithin(candidate: string, directory: string): boolean;
  parseArguments(arguments_: string[]): { allowDirty: boolean; output: string };
  validateOutputLocation(
    output: string,
    repository: string,
    home: string,
    protectedRoots?: string[],
  ): void;
};

function run(...arguments_: string[]) {
  return spawnSync(process.execPath, [script, ...arguments_], {
    cwd: root,
    encoding: "utf8",
  });
}

describe("OpenCode package command", () => {
  it("validates required, duplicate, and unknown flags without exposing values", () => {
    expect(() => parseArguments([])).toThrow("--out is required");
    expect(() => parseArguments(["--allow-dirty"])).toThrow(
      "--out is required",
    );
    expect(() => parseArguments(["--out"])).toThrow(
      "--out requires exactly one destination",
    );
    expect(() => parseArguments(["--out", "/one", "--out", "/two"])).toThrow(
      "--out requires exactly one destination",
    );
    expect(() =>
      parseArguments(["--out", "/one", "--allow-dirty", "--allow-dirty"]),
    ).toThrow("--allow-dirty may be specified only once");
    expect(() => parseArguments(["--unknown=secret"])).toThrow(
      "unknown argument",
    );
    expect(() => parseArguments(["--unknown=secret"])).not.toThrow("secret");
    expect(run("--unknown=secret")).toMatchObject({
      status: 1,
      stderr: "package-opencode: unknown argument\n",
    });
  });

  it("recognizes inside paths without misclassifying ..delivery", () => {
    const repository = join("/tmp", "repository");
    const home = join("/tmp", "home");
    expect(isWithin(join(repository, "..delivery"), repository)).toBe(true);
    expect(isWithin(join(home, "..delivery"), home)).toBe(true);
    expect(isWithin(join(repository, "child"), repository)).toBe(true);
    expect(isWithin(join(home, "child"), home)).toBe(true);
    expect(isWithin(join("/tmp", "elsewhere"), repository)).toBe(false);
  });

  it("rejects root, repository, and home output paths deterministically", () => {
    const repository = join("/tmp", "repository");
    const home = join("/tmp", "home");
    expect(() => validateOutputLocation("/", repository, home)).toThrow(
      "filesystem root",
    );
    expect(() => validateOutputLocation(repository, repository, home)).toThrow(
      "outside the repository",
    );
    expect(() =>
      validateOutputLocation(join(repository, "child"), repository, home),
    ).toThrow("outside the repository");
    expect(() => validateOutputLocation(home, repository, home)).toThrow(
      "inside the user home",
    );
    expect(() =>
      validateOutputLocation(join(home, "child"), repository, home),
    ).toThrow("inside the user home");
  });

  it("rejects relative, missing-parent, empty, and nonempty destinations", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "reflection-package-arguments-"),
    );
    try {
      expect(run("--out", "relative-output")).toMatchObject({
        status: 1,
        stderr: expect.stringContaining("absolute path"),
      });
      expect(
        run("--out", join(directory, "missing", "delivery")),
      ).toMatchObject({
        status: 1,
        stderr: expect.stringContaining("parent directory must already exist"),
      });
      const empty = join(directory, "empty");
      mkdirSync(empty);
      expect(run("--out", empty)).toMatchObject({
        status: 1,
        stderr: expect.stringContaining("already exists"),
      });
      const nonempty = join(directory, "nonempty");
      mkdirSync(nonempty);
      writeFileSync(join(nonempty, "file"), "not empty\n");
      expect(run("--out", nonempty)).toMatchObject({
        status: 1,
        stderr: expect.stringContaining("already exists"),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects configured state roots outside HOME before building", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "reflection-package-protected-"),
    );
    try {
      for (const key of [
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "XDG_CACHE_HOME",
        "OPENCODE_CONFIG_DIR",
      ]) {
        const result = spawnSync(
          process.execPath,
          [script, "--out", join(directory, "delivery")],
          {
            cwd: root,
            encoding: "utf8",
            env: { ...process.env, [key]: directory },
          },
        );
        expect(result).toMatchObject({
          status: 1,
          stderr: expect.stringContaining(
            "configured or system config/data/service paths",
          ),
        });
      }
      expect(() =>
        validateOutputLocation(
          "/external/state/package",
          root,
          "/home/fixture",
          ["/external/state"],
        ),
      ).toThrow("configured or system config/data/service paths");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

const fullPackage =
  process.env.REFLECTION_TEST_PACKAGE_OPENCODE === "1" ? it : it.skip;

describe("OpenCode package artifact", () => {
  fullPackage(
    "records hashes for the actual built bundles",
    () => {
      const directory = mkdtempSync(
        join(tmpdir(), "reflection-package-artifact-"),
      );
      const output = join(directory, "delivery");
      try {
        const result = run("--allow-dirty", "--out", output);
        expect(result.status, result.stderr).toBe(0);
        const manifest = JSON.parse(
          readFileSync(join(output, "manifest.json"), "utf8"),
        ) as {
          artifact_file_count: number;
          checksummed_file_count: number;
          dirty: boolean;
          files: Record<string, { bytes: number; sha256: string }>;
        };
        const expected = new Map([
          ["v1/reflection.js", "plugin/dist/reflection.js"],
          ["v2/index.js", "packages/opencode-v2-plugin/dist/reflection-v2.js"],
          [
            "examples/reflection-v1.example.json",
            "plugin/delivery/reflection-v1.example.json",
          ],
          [
            "examples/reflection-v2.example.json",
            "plugin/delivery/reflection-v2.example.json",
          ],
          [
            "examples/opencode-v2.example.json",
            "plugin/delivery/opencode-v2.example.json",
          ],
        ]);
        expect(manifest).toMatchObject({
          artifact_file_count: expected.size + 1,
          checksummed_file_count: expected.size,
          dirty: true,
        });

        for (const [packaged, source] of expected) {
          const contents = readFileSync(join(root, source));
          expect(readFileSync(join(output, packaged))).toEqual(contents);
          expect(manifest.files[packaged]).toEqual({
            bytes: contents.byteLength,
            sha256: createHash("sha256").update(contents).digest("hex"),
          });
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
