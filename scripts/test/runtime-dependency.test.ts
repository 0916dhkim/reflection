import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    lstat: vi.fn(actual.lstat),
  };
});
// @ts-expect-error Standalone operational JS has no declarations.
const runtimeModule = await import("../instance/runtime-dependency.mjs");
const { runtimeDependency, parseArguments } = runtimeModule;
const digest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const cleanup: string[] = [];
const signature =
  "Format=Mach-O thin (arm64)\nAuthority=Developer ID Application: Node.js Foundation (HX7739G8FX)\nTeamIdentifier=HX7739G8FX\n";
type Output = { stdout: string; stderr: string };

async function fixture() {
  const home = await fs.mkdtemp(
    fileURLToPath(new URL("./.runtime-fixture-", import.meta.url)),
  );
  cleanup.push(home);
  const root = join(home, "instance"),
    source = join(home, "pnpm/node");
  const plist = join(home, "Library/LaunchAgents/com.opencode.v2.serve.plist");
  for (const path of [
    root,
    dirname(source),
    dirname(plist),
    join(root, "bin"),
    join(root, "plugins/reflection-v2"),
  ])
    await fs.mkdir(path, { recursive: true, mode: 0o700 });
  await fs.writeFile(source, "synthetic Node executable", { mode: 0o700 });
  const assets = Object.fromEntries(
    [
      "bin/opencode",
      "plugins/reflection-v2/index.js",
      "bin/launch.mjs",
      "bin/contract.mjs",
    ].map((path) => [path, digest(path)]),
  );
  for (const path of Object.keys(assets))
    await fs.writeFile(join(root, path), path, {
      mode: ["bin/opencode", "bin/launch.mjs"].includes(path) ? 0o700 : 0o600,
    });
  const manifest = {
    format: 1,
    purpose: "temporary-coexistence",
    nativeVersion: "2.0.8",
    userHome: home,
    platform: "darwin",
    arch: "arm64",
    port: 4096,
    hostname: "127.0.0.1",
    activation: "blocked",
    relocation: "explicit-rebind-required",
    sourceIds: { v1: "danny-opencode-v1", v2: "danny-opencode-v2" },
    assets: Object.entries(assets).map(([path, sha256]) => ({
      path,
      sha256,
      executable: ["bin/opencode", "bin/launch.mjs"].includes(path),
    })),
  };
  await fs.writeFile(join(root, "manifest.json"), JSON.stringify(manifest), {
    mode: 0o600,
  });
  await fs.writeFile(join(root, "activation.json"), "not read or rewritten", {
    mode: 0o600,
  });
  const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.opencode.v2.serve</string>
<key>ProgramArguments</key><array><string>${source}</string><string>${root}/bin/launch.mjs</string><string>--serve</string></array>
<key>WorkingDirectory</key><string>${root}/workspace</string>
<key>StandardOutPath</key><string>${root}/logs/launcher.log</string>
<key>StandardErrorPath</key><string>${root}/logs/stderr.log</string>
<key>Umask</key><integer>63</integer>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>15</integer>
</dict></plist>
`;
  await fs.writeFile(plist, text, { mode: 0o600 });
  const input = {
    apply: true,
    root,
    source,
    plist,
    nodeSha256: digest(await fs.readFile(source)),
    plistSha256: digest(text),
    version: "24.21.0",
    revision: "384b0a2",
  };
  const node = join(root, "runtime/node");
  const run = vi.fn(
    async (
      command: string,
      args: string[],
      stdin?: string,
    ): Promise<Output> => {
      if (command === "/usr/bin/python3")
        return new Promise((resolve, reject) => {
          const child = execFile(
            command,
            args,
            { env: { PATH: "/usr/bin:/bin" }, timeout: 15000 },
            (error, stdout, stderr) =>
              error ? reject(error) : resolve({ stdout, stderr }),
          );
          child.stdin!.end(stdin);
        });
      if (command === "/usr/bin/codesign")
        return { stdout: "", stderr: args[0] === "-d" ? signature : "" };
      if (command === "/usr/bin/otool")
        return {
          stdout: `${args[1]}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n`,
          stderr: "",
        };
      expect(command).toBe(node);
      expect(args).toEqual(["--version"]);
      return { stdout: "v24.21.0\n", stderr: "" };
    },
  );
  return {
    home,
    root,
    source,
    plist,
    node,
    text,
    input,
    run,
    options: { home, assets, run, platform: "darwin" },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat);
  await Promise.all(
    cleanup
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

describe("private runtime dependency (fixtures only)", () => {
  it("defaults to inspection and requires explicit apply inputs", () => {
    expect(parseArguments([], "/fixture")).toMatchObject({
      apply: false,
      version: "24.21.0",
    });
    for (const args of [
      ["--apply"],
      ["--inspect", "--apply"],
      ["--root", "--apply"],
      ["--bypass"],
      ["--root", "/a", "--root", "/b"],
    ])
      expect(() => parseArguments(args)).toThrow("E_ARGUMENT");
  });

  it("inspects without writes, even when source is inferred from the public plist", async () => {
    const v = await fixture();
    expect(
      await runtimeDependency(
        { ...v.input, apply: false, source: undefined },
        v.options,
      ),
    ).toMatchObject({
      inspected: true,
      diskPrepared: false,
      loadedJobChanged: false,
      nodeVersion: "24.21.0",
      versionVerification: "pending-private-copy",
    });
    await expect(fs.lstat(join(v.root, "runtime"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(v.plist, "utf8")).toBe(v.text);
    expect(
      v.run.mock.calls.every(([command]) =>
        ["/usr/bin/python3", "/usr/bin/codesign", "/usr/bin/otool"].includes(
          command,
        ),
      ),
    ).toBe(true);
  });

  it("publishes a complete exclusive copy before changing only plist argument zero", async () => {
    const v = await fixture();
    const before = await Promise.all(
      [
        "manifest.json",
        "activation.json",
        ...Object.keys(v.options.assets),
      ].map((path) => fs.readFile(join(v.root, path))),
    );
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
      if (destination === v.plist) {
        expect(await fs.readFile(v.node)).toEqual(await fs.readFile(v.source));
        expect((await fs.stat(v.node)).nlink).toBe(1);
        expect(await fs.readFile(v.plist, "utf8")).toBe(v.text);
      }
      await actual.rename(source, destination);
    });
    const result = await runtimeDependency(v.input, v.options);
    expect(result).toMatchObject({
      diskPrepared: true,
      loadedJobChanged: false,
      userReloadRequired: true,
      versionVerification: "verified-private-copy",
    });
    expect(await fs.readFile(v.plist, "utf8")).toBe(
      v.text.replace(v.source, v.node),
    );
    expect(
      await fs.readFile(
        join(v.root, "runtime/launchagent.before.plist"),
        "utf8",
      ),
    ).toBe(v.text);
    expect(
      await Promise.all(
        [
          "manifest.json",
          "activation.json",
          ...Object.keys(v.options.assets),
        ].map((path) => fs.readFile(join(v.root, path))),
      ),
    ).toEqual(before);
    for (const [path, mode] of [
      ["runtime", 0o700],
      ["runtime/node", 0o700],
      ["runtime/launchagent.before.plist", 0o600],
      ["runtime/runtime-dependency.json", 0o600],
    ] as const)
      expect((await fs.stat(join(v.root, path))).mode & 0o777).toBe(mode);
    const receipt = JSON.parse(await fs.readFile(result.receiptPath, "utf8"));
    expect(receipt).toMatchObject({
      state: "disk-prepared",
      loadedJobChanged: false,
      nodeSha256: v.input.nodeSha256,
      versionVerification: "verified-private-copy",
    });
    expect(receipt.integrity).toContain("not checked by launcher");
    expect(
      vi.mocked(fs.open).mock.calls.map(([path]) => String(path)),
    ).not.toContain(join(v.root, "activation.json"));
    expect(
      v.run.mock.calls.filter(([, args]) => args[0] === "--version"),
    ).toEqual([[v.node, ["--version"]]]);
  });

  it.each(["hash", "signature", "verification", "library", "architecture"])(
    "rejects wrong %s before creating runtime",
    async (kind) => {
      const v = await fixture();
      const original = v.run.getMockImplementation()!;
      v.run.mockImplementation(async (command, args, stdin) => {
        const output = await original(command, args, stdin);
        if (kind === "signature" && command.endsWith("codesign"))
          output.stderr = "unsigned";
        if (kind === "architecture" && command.endsWith("codesign"))
          output.stderr = output.stderr.replace("arm64", "x86_64");
        if (kind === "verification" && args[0] === "--verify")
          throw new Error("bad signature");
        if (kind === "library" && command.endsWith("otool"))
          output.stdout +=
            "\t/opt/homebrew/lib/not-standalone.dylib (compatibility version 1)\n";
        return output;
      });
      if (kind === "hash") v.input.nodeSha256 = "0".repeat(64);
      await expect(runtimeDependency(v.input, v.options)).rejects.toThrow();
      await expect(fs.lstat(join(v.root, "runtime"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await fs.readFile(v.plist, "utf8")).toBe(v.text);
    },
  );

  it.each([
    "environment",
    "duplicate",
    "unknown",
    "label",
    "source",
    "argument",
    "malformed",
  ])("rejects %s plist without disclosing its bytes", async (kind) => {
    const v = await fixture();
    const addition =
      kind === "environment"
        ? "<key>EnvironmentVariables</key><dict><key>KEY</key><string>synthetic-secret</string></dict>"
        : kind === "duplicate"
          ? "<key>Label</key><string>com.opencode.v2.serve</string>"
          : "<key>Unknown</key><true/>";
    const text = ["environment", "duplicate", "unknown"].includes(kind)
      ? v.text.replace("</dict></plist>", `${addition}</dict></plist>`)
      : kind === "label"
        ? v.text.replace("<string>com.opencode.v2.serve", "<string>other")
        : kind === "source"
          ? v.text.replace(v.source, "/other/node")
          : kind === "argument"
            ? v.text.replace("--serve", "--check")
            : "broken XML";
    await fs.writeFile(v.plist, text);
    v.input.plistSha256 = digest(text);
    await expect(runtimeDependency(v.input, v.options)).rejects.toThrow();
    expect(await fs.readFile(v.plist, "utf8")).toBe(text);
  });

  it.each(["directory", "symlink", "file"])(
    "refuses existing runtime %s without overwriting",
    async (kind) => {
      const v = await fixture(),
        path = join(v.root, "runtime");
      if (kind === "directory") await fs.mkdir(path, { mode: 0o700 });
      else if (kind === "symlink") await fs.symlink(dirname(v.source), path);
      else await fs.writeFile(path, "unowned destination");
      const before = await fs.lstat(path);
      await expect(runtimeDependency(v.input, v.options)).rejects.toThrow(
        "E_EXISTS",
      );
      expect((await fs.lstat(path)).ino).toBe(before.ino);
    },
  );

  it.each([
    "source-symlink",
    "plist-hardlink",
    "source-mode",
    "root-mode",
    "plist-mode",
    "root-symlink",
    "asset-change",
    "manifest-change",
    "oversize",
  ])("rejects %s", async (kind) => {
    const v = await fixture();
    if (kind === "source-symlink") {
      await fs.rename(v.source, v.source + ".real");
      await fs.symlink(v.source + ".real", v.source);
    }
    if (kind === "plist-hardlink") await fs.link(v.plist, v.plist + ".link");
    if (kind === "source-mode") await fs.chmod(v.source, 0o777);
    if (kind === "root-mode") await fs.chmod(v.root, 0o755);
    if (kind === "plist-mode") await fs.chmod(v.plist, 0o644);
    if (kind === "root-symlink") {
      await fs.rename(v.root, v.root + ".real");
      await fs.symlink(v.root + ".real", v.root);
    }
    if (kind === "asset-change")
      await fs.writeFile(join(v.root, "bin/launch.mjs"), "changed");
    if (kind === "manifest-change")
      await fs.writeFile(join(v.root, "manifest.json"), "{}");
    if (kind === "oversize") await fs.truncate(v.source, 256 * 1024 * 1024 + 1);
    await expect(runtimeDependency(v.input, v.options)).rejects.toThrow();
    expect(await fs.readFile(v.plist, "utf8")).toBe(v.text);
  });

  it("permits a read-only hardlinked source but makes an independent single-link copy", async () => {
    const v = await fixture();
    await fs.link(v.source, v.source + ".link");
    await runtimeDependency(v.input, v.options);
    expect((await fs.stat(v.source)).nlink).toBe(2);
    expect((await fs.stat(v.node)).nlink).toBe(1);
    expect((await fs.stat(v.source)).ino).not.toBe((await fs.stat(v.node)).ino);
  });

  it.each([
    "plist-edit",
    "node-hardlink",
    "node-mode",
    "copy-signature",
    "after-pointer",
  ])("leaves an honest incomplete receipt on %s", async (kind) => {
    const v = await fixture();
    const original = v.run.getMockImplementation()!;
    v.run.mockImplementation(async (command, args, stdin) => {
      const output = await original(command, args, stdin);
      if (kind === "plist-edit" && command === v.node)
        await fs.appendFile(v.plist, "\n");
      if (kind === "node-hardlink" && command === v.node)
        await fs.link(v.node, v.node + ".link");
      if (kind === "node-mode" && command === v.node)
        await fs.chmod(v.node, 0o600);
      if (
        kind === "copy-signature" &&
        args.includes(v.node) &&
        args[0] === "--verify"
      )
        throw new Error("copy signature failure");
      return output;
    });
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    if (kind === "after-pointer")
      vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
        if (String(source).endsWith(".receipt-complete"))
          throw new Error("receipt failed");
        await actual.rename(source, destination);
      });
    await expect(runtimeDependency(v.input, v.options)).rejects.toMatchObject({
      message: "E_APPLY_INCOMPLETE",
      report: {
        diskPrepared: false,
        loadedJobChanged: false,
        incomplete: true,
        plistPointerChanged: kind === "after-pointer",
      },
    });
    const receipt = JSON.parse(
      await fs.readFile(
        join(v.root, "runtime/runtime-dependency.json"),
        "utf8",
      ),
    );
    expect(receipt.state).toBe("staged");
    expect(receipt.loadedJobChanged).toBe(false);
    const failure = JSON.parse(
      await fs.readFile(join(v.root, "runtime/failure.json"), "utf8"),
    );
    expect(failure).toMatchObject({
      plistPointerChanged: kind === "after-pointer",
      loadedJobChanged: false,
      oldPlistSha: v.input.plistSha256,
      newPlistSha: digest(v.text.replace(v.source, v.node)),
    });
    expect(await fs.readFile(v.plist, "utf8")).toBe(
      kind === "after-pointer"
        ? v.text.replace(v.source, v.node)
        : v.text + (kind === "plist-edit" ? "\n" : ""),
    );
  });

  it("detects growth during the bounded copy rather than copying unbounded input", async () => {
    const v = await fixture();
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    let opens = 0;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (args[0] === v.source && ++opens === 2) {
        const read = handle.read.bind(handle);
        // The helper uses this overload exclusively; mutate after its descriptor read.
        handle.read = vi.fn(async (...readArgs: Parameters<typeof read>) => {
          const result = await read(...readArgs);
          await fs.appendFile(v.source, "changed during copy");
          return result;
        }) as typeof handle.read;
      }
      return handle;
    });
    await expect(runtimeDependency(v.input, v.options)).rejects.toMatchObject({
      message: "E_APPLY_INCOMPLETE",
      report: { plistPointerChanged: false, failureRecordWritten: true },
    });
    expect(await fs.readFile(v.plist, "utf8")).toBe(v.text);
    expect(
      JSON.parse(
        await fs.readFile(join(v.root, "runtime/failure.json"), "utf8"),
      ),
    ).toMatchObject({ causeCode: "E_CHANGED", plistPointerChanged: false });
  });

  it("rejects a changed source after metadata, including in inspect mode", async () => {
    const v = await fixture(),
      original = v.run.getMockImplementation()!;
    v.run.mockImplementation(async (command, args, stdin) => {
      const result = await original(command, args, stdin);
      if (command === "/usr/bin/otool" && args.includes(v.source))
        await fs.appendFile(v.source, "changed");
      return result;
    });
    await expect(
      runtimeDependency({ ...v.input, apply: false }, v.options),
    ).rejects.toThrow("E_CHANGED");
    await expect(fs.lstat(join(v.root, "runtime"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["node-exists", "node-symlink", "receipt-edit", "backup-edit"])(
    "does not overwrite or accept %s during staging",
    async (kind) => {
      const v = await fixture(),
        actual = await vi.importActual<typeof fs>("node:fs/promises");
      let injected = false;
      vi.mocked(fs.open).mockImplementation(async (...args) => {
        const handle = await actual.open(...args);
        if (!injected && args[0] === join(v.root, "runtime/.node-stage")) {
          injected = true;
          if (kind === "node-exists")
            await fs.writeFile(v.node, "existing", { mode: 0o700 });
          if (kind === "node-symlink") await fs.symlink(v.source, v.node);
          if (kind === "receipt-edit")
            await fs.appendFile(
              join(v.root, "runtime/runtime-dependency.json"),
              "\n",
            );
          if (kind === "backup-edit")
            await fs.appendFile(
              join(v.root, "runtime/launchagent.before.plist"),
              "\n",
            );
        }
        return handle;
      });
      await expect(runtimeDependency(v.input, v.options)).rejects.toThrow(
        "E_APPLY_INCOMPLETE",
      );
      expect(await fs.readFile(v.plist, "utf8")).toBe(v.text);
      if (kind === "node-exists")
        expect(await fs.readFile(v.node, "utf8")).toBe("existing");
      if (kind === "node-symlink")
        expect(await fs.readlink(v.node)).toBe(v.source);
    },
  );

  it("rejects non-Mac execution and forbidden root locations before inspecting files", async () => {
    const v = await fixture();
    await expect(
      runtimeDependency(v.input, { ...v.options, platform: "linux" }),
    ).rejects.toThrow("E_ARGUMENT");
    for (const root of [
      v.home,
      join(v.home, ".local/share/opencode"),
      join(v.home, "Library/pnpm/runtime"),
      dirname(v.home),
    ]) {
      await expect(
        runtimeDependency({ ...v.input, root }, v.options),
      ).rejects.toThrow("E_LOCATION");
    }
    expect(v.run).not.toHaveBeenCalled();
  });

  it("rejects a source owned by another user", async () => {
    const v = await fixture(),
      actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.lstat).mockImplementation(async (...args) => {
      const info = await actual.lstat(...args);
      if (args[0] === v.source)
        Object.assign(info, { uid: process.getuid!() + 1 });
      return info;
    });
    await expect(runtimeDependency(v.input, v.options)).rejects.toThrow(
      "E_FILE",
    );
    expect(v.run.mock.calls.some(([command]) => command === v.source)).toBe(
      false,
    );
  });

  it("rejects a wrong version only on the verified private copy, before changing the plist", async () => {
    const v = await fixture(),
      original = v.run.getMockImplementation()!;
    v.run.mockImplementation(async (command, args, stdin) => {
      const result = await original(command, args, stdin);
      if (command === v.node) {
        expect(digest(await fs.readFile(v.node))).toBe(v.input.nodeSha256);
        expect((await fs.stat(dirname(v.node))).mode & 0o777).toBe(0o700);
        result.stdout = "v24.20.0\n";
      }
      return result;
    });
    await expect(runtimeDependency(v.input, v.options)).rejects.toMatchObject({
      report: {
        causeCode: "E_VERSION",
        plistPointerChanged: false,
        failureRecordWritten: true,
      },
    });
    expect(
      v.run.mock.calls.filter(([, args]) => args[0] === "--version"),
    ).toEqual([[v.node, ["--version"]]]);
    expect(await fs.readFile(v.plist, "utf8")).toBe(v.text);
  });

  it("records initial receipt creation failure without changing the plist", async () => {
    const v = await fixture(),
      actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (args[0] === join(v.root, "runtime/runtime-dependency.json"))
        throw new Error("receipt unavailable");
      return actual.open(...args);
    });
    await expect(runtimeDependency(v.input, v.options)).rejects.toMatchObject({
      report: { plistPointerChanged: false, failureRecordWritten: true },
    });
    expect(await fs.readFile(v.plist, "utf8")).toBe(v.text);
    const failurePath = join(v.root, "runtime/failure.json");
    expect(JSON.parse(await fs.readFile(failurePath, "utf8"))).toMatchObject({
      diskPrepared: false,
      loadedJobChanged: false,
      plistPointerChanged: false,
    });
    expect((await fs.stat(failurePath)).mode & 0o777).toBe(0o600);
    expect(v.run.mock.calls.some(([, args]) => args[0] === "--version")).toBe(
      false,
    );
  });

  it.each(["existing-record", "changed-parent"])(
    "does not write failure evidence over %s",
    async (kind) => {
      const v = await fixture(),
        original = v.run.getMockImplementation()!;
      const failurePath = join(v.root, "runtime/failure.json");
      v.run.mockImplementation(async (command, args, stdin) => {
        const result = await original(command, args, stdin);
        if (command === v.node) {
          if (kind === "existing-record")
            await fs.writeFile(failurePath, "prior evidence", { mode: 0o600 });
          else await fs.chmod(dirname(v.node), 0o755);
          throw new Error("probe failed");
        }
        return result;
      });
      await expect(runtimeDependency(v.input, v.options)).rejects.toMatchObject(
        { report: { plistPointerChanged: false, failureRecordWritten: false } },
      );
      expect(await fs.readFile(v.plist, "utf8")).toBe(v.text);
      if (kind === "existing-record")
        expect(await fs.readFile(failurePath, "utf8")).toBe("prior evidence");
      else
        await expect(fs.lstat(failurePath)).rejects.toMatchObject({
          code: "ENOENT",
        });
    },
  );

  it("syncs directories after publishing Node and renaming the plist and receipt", async () => {
    const v = await fixture(),
      actual = await vi.importActual<typeof fs>("node:fs/promises");
    const events: string[] = [];
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (
        [v.root, dirname(v.node), dirname(v.plist)].includes(String(args[0]))
      ) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          events.push(`sync:${String(args[0])}`);
        };
      }
      return handle;
    });
    vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
      await actual.rename(source, destination);
      events.push(
        destination === v.plist ? "plist-renamed" : "receipt-renamed",
      );
    });
    const original = v.run.getMockImplementation()!;
    v.run.mockImplementation(async (command, args, stdin) => {
      if (command === v.node) events.push("private-version");
      return original(command, args, stdin);
    });
    await runtimeDependency(v.input, v.options);
    expect(events).toEqual([
      `sync:${v.root}`,
      `sync:${dirname(v.node)}`,
      "private-version",
      "plist-renamed",
      `sync:${dirname(v.plist)}`,
      "receipt-renamed",
      `sync:${dirname(v.node)}`,
    ]);
  });

  it("reports a failed post-mkdir ownership check without writing failure evidence to an unverified directory", async () => {
    const v = await fixture(),
      actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.lstat).mockImplementation(async (...args) => {
      const info = await actual.lstat(...args);
      if (args[0] === dirname(v.node))
        Object.assign(info, { uid: process.getuid!() + 1 });
      return info;
    });
    await expect(runtimeDependency(v.input, v.options)).rejects.toMatchObject({
      report: {
        causeCode: "E_DIRECTORY",
        loadedJobChanged: false,
        plistPointerChanged: false,
        failureRecordWritten: false,
      },
    });
    expect(await fs.readFile(v.plist, "utf8")).toBe(v.text);
    expect(await fs.readdir(dirname(v.node))).toEqual([]);
  });

  it("reports the changed pointer when syncing the plist directory fails", async () => {
    const v = await fixture(),
      actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (args[0] === dirname(v.plist))
        handle.sync = async () => {
          throw new Error("sync failed");
        };
      return handle;
    });
    await expect(runtimeDependency(v.input, v.options)).rejects.toMatchObject({
      report: {
        diskPrepared: false,
        loadedJobChanged: false,
        plistPointerChanged: true,
        failureRecordWritten: true,
      },
    });
    expect(await fs.readFile(v.plist, "utf8")).toBe(
      v.text.replace(v.source, v.node),
    );
    expect(
      JSON.parse(
        await fs.readFile(join(v.root, "runtime/failure.json"), "utf8"),
      ),
    ).toMatchObject({ plistPointerChanged: true });
  });
});
