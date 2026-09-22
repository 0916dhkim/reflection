import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { appendFileSync, constants } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "@opencode/schema/config";
import { Schema } from "effect";
import { parseUserPolicy } from "../../packages/opencode-v2-plugin/src/user-policy.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    copyFile: vi.fn(actual.copyFile),
    chmod: vi.fn(actual.chmod),
    open: vi.fn(actual.open),
    lstat: vi.fn(actual.lstat),
    unlink: vi.fn(actual.unlink),
  };
});
// @ts-expect-error Standalone installed JS has no declarations in the TS-only project.
const contract = await import("../instance/contract.mjs");
// @ts-expect-error Standalone installed JS has no declarations in the TS-only project.
const prepare = await import("../instance/prepare.mjs");
// @ts-expect-error Standalone installed JS has no declarations in the TS-only project.
const launch = await import("../instance/launch.mjs");
const cleanup: string[] = [];
const secret = "synthetic-password-0123456789";
const runtime = { platform: "darwin", arch: "arm64" };
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

async function fixture() {
  // All test writes stay inside the owned worktree, never the user's real home.
  const base = await fs.mkdtemp(
    fileURLToPath(new URL("./.instance-fixture-", import.meta.url)),
  );
  cleanup.push(base);
  const home = join(base, "home");
  await fs.mkdir(home, { mode: 0o700 });
  const binary = join(base, "binary"),
    bundle = join(base, "bundle.js");
  await fs.writeFile(binary, "fixture binary", { mode: 0o600 });
  await fs.writeFile(bundle, "fixture bundle", { mode: 0o600 });
  const hashes = {
    binary: digest("fixture binary"),
    bundle: digest("fixture bundle"),
    expectedHome: home,
  };
  return {
    base,
    home,
    userHome: home,
    binary,
    bundle,
    root: join(home, "instance"),
    hashes,
    options: {
      expectedHome: home,
      expectedAssets: {
        "bin/opencode": hashes.binary,
        "plugins/reflection-v2/index.js": hashes.bundle,
      },
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function json(path: string, value: unknown) {
  await fs.writeFile(path, JSON.stringify(value), { mode: 0o600 });
}
async function active(value: Fixture) {
  const native = {
    compaction: { auto: false },
    update: "disable",
    plugins: [
      {
        package: join(value.root, "plugins/reflection-v2"),
        options: {
          configPath: join(value.root, "config/reflection-v2.json"),
          userPolicyPath: join(value.root, "config/user-policy.json"),
        },
      },
    ],
  };
  const reflection = {
    url: "https://reflection.example.test",
    apiKey: "synthetic-api-key",
    sourceId: "danny-opencode-v2",
    sources: {
      "danny-opencode-v1": {
        kind: "opencode-v1",
        url: "http://127.0.0.1:4097",
      },
      "danny-opencode-v2": {
        kind: "opencode-v2",
        url: "http://127.0.0.1:4096",
        username: "opencode",
        password: secret,
      },
    },
    contextProjection: { enabled: true },
  };
  const policy = {
    version: 1,
    instructionFiles: [
      join(value.home, "MEMORY.md"),
      join(value.home, "USER.md"),
    ],
    modelAllowlists: { openrouter: ["google/gemini-3.8-flash"] },
    geminiOpenRouterToolGuard: true,
  };
  Schema.decodeUnknownSync(Config.Info, { onExcessProperty: "error" })(native);
  parseUserPolicy(policy);
  await fs.writeFile(join(value.root, "secrets/web-password"), secret, {
    mode: 0o600,
  });
  const bind = async () => {
    await json(join(value.root, "config/opencode/opencode.json"), native);
    await json(join(value.root, "config/reflection-v2.json"), reflection);
    await json(join(value.root, "config/user-policy.json"), policy);
    await json(join(value.root, "activation.json"), {
      format: 1,
      approved: true,
      manifestSha256: await contract.manifestSha256(value.root),
      configSha256: {
        nativeConfig: digest(JSON.stringify(native)),
        reflectionConfig: digest(JSON.stringify(reflection)),
        userPolicy: digest(JSON.stringify(policy)),
      },
      attestations: {
        v1PortMoved: true,
        v1ReaderVerified: true,
        nativeSourceRegistered: true,
        accessVerified: true,
      },
    });
  };
  await bind();
  return { native, reflection, policy, bind };
}
function childMock() {
  return Object.assign(new EventEmitter(), { pid: 123, kill: vi.fn() });
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.copyFile).mockReset();
  vi.mocked(fs.chmod).mockReset();
  vi.mocked(fs.open).mockReset();
  vi.mocked(fs.lstat).mockReset();
  vi.mocked(fs.unlink).mockReset();
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.copyFile).mockImplementation(actual.copyFile);
  vi.mocked(fs.chmod).mockImplementation(actual.chmod);
  vi.mocked(fs.open).mockImplementation(actual.open);
  vi.mocked(fs.lstat).mockImplementation(actual.lstat);
  vi.mocked(fs.unlink).mockImplementation(actual.unlink);
  vi.unstubAllEnvs();
  await Promise.all(
    cleanup
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

describe("isolated preparation and mock-only launch", () => {
  it.each(["prepare", "launch"])(
    "runs the %s CLI argument guard through a symlink alias",
    async (name) => {
      const v = await fixture();
      const alias = join(v.base, `${name}-alias.mjs`);
      await fs.symlink(
        fileURLToPath(new URL(`../instance/${name}.mjs`, import.meta.url)),
        alias,
      );
      // No valid flags: only the Node CLI argument guard runs, never native code.
      await expect(
        promisify(execFile)(process.execPath, [alias], { timeout: 5000 }),
      ).rejects.toMatchObject({
        code: 1,
        stdout: "",
        stderr: `instance-${name === "prepare" ? "prepare" : "launch"}: E_ARGUMENT\n`,
      });
      await expect(fs.lstat(v.root)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("uses the fixed public pnpm executable directory and private writable tool state", () => {
    vi.stubEnv("PATH", "/untrusted/bin");
    vi.stubEnv("PNPM_HOME", "/untrusted/pnpm");
    vi.stubEnv("npm_config_cache", "/untrusted/cache");
    vi.stubEnv("NODE_OPTIONS", "untrusted");
    const root = "/isolated/instance",
      home = "/Users/synthetic";
    const env = contract.nativePlan(root, secret, home).env;
    expect(env.PATH.split(":")).toContain("/Users/synthetic/Library/pnpm/bin");
    expect(env.PATH).not.toContain("/untrusted");
    expect(env).not.toHaveProperty("NODE_OPTIONS");
    expect(env.PNPM_HOME).toBe(join(root, "data/pnpm"));
    expect(env.npm_config_cache).toBe(join(root, "cache/npm"));
    expect(
      contract.buildChildEnvironment(root, secret).PATH.split(":"),
    ).toContain(join(userInfo().homedir, "Library/pnpm/bin"));
    expect(() =>
      contract.nativePlan(root, secret, "/home/injected:/bad"),
    ).toThrow("E_ROOT");
  });

  it("bounds an append during copy to the initial source size and rejects it", async () => {
    const v = await fixture(),
      actual = await vi.importActual<typeof fs>("node:fs/promises");
    const initial = await fs.readFile(v.binary);
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const handle = await actual.open(path, flags, mode);
      if (
        path === v.binary &&
        (await actual.lstat(v.root).catch(() => undefined))
      ) {
        expect(Number(flags) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementationOnce(
          async (...args: unknown[]) => {
            await fs.appendFile(v.binary, "appended-tail-must-not-be-copied");
            return Reflect.apply(read, handle, args);
          },
        );
      }
      return handle;
    });
    await expect(prepare.prepareInstance(v, v.hashes)).rejects.toThrow(
      "E_COPY",
    );
    expect(await fs.readFile(join(v.root, "bin/opencode"))).toEqual(initial);
    await expect(fs.lstat(join(v.root, "manifest.json"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("rejects a same-size source change between prehash and copy by destination hash", async () => {
    const v = await fixture(),
      actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      if (
        path === v.binary &&
        (await actual.lstat(v.root).catch(() => undefined))
      )
        await fs.writeFile(v.binary, "changed binary");
      return actual.open(path, flags, mode);
    });
    await expect(prepare.prepareInstance(v, v.hashes)).rejects.toThrow(
      "E_COPY",
    );
    expect(await fs.readFile(join(v.root, "bin/opencode"), "utf8")).toBe(
      "changed binary",
    );
  });

  it("bounds prehash streams to their captured end and detects appended source bytes", async () => {
    const v = await fixture(),
      actual = await vi.importActual<typeof fs>("node:fs/promises");
    const size = (await fs.stat(v.binary)).size;
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      expect(Number(flags) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
      const handle = await actual.open(path, flags, mode);
      const stream = handle.createReadStream.bind(handle);
      vi.spyOn(handle, "createReadStream").mockImplementation((options) => {
        expect(options).toMatchObject({
          start: 0,
          end: size - 1,
          autoClose: false,
        });
        appendFileSync(v.binary, "growing-tail");
        return stream(options);
      });
      return handle;
    });
    await expect(contract.sha256File(v.binary)).rejects.toThrow("E_FILE");
  });

  it("hashes empty files correctly and refuses oversized sources before root creation", async () => {
    const v = await fixture();
    await fs.writeFile(v.binary, "");
    expect(await contract.sha256File(v.binary)).toBe(digest(""));
    await fs.truncate(v.binary, 250 * 1024 * 1024 + 1);
    await expect(prepare.prepareInstance(v, v.hashes)).rejects.toThrow(
      "E_SOURCE",
    );
    await expect(fs.lstat(v.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces the smaller bundle cap before creating a root", async () => {
    const v = await fixture();
    await fs.truncate(v.bundle, 10 * 1024 * 1024 + 1);
    await expect(prepare.prepareInstance(v, v.hashes)).rejects.toThrow(
      "E_SOURCE",
    );
    await expect(fs.lstat(v.root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(contract.ASSET_MAX_BYTES["bin/launch.mjs"]).toBe(1024 * 1024);
    expect(contract.ASSET_MAX_BYTES["bin/contract.mjs"]).toBe(1024 * 1024);
  });

  it.each([
    ["config/opencode/opencode.json", 2 * 1024 * 1024, "E_FILE"],
    ["config/reflection-v2.json", 2 * 1024 * 1024, "E_FILE"],
    ["config/user-policy.json", 1024 * 1024, "E_FILE"],
    ["secrets/web-password", 256, "E_SECRET"],
    ["activation.json", 2 * 1024 * 1024, "E_ACTIVATION"],
    ["manifest.json", 2 * 1024 * 1024, "E_MANIFEST"],
  ] as const)(
    "rejects oversized private input %s before opening it for reading",
    async (path, cap, error) => {
      const v = await fixture();
      await prepare.prepareInstance(v, v.hashes);
      await active(v);
      const target = join(v.root, path);
      await fs.truncate(target, cap + 1);
      vi.mocked(fs.open).mockClear();
      await expect(
        launch.serve(v.root, vi.fn(), v.options, runtime),
      ).rejects.toThrow(error);
      expect(
        vi.mocked(fs.open).mock.calls.some(([file]) => file === target),
      ).toBe(false);
    },
  );

  it("copies exact launch source bytes, not prepare, with fixed hashes and private modes", async () => {
    const v = await fixture();
    const mask = process.umask(0);
    try {
      await prepare.prepareInstance(v, v.hashes);
      expect(process.umask()).toBe(0);
    } finally {
      process.umask(mask);
    }
    const source = fileURLToPath(
      new URL("../instance/launch.mjs", import.meta.url),
    );
    expect(await fs.readFile(join(v.root, "bin/launch.mjs"))).toEqual(
      await fs.readFile(source),
    );
    const result = await contract.validatePreparedRoot(v.root, v.options);
    expect(result.assetHashes["bin/launch.mjs"]).toBe(
      await contract.sha256File(source),
    );
    expect(fs.copyFile).not.toHaveBeenCalled();
    expect(fs.chmod).not.toHaveBeenCalled();
    expect(fs.open).toHaveBeenCalledWith(
      join(v.root, "bin/opencode"),
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        constants.O_NOFOLLOW,
      0o600,
    );
    const before = await fs.readdir(v.root);
    expect(await launch.check(v.root, v.options)).toMatchObject({
      activationReady: false,
    });
    expect(await fs.readdir(v.root)).toEqual(before);
    await expect(
      launch.serve(v.root, vi.fn(), v.options, runtime),
    ).rejects.toThrow("E_NOT_ACTIVATED");
  });

  it("uses real OS home and production constants despite environment overrides", async () => {
    const v = await fixture();
    vi.stubEnv("HOME", v.home);
    vi.stubEnv("NATIVE_SHA256", v.hashes.binary);
    vi.stubEnv("REFLECTION_V2_SHA256", v.hashes.bundle);
    await expect(prepare.prepareInstance(v)).rejects.toThrow("E_ROOT");
    await expect(
      prepare.prepareInstance(v, { expectedHome: v.home }),
    ).rejects.toThrow("E_SOURCE");
    await expect(fs.lstat(v.root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => prepare.parseArguments(["--expected-home", v.home])).toThrow(
      "E_ARGUMENT",
    );
    expect(() => prepare.parseArguments([])).toThrow("E_ARGUMENT");
    expect(() => launch.parseLaunchArguments(["--serve", "--check"])).toThrow(
      "E_ARGUMENT",
    );
  });

  it("refuses existing, home, ancestor, symlink roots and resolved forbidden aliases", async () => {
    const v = await fixture();
    for (const root of [v.home, v.base])
      await expect(
        prepare.prepareInstance({ ...v, root }, v.hashes),
      ).rejects.toThrow("E_ROOT");
    await fs.mkdir(v.root, { mode: 0o700 });
    await expect(prepare.prepareInstance(v, v.hashes)).rejects.toThrow(
      "E_EXISTS",
    );
    await fs.rm(v.root, { recursive: true });
    await fs.symlink(v.home, v.root);
    await expect(prepare.prepareInstance(v, v.hashes)).rejects.toThrow();
    await fs.rm(v.root);
    await fs.mkdir(join(v.home, "actual-v1"), { mode: 0o700 });
    await fs.symlink(join(v.home, "actual-v1"), join(v.home, ".opencode"));
    await expect(
      prepare.prepareInstance(
        { ...v, root: join(v.home, "actual-v1/v2") },
        v.hashes,
      ),
    ).rejects.toThrow("E_ROOT");
    await fs.mkdir(join(v.home, "config-alias"), { mode: 0o700 });
    await fs.symlink(join(v.home, "config-alias"), join(v.home, ".config"));
    await expect(
      prepare.prepareInstance(
        { ...v, root: join(v.home, "config-alias/opencode") },
        v.hashes,
      ),
    ).rejects.toThrow("E_ROOT");
  });

  it.each([
    "bin/opencode",
    "data/opencode",
    "config/opencode",
    "secrets",
    "cache/opencode",
  ])("refuses critical symlinks: %s", async (path) => {
    const v = await fixture();
    await prepare.prepareInstance(v, v.hashes);
    await fs.rm(join(v.root, path), { recursive: true });
    await fs.symlink(v.home, join(v.root, path));
    await expect(launch.check(v.root, v.options)).rejects.toThrow();
  });

  it("checks only bounded critical paths, not workspace or pnpm cache symlinks", async () => {
    const v = await fixture();
    await prepare.prepareInstance(v, v.hashes);
    await fs.symlink(v.home, join(v.root, "workspace/dependency"));
    await fs.symlink(v.home, join(v.root, "cache/opencode/pnpm-link"));
    await expect(launch.check(v.root, v.options)).resolves.toMatchObject({
      prepared: true,
    });
    await fs.chmod(v.home, 0o777);
    await expect(launch.check(v.root, v.options)).rejects.toThrow("E_ROOT");
  });

  it.each([
    "data/opencode/opencode.db",
    "data/opencode/opencode.db-wal",
    "data/opencode/opencode.db-shm",
    "config/opencode/opencode.json",
    "secrets/web-password",
  ])("requires private regular unlinked files: %s", async (path) => {
    const v = await fixture();
    await prepare.prepareInstance(v, v.hashes);
    const target = join(v.root, path);
    await fs.writeFile(target, "synthetic", { mode: 0o644 });
    await fs.chmod(target, 0o644);
    await expect(launch.check(v.root, v.options)).rejects.toThrow();
    await fs.chmod(target, 0o600);
    await fs.link(target, join(v.base, "hardlink"));
    await expect(launch.check(v.root, v.options)).rejects.toThrow();
  });

  it.each(["auth.json", "opencode-next.db"])(
    "rejects legacy data without reading it: %s",
    async (name) => {
      const v = await fixture();
      await prepare.prepareInstance(v, v.hashes);
      await fs.symlink(
        join(v.base, "missing"),
        join(v.root, "data/opencode", name),
      );
      await expect(launch.check(v.root, v.options)).rejects.toThrow(
        "E_LEGACY_DATA",
      );
    },
  );

  it("rejects manifest bypass, asset tampering and late preparation failure", async () => {
    const v = await fixture();
    await prepare.prepareInstance(v, v.hashes);
    const path = join(v.root, "manifest.json"),
      original = await fs.readFile(path, "utf8");
    const manifest = JSON.parse(original);
    manifest.forbiddenRoots = [];
    await json(path, manifest);
    await expect(launch.check(v.root, v.options)).rejects.toThrow("E_MANIFEST");
    await fs.writeFile(path, original);
    await fs.writeFile(join(v.root, "preparation-failed"), "failed");
    await expect(launch.check(v.root, v.options)).rejects.toThrow(
      "E_PREPARATION_FAILED",
    );
    await fs.rm(join(v.root, "preparation-failed"));
    await fs.writeFile(join(v.root, "bin/opencode"), "tamper");
    await expect(launch.check(v.root, v.options)).rejects.toThrow("E_ASSET");
  });

  it("detects source mutation during copy and leaves a failed root", async () => {
    const v = await fixture();
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      if (
        path === v.binary &&
        (await actual.lstat(v.root).catch(() => undefined))
      )
        await fs.writeFile(v.binary, "mutated after provenance check");
      return actual.open(path, flags, mode);
    });
    await expect(prepare.prepareInstance(v, v.hashes)).rejects.toThrow(
      "E_COPY",
    );
    expect(await fs.readFile(join(v.root, "preparation-failed"), "utf8")).toBe(
      "failed\n",
    );
    await expect(fs.lstat(join(v.root, "manifest.json"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("never overwrites an unexpected copy destination", async () => {
    const v = await fixture();
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      if (path === join(v.root, "bin/opencode"))
        await fs.writeFile(path, "do not overwrite", { mode: 0o600 });
      return actual.open(path, flags, mode);
    });
    await expect(prepare.prepareInstance(v, v.hashes)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await fs.readFile(join(v.root, "bin/opencode"), "utf8")).toBe(
      "do not overwrite",
    );
  });

  it("does not delete or mark a replaced root after copy failure", async () => {
    const v = await fixture();
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      if (
        path === v.binary &&
        (await actual.lstat(v.root).catch(() => undefined))
      ) {
        await fs.rename(v.root, `${v.root}-original`);
        await fs.mkdir(v.root, { mode: 0o700 });
        await fs.writeFile(join(v.root, "unowned"), "preserve");
        throw new Error("injected copy failure");
      }
      return actual.open(path, flags, mode);
    });
    await expect(prepare.prepareInstance(v, v.hashes)).rejects.toThrow(
      "injected copy failure",
    );
    expect(await fs.readdir(v.root)).toEqual(["unowned"]);
  });

  it("refuses a manifest left by failure after its write", async () => {
    const v = await fixture();
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const handle = await actual.open(path, flags, mode);
      if (String(path).endsWith("manifest.json"))
        vi.spyOn(handle, "chmod").mockRejectedValue(new Error("injected"));
      return handle;
    });
    await expect(prepare.prepareInstance(v, v.hashes)).rejects.toThrow(
      "injected",
    );
    await expect(
      contract.validatePreparedRoot(v.root, v.options),
    ).rejects.toThrow("E_PREPARATION_FAILED");
  });

  it.each(["bin", "plugins/reflection-v2"])(
    "refuses replaced descendant %s before destination open",
    async (directory) => {
      const v = await fixture();
      const external = join(v.base, "external");
      await fs.mkdir(external, { mode: 0o755 });
      const target = join(
        external,
        directory === "bin" ? "opencode" : "index.js",
      );
      await fs.writeFile(target, "external unchanged", { mode: 0o644 });
      const before = await fs.stat(target);
      const actual = await vi.importActual<typeof fs>("node:fs/promises");
      vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
        if (
          path === (directory === "bin" ? v.binary : v.bundle) &&
          (await actual.lstat(v.root).catch(() => undefined))
        ) {
          await fs.rename(
            join(v.root, directory),
            join(v.root, `${directory}-original`),
          );
          await fs.symlink(external, join(v.root, directory));
        }
        return actual.open(path, flags, mode);
      });
      await expect(prepare.prepareInstance(v, v.hashes)).rejects.toThrow(
        "E_ROOT",
      );
      expect(await fs.readFile(target, "utf8")).toBe("external unchanged");
      expect((await fs.stat(target)).mode).toBe(before.mode);
      expect(await fs.readdir(external)).toEqual([
        directory === "bin" ? "opencode" : "index.js",
      ]);
      await expect(
        fs.lstat(join(v.root, "manifest.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.lstat(join(v.root, "preparation-failed")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["write", "chmod"] as const)(
    "leaf replacement during descriptor %s never touches external file",
    async (operation) => {
      const v = await fixture(),
        target = join(v.base, "external-file");
      await fs.writeFile(target, "external unchanged", { mode: 0o644 });
      const before = await fs.stat(target);
      const actual = await vi.importActual<typeof fs>("node:fs/promises");
      vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
        const handle = await actual.open(path, flags, mode);
        if (path === join(v.root, "bin/opencode")) {
          const original = handle[operation].bind(handle);
          vi.spyOn(handle, operation).mockImplementationOnce(
            async (...args) => {
              await fs.rename(path, `${path}-held`);
              await fs.symlink(target, path);
              return Reflect.apply(original, handle, args);
            },
          );
        }
        return handle;
      });
      await expect(prepare.prepareInstance(v, v.hashes)).rejects.toThrow(
        "E_COPY",
      );
      expect(await fs.readFile(target, "utf8")).toBe("external unchanged");
      expect((await fs.stat(target)).mode).toBe(before.mode);
      expect(await fs.readFile(join(v.root, "bin/opencode-held"), "utf8")).toBe(
        "fixture binary",
      );
      await expect(
        fs.lstat(join(v.root, "manifest.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await fs.readFile(join(v.root, "preparation-failed"), "utf8"),
      ).toBe("failed\n");
    },
  );

  it("handles multi-buffer copies and partial reads/writes with bounded allocations", async () => {
    const v = await fixture();
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 19, 0x5a);
    await fs.writeFile(v.binary, bytes);
    v.hashes.binary = createHash("sha256").update(bytes).digest("hex");
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    let writes = 0,
      reads = 0;
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const handle = await actual.open(path, flags, mode);
      if (path === v.binary || path === join(v.root, "bin/opencode")) {
        const read = handle.read.bind(handle),
          write = handle.write.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(
          async (...args: unknown[]) => {
            const [buffer, offset, length, position] = args;
            if (!Buffer.isBuffer(buffer))
              throw new Error("expected buffer read");
            expect(buffer.length).toBeLessThanOrEqual(1024 * 1024);
            reads++;
            return Reflect.apply(read, handle, [
              buffer,
              offset,
              Math.min(Number(length), 192 * 1024),
              position,
            ]);
          },
        );
        if (path !== v.binary)
          vi.spyOn(handle, "write").mockImplementation(
            async (...args: unknown[]) => {
              const [buffer, offset, length, position] = args;
              writes++;
              return Reflect.apply(write, handle, [
                buffer,
                offset,
                Math.min(Number(length), 96 * 1024),
                position,
              ]);
            },
          );
      }
      return handle;
    });
    const manifest = await prepare.prepareInstance(v, v.hashes);
    expect(manifest.assets[0].sha256).toBe(v.hashes.binary);
    expect(await fs.readFile(join(v.root, "bin/opencode"))).toEqual(bytes);
    expect(writes).toBeGreaterThan(3);
    expect(reads).toBeGreaterThan(3);
  }, 15000);

  it("accepts the full schema-decoded synthetic binding and spawns only a mock with private umask", async () => {
    const v = await fixture();
    await prepare.prepareInstance(v, v.hashes);
    await active(v);
    const child = childMock(),
      mask = process.umask();
    vi.stubEnv("NODE_OPTIONS", "secret");
    vi.stubEnv("OPENAI_API_KEY", "secret");
    const spawn = vi.fn((_exe, _args, options) => {
      expect(process.umask()).toBe(0o077);
      expect(options.env).toEqual(
        contract.buildChildEnvironment(v.root, secret, v.home),
      );
      expect(options.env).not.toHaveProperty("NODE_OPTIONS");
      expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(options.stdio).toBe("ignore");
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });
    await launch.serve(v.root, spawn, v.options, runtime);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(process.umask()).toBe(mask);
    await expect(
      fs.lstat(join(v.root, "run/instance.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  const mutations: [string, (a: Awaited<ReturnType<typeof active>>) => void][] =
    [
      [
        "singular plugin",
        (a) => {
          Object.assign(a.native, { plugin: a.native.plugins });
          Reflect.deleteProperty(a.native, "plugins");
        },
      ],
      [
        "external plugin",
        (a) => {
          a.native.plugins.push({
            ...a.native.plugins[0]!,
            package: "/legacy/plugin",
          });
        },
      ],
      [
        "old plugin path",
        (a) => {
          a.native.plugins[0]!.package = "/old/plugins/reflection-v2";
        },
      ],
      [
        "old config path",
        (a) => {
          a.native.plugins[0]!.options.configPath = "/old/reflection.json";
        },
      ],
      [
        "old policy path",
        (a) => {
          a.native.plugins[0]!.options.userPolicyPath = "/old/policy.json";
        },
      ],
      [
        "compaction",
        (a) => {
          a.native.compaction.auto = true;
        },
      ],
      [
        "update",
        (a) => {
          a.native.update = "notify";
        },
      ],
      [
        "reflection URL",
        (a) => {
          a.reflection.url = "http://reflection.example.test";
        },
      ],
      [
        "URL credentials",
        (a) => {
          a.reflection.url = "https://user:secret@reflection.example.test";
        },
      ],
      [
        "API key",
        (a) => {
          a.reflection.apiKey = "";
        },
      ],
      [
        "placeholder",
        (a) => {
          a.reflection.apiKey = "__OPENCODE_PRIVATE_API_KEY__";
        },
      ],
      [
        "source ID",
        (a) => {
          a.reflection.sourceId = "wrong";
        },
      ],
      [
        "projection",
        (a) => {
          a.reflection.contextProjection.enabled = false;
        },
      ],
      [
        "v1 port",
        (a) => {
          a.reflection.sources["danny-opencode-v1"].url =
            "http://127.0.0.1:4096";
        },
      ],
      [
        "v2 port",
        (a) => {
          a.reflection.sources["danny-opencode-v2"].url =
            "http://127.0.0.1:4097";
        },
      ],
      [
        "v1 kind",
        (a) => {
          a.reflection.sources["danny-opencode-v1"].kind = "opencode-v2";
        },
      ],
      [
        "v2 kind",
        (a) => {
          a.reflection.sources["danny-opencode-v2"].kind = "opencode-v1";
        },
      ],
      [
        "username",
        (a) => {
          a.reflection.sources["danny-opencode-v2"].username = "wrong";
        },
      ],
      [
        "password",
        (a) => {
          a.reflection.sources["danny-opencode-v2"].password =
            "different-secret";
        },
      ],
      [
        "policy version",
        (a) => {
          a.policy.version = 2;
        },
      ],
      [
        "policy files",
        (a) => {
          a.policy.instructionFiles = ["relative"];
        },
      ],
      [
        "policy allowlist",
        (a) => {
          Object.assign(a.policy, { modelAllowlists: [] });
        },
      ],
      [
        "policy guard",
        (a) => {
          a.policy.geminiOpenRouterToolGuard = false;
        },
      ],
    ];
  it.each(mutations)(
    "rejects rebound invalid config: %s",
    async (_name, mutate) => {
      const v = await fixture();
      await prepare.prepareInstance(v, v.hashes);
      const a = await active(v);
      mutate(a);
      await a.bind();
      const spawn = vi.fn();
      await expect(
        launch.serve(v.root, spawn, v.options, runtime),
      ).rejects.toThrow("E_CONFIG");
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it.each([
    "approved",
    "v1PortMoved",
    "v1ReaderVerified",
    "nativeSourceRegistered",
    "accessVerified",
    "manifestSha256",
    "nativeConfig",
    "reflectionConfig",
    "userPolicy",
  ])("requires every receipt binding: %s", async (field) => {
    const v = await fixture();
    await prepare.prepareInstance(v, v.hashes);
    await active(v);
    const path = join(v.root, "activation.json"),
      receipt = JSON.parse(await fs.readFile(path, "utf8"));
    if (field in receipt.attestations) receipt.attestations[field] = false;
    else if (field in receipt.configSha256)
      receipt.configSha256[field] = "0".repeat(64);
    else receipt[field] = field === "approved" ? false : "0".repeat(64);
    await json(path, receipt);
    await expect(
      launch.serve(v.root, vi.fn(), v.options, runtime),
    ).rejects.toThrow("E_ACTIVATION");
  });

  it.each(["short", "synthetic-long-password\n", "REPLACE_PASSWORD_123456"])(
    "rejects unsafe password bytes",
    async (password) => {
      const v = await fixture();
      await prepare.prepareInstance(v, v.hashes);
      await active(v);
      await fs.writeFile(join(v.root, "secrets/web-password"), password);
      await expect(
        launch.serve(v.root, vi.fn(), v.options, runtime),
      ).rejects.toThrow("E_SECRET");
    },
  );

  it.each(["SIGINT", "SIGTERM"])(
    "forwards %s during spawn and holds lock until exit",
    async (signal) => {
      const v = await fixture();
      await prepare.prepareInstance(v, v.hashes);
      await active(v);
      const child = childMock();
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const counts = [
        process.listenerCount("SIGINT"),
        process.listenerCount("SIGTERM"),
      ];
      const running = launch.serve(
        v.root,
        () => {
          process.emit(signal as "SIGINT");
          ready();
          return child;
        },
        v.options,
        runtime,
      );
      await started;
      expect(child.kill).toHaveBeenCalledWith(signal);
      await expect(contract.acquireLock(v.root)).rejects.toThrow("E_LOCKED");
      child.emit("exit", 0);
      await running;
      expect([
        process.listenerCount("SIGINT"),
        process.listenerCount("SIGTERM"),
      ]).toEqual(counts);
    },
  );

  it.each(["throw", "error", "exit"])(
    "cleans listeners and restores umask after mock %s failure",
    async (mode) => {
      const v = await fixture();
      await prepare.prepareInstance(v, v.hashes);
      await active(v);
      const mask = process.umask(),
        count = process.listenerCount("SIGINT");
      const spawn = () => {
        if (mode === "throw") throw new Error(secret);
        const child = Object.assign(new EventEmitter(), {
          pid: undefined,
          kill: vi.fn(),
        });
        queueMicrotask(() =>
          mode === "error"
            ? child.emit("error", new Error(secret))
            : child.emit("exit", 7),
        );
        return child;
      };
      await expect(
        launch.serve(v.root, spawn, v.options, runtime),
      ).rejects.toThrow(/^E_NATIVE$/);
      expect(process.umask()).toBe(mask);
      expect(process.listenerCount("SIGINT")).toBe(count);
      await expect(
        fs.lstat(join(v.root, "run/instance.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([
    ["SIGINT", "open"],
    ["SIGTERM", "open"],
    ["SIGINT", "write"],
    ["SIGTERM", "write"],
  ] as const)(
    "cancels spawn and releases owned lock on %s during acquisition %s",
    async (signal, window) => {
      const v = await fixture();
      await prepare.prepareInstance(v, v.hashes);
      await active(v);
      const actual = await vi.importActual<typeof fs>("node:fs/promises");
      const counts = [
        process.listenerCount("SIGINT"),
        process.listenerCount("SIGTERM"),
      ];
      let resume!: () => void, ready!: () => void;
      const paused = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const opened = new Promise<void>((resolve) => {
        ready = resolve;
      });
      vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
        const handle = await actual.open(path, flags, mode);
        if (
          String(path).endsWith("instance.lock") &&
          typeof flags === "number" &&
          flags & constants.O_CREAT
        ) {
          if (window === "open") {
            process.emit(signal);
            ready();
            await paused;
            return handle;
          }
          const write = handle.writeFile.bind(handle);
          vi.spyOn(handle, "writeFile").mockImplementationOnce(
            async (...args) => {
              process.emit(signal);
              ready();
              await paused;
              return Reflect.apply(write, handle, args);
            },
          );
        }
        return handle;
      });
      const spawn = vi.fn();
      const running = launch.serve(v.root, spawn, v.options, runtime);
      const rejected = expect(running).rejects.toThrow("E_CANCELLED");
      await opened;
      expect(spawn).not.toHaveBeenCalled();
      resume();
      await rejected;
      expect(spawn).not.toHaveBeenCalled();
      await expect(
        fs.lstat(join(v.root, "run/instance.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect([
        process.listenerCount("SIGINT"),
        process.listenerCount("SIGTERM"),
      ]).toEqual(counts);
    },
  );

  it.each(["SIGINT", "SIGTERM"] as const)(
    "keeps handlers through async release on %s without killing an exited child",
    async (signal) => {
      const v = await fixture();
      await prepare.prepareInstance(v, v.hashes);
      await active(v);
      const actual = await vi.importActual<typeof fs>("node:fs/promises");
      const count = process.listenerCount(signal),
        child = childMock();
      vi.mocked(fs.unlink).mockImplementation(async (path) => {
        expect(process.listenerCount(signal)).toBe(count + 1);
        process.emit(signal);
        await Promise.resolve();
        return actual.unlink(path);
      });
      await launch.serve(
        v.root,
        () => {
          queueMicrotask(() => child.emit("exit", 0));
          return child;
        },
        v.options,
        runtime,
      );
      expect(child.kill).not.toHaveBeenCalled();
      expect(process.listenerCount(signal)).toBe(count);
      await expect(
        fs.lstat(join(v.root, "run/instance.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("cleans signal listeners on acquisition error without reclaiming a stale lock", async () => {
    const v = await fixture();
    await prepare.prepareInstance(v, v.hashes);
    await active(v);
    const path = join(v.root, "run/instance.lock");
    await fs.writeFile(path, "99999999:stale\n", { mode: 0o600 });
    const count = process.listenerCount("SIGTERM"),
      mask = process.umask();
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      if (file === path) process.emit("SIGTERM");
      return actual.open(file, flags, mode);
    });
    const spawn = vi.fn();
    await expect(
      launch.serve(v.root, spawn, v.options, runtime),
    ).rejects.toThrow("E_LOCKED");
    expect(spawn).not.toHaveBeenCalled();
    expect(process.listenerCount("SIGTERM")).toBe(count);
    expect(process.umask()).toBe(mask);
    expect(await fs.readFile(path, "utf8")).toBe("99999999:stale\n");
  });

  it("does not unlink a lock through a replaced parent", async () => {
    const v = await fixture();
    await prepare.prepareInstance(v, v.hashes);
    const lock = await contract.acquireLock(v.root);
    await fs.rename(join(v.root, "run"), join(v.root, "original-run"));
    await fs.mkdir(join(v.root, "run"), { mode: 0o700 });
    await fs.rename(join(v.root, "original-run/instance.lock"), lock.path);
    await contract.releaseLock(lock);
    expect(await fs.readFile(lock.path, "utf8")).toContain(lock.nonce);
  });

  it("retains a started child's lock after error until exit, then reports generic failure", async () => {
    const v = await fixture();
    await prepare.prepareInstance(v, v.hashes);
    await active(v);
    const child = childMock();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const running = launch.serve(
      v.root,
      () => {
        queueMicrotask(ready);
        return child;
      },
      v.options,
      runtime,
    );
    const rejection = expect(running).rejects.toThrow(/^E_NATIVE$/);
    await started;
    child.emit("error", new Error(secret));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(contract.acquireLock(v.root)).rejects.toThrow("E_LOCKED");
    child.emit("exit", 0);
    await rejection;
  });

  it("rejects config bytes changed after receipt creation", async () => {
    const v = await fixture();
    await prepare.prepareInstance(v, v.hashes);
    await active(v);
    await fs.appendFile(join(v.root, "config/user-policy.json"), " ");
    await expect(
      launch.serve(v.root, vi.fn(), v.options, runtime),
    ).rejects.toThrow("E_ACTIVATION");
  });

  it("rejects unsupported runtime before mock spawn", async () => {
    const spawn = vi.fn();
    await expect(
      launch.serve("/unused", spawn, {}, { platform: "linux", arch: "arm64" }),
    ).rejects.toThrow("E_PLATFORM");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("never reclaims stale locks or removes foreign nonces", async () => {
    const v = await fixture();
    await prepare.prepareInstance(v, v.hashes);
    const lock = await contract.acquireLock(v.root);
    await fs.writeFile(lock.path, `${process.pid}:foreign-nonce\n`);
    await contract.releaseLock(lock);
    await expect(contract.acquireLock(v.root)).rejects.toThrow("E_LOCKED");
    await fs.writeFile(lock.path, "99999999:stale\n");
    await contract.releaseLock(lock);
    expect(await fs.readFile(lock.path, "utf8")).toBe("99999999:stale\n");
  });

  it("resolves relocated internal paths but requires explicit absolute-config rebinding", async () => {
    const v = await fixture();
    await prepare.prepareInstance(v, v.hashes);
    await active(v);
    const moved = join(v.home, "moved");
    await fs.rename(v.root, moved);
    expect(
      launch.installationRoot(new URL(`file://${moved}/bin/launch.mjs`).href),
    ).toBe(moved);
    await expect(launch.check(moved, v.options)).resolves.toMatchObject({
      prepared: true,
    });
    await expect(
      launch.serve(moved, vi.fn(), v.options, runtime),
    ).rejects.toThrow("E_CONFIG");
    // This synthetic rebind is not a production migration of workspace session paths.
    await active({ ...v, root: moved });
    await expect(
      contract.validatePreparedRoot(moved, {
        ...v.options,
        requireActivation: true,
      }),
    ).resolves.toMatchObject({ secret });
  });
});
