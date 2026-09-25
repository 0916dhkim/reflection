import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { userInfo } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const NODE_SHA256 =
  "e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b";
export const PLIST_SHA256 =
  "48dc9d8f3da69ccf26c8fdfee8ccb6199e36463d7fd25cb2e4b7780fbe2db7b0";
const ASSETS = {
  "bin/opencode":
    "80fb8f312afa53182fbddc1230fe7937ba4b8ec2c5bf1de97510092919662196",
  "plugins/reflection-v2/index.js":
    "b1ea10f28f583720b023d2f0c62f6d61d5adc896d61cb057dfc8769d653bcb23",
  "bin/launch.mjs":
    "8d79a76f94537f17a70977fc0cadd6d6c268b1c2603a9968f8916de1718422b6",
  "bin/contract.mjs":
    "1f53a8d802f2d5a55987489dbff43544708d07502a75e240a78a6b2abd3e13cc",
};
const MAX = 256 * 1024 * 1024;
const fail = (code) => {
  throw new Error(code);
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) =>
  ["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode", "uid", "nlink"].every(
    (key) => a[key] === b[key],
  );
const within = (path, root) =>
  path === root ||
  (!relative(root, path).startsWith("..") && !isAbsolute(relative(root, path)));
const exec = promisify(execFile);
async function execute(command, args, input) {
  const options = {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
  };
  if (input === undefined) return exec(command, args, options);
  return new Promise((resolvePromise, reject) => {
    const child = execFile(command, args, options, (error, stdout, stderr) =>
      error
        ? reject(new Error("E_METADATA"))
        : resolvePromise({ stdout, stderr }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// Parse semantically, but replace only the first argument's XML text. Never log plist bytes.
const PLIST = `import sys,json,plistlib,xml.etree.ElementTree as ET,re
from xml.sax.saxutils import escape
x=json.load(sys.stdin); text=x['text']; root=x['root']
assert '<!ENTITY' not in text
tree=ET.fromstring(text)
for d in tree.iter('dict'):
    children=list(d); keys=[c.text for c in children[::2]]
    assert len(children)%2==0 and all(c.tag=='key' for c in children[::2]) and len(keys)==len(set(keys))
p=plistlib.loads(text.encode()); source=p['ProgramArguments'][0]
assert isinstance(source,str) and (x['source'] is None or source==x['source'])
expected={'Label':'com.opencode.v2.serve','ProgramArguments':[source,root+'/bin/launch.mjs','--serve'],'WorkingDirectory':root+'/workspace','StandardOutPath':root+'/logs/launcher.log','StandardErrorPath':root+'/logs/stderr.log','Umask':63,'RunAtLoad':True,'KeepAlive':{'SuccessfulExit':False},'ThrottleInterval':15}
assert p==expected
pattern=r'(<key>ProgramArguments</key>\\s*<array>\\s*<string>)'+re.escape(escape(source))+r'(</string>)'
candidate,n=re.subn(pattern,lambda m:m[1]+escape(x['destination'])+m[2],text)
assert n==1
expected['ProgramArguments'][0]=x['destination']
assert plistlib.loads(candidate.encode())==expected
print(json.dumps({'source':source,'candidate':candidate}))`;

export function parseArguments(args, home = userInfo().homedir) {
  const values = {};
  let apply = false;
  let mode;
  const names = [
    "root",
    "source",
    "plist",
    "expected-node-sha256",
    "expected-plist-sha256",
    "helper-revision",
    "expected-version",
  ];
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, "");
    if (args[i] === "--apply" || args[i] === "--inspect") {
      if (mode) fail("E_ARGUMENT");
      mode = name;
      apply = name === "apply";
    } else {
      if (
        args[i] !== `--${name}` ||
        !names.includes(name) ||
        values[name] !== undefined ||
        !args[i + 1] ||
        args[i + 1].startsWith("--")
      )
        fail("E_ARGUMENT");
      values[name] = args[++i];
    }
  }
  if (
    apply &&
    [
      "root",
      "source",
      "plist",
      "expected-node-sha256",
      "expected-plist-sha256",
      "helper-revision",
    ].some((key) => !values[key])
  )
    fail("E_ARGUMENT");
  return {
    apply,
    root: values.root ?? join(home, ".local/share/opencode-v2-instance"),
    source: values.source,
    plist:
      values.plist ??
      join(home, "Library/LaunchAgents/com.opencode.v2.serve.plist"),
    nodeSha256: values["expected-node-sha256"] ?? NODE_SHA256,
    plistSha256: values["expected-plist-sha256"] ?? PLIST_SHA256,
    revision: values["helper-revision"],
    version: values["expected-version"] ?? "24.21.0",
  };
}

// Bounded descriptor reads also detect source growth/replacement. Source hardlinks are read-only.
async function snapshot(
  path,
  { source = false, text = false, limit = MAX, destination, mode = 0o600 } = {},
) {
  const before = await fs.lstat(path);
  if (
    !before.isFile() ||
    before.uid !== process.getuid() ||
    (source
      ? (before.mode & 0o022) !== 0 || !(before.mode & 0o100)
      : before.nlink !== 1 || (before.mode & 0o777) !== mode) ||
    (before.mode & 0o7000) !== 0 ||
    (await fs.realpath(path)) !== path ||
    !Number.isSafeInteger(before.size) ||
    before.size < 0 ||
    before.size > limit
  )
    fail("E_FILE");
  const handle = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!same(before, await handle.stat())) fail("E_CHANGED");
    const hash = createHash("sha256"),
      parts = [],
      buffer = Buffer.alloc(Math.min(1024 * 1024, before.size));
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset,
      );
      if (!bytesRead) fail("E_CHANGED");
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes);
      if (text) parts.push(Buffer.from(bytes));
      if (destination) await destination.writeFile(bytes);
      offset += bytesRead;
    }
    if (
      !same(before, await handle.stat()) ||
      !same(before, await fs.lstat(path))
    )
      fail("E_CHANGED");
    const bytes = text ? Buffer.concat(parts) : undefined;
    if (bytes && !Buffer.from(bytes.toString("utf8")).equals(bytes))
      fail("E_ENCODING");
    return {
      sha256: hash.digest("hex"),
      stat: before,
      ...(text ? { text: bytes.toString("utf8") } : {}),
    };
  } finally {
    await handle.close();
  }
}

async function create(path, bytes, mode = 0o600) {
  const handle = await fs.open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode,
  );
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path) {
  const handle = await fs.open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function metadata(path, run, before) {
  const signature = await run("/usr/bin/codesign", ["-d", "--verbose=4", path]);
  if (
    !/^Authority=Developer ID Application: Node.js Foundation \(HX7739G8FX\)$/m.test(
      signature.stderr,
    ) ||
    !/^TeamIdentifier=HX7739G8FX$/m.test(signature.stderr) ||
    !/^Format=Mach-O thin \(arm64\)$/m.test(signature.stderr)
  )
    fail("E_SIGNATURE");
  await run("/usr/bin/codesign", ["--verify", "--strict", path]);
  const libraries = (await run("/usr/bin/otool", ["-L", path])).stdout
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" (compatibility version")[0]);
  const allowed = [
    "/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation",
    "/System/Library/Frameworks/Security.framework/Versions/A/Security",
    "/usr/lib/libc++.1.dylib",
    "/usr/lib/libSystem.B.dylib",
  ];
  if (!libraries.length || libraries.some((path) => !allowed.includes(path)))
    fail("E_DEPENDENCY");
  if (!same(before, await fs.lstat(path))) fail("E_CHANGED");
  return {
    signer: "Node.js Foundation",
    team: "HX7739G8FX",
    platform: "darwin",
    arch: "arm64",
    libraries,
  };
}

// Injection is for synthetic fixtures only; no CLI or environment verification bypass exists.
export async function runtimeDependency(
  input,
  {
    home = userInfo().homedir,
    run = execute,
    assets = ASSETS,
    platform = process.platform,
  } = {},
) {
  const { root, plist, apply, version, revision } = input;
  if (
    platform !== "darwin" ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    ![input.nodeSha256, input.plistSha256].every((value) =>
      /^[a-f0-9]{64}$/.test(value),
    ) ||
    (apply && (!input.source || !/^[a-f0-9]{7,40}$/.test(revision ?? "")))
  )
    fail("E_ARGUMENT");
  if (
    ![root, plist, home].every(
      (path) => isAbsolute(path) && resolve(path) === path,
    ) ||
    plist !== join(home, "Library/LaunchAgents/com.opencode.v2.serve.plist") ||
    root === home ||
    !within(root, home)
  )
    fail("E_LOCATION");
  for (const forbidden of [
    ".opencode",
    ".config",
    ".local/share/opencode",
    ".cache/opencode",
    ".local/state/opencode",
    "Library/pnpm",
    "Library/LaunchAgents",
  ]) {
    const path = join(home, forbidden);
    if (within(root, path) || within(path, root)) fail("E_LOCATION");
  }
  const parents = new Map();
  for (const start of [
    root,
    dirname(plist),
    join(root, "bin"),
    join(root, "plugins/reflection-v2"),
  ]) {
    for (let path = start; ; path = dirname(path)) {
      const info = await fs.lstat(path);
      if (
        !info.isDirectory() ||
        info.uid !== process.getuid() ||
        (info.mode & 0o022) !== 0 ||
        (within(path, root) && (info.mode & 0o777) !== 0o700)
      )
        fail("E_DIRECTORY");
      parents.set(path, info);
      if (path === home) break;
    }
  }
  const checkParents = async () => {
    for (const [path, before] of parents) {
      const after = await fs.lstat(path);
      if (
        !after.isDirectory() ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.uid !== before.uid ||
        after.mode !== before.mode
      )
        fail("E_DIRECTORY");
    }
  };
  const manifest = await snapshot(join(root, "manifest.json"), {
    text: true,
    limit: 1024 * 1024,
  });
  const value = JSON.parse(manifest.text);
  if (
    value.format !== 1 ||
    value.purpose !== "temporary-coexistence" ||
    value.nativeVersion !== "2.0.8" ||
    value.userHome !== home ||
    value.platform !== "darwin" ||
    value.arch !== "arm64" ||
    value.port !== 4096 ||
    value.hostname !== "127.0.0.1" ||
    value.activation !== "blocked" ||
    value.relocation !== "explicit-rebind-required" ||
    value.sourceIds?.v1 !== "danny-opencode-v1" ||
    value.sourceIds?.v2 !== "danny-opencode-v2" ||
    JSON.stringify(value.assets) !==
      JSON.stringify(
        Object.entries(assets).map(([path, sha256]) => ({
          path,
          sha256,
          executable: ["bin/opencode", "bin/launch.mjs"].includes(path),
        })),
      )
  )
    fail("E_MANIFEST");
  const invariants = { "manifest.json": manifest.sha256, ...assets };
  const checkPublicFiles = async () => {
    for (const [path, expected] of Object.entries(invariants))
      if (
        (
          await snapshot(join(root, path), {
            mode: ["bin/opencode", "bin/launch.mjs"].includes(path)
              ? 0o700
              : 0o600,
          })
        ).sha256 !== expected
      )
        fail("E_ASSET");
  };
  await checkPublicFiles();
  const old = await snapshot(plist, { text: true, limit: 1024 * 1024 });
  if ((old.stat.mode & 0o777) !== 0o600 || old.sha256 !== input.plistSha256)
    fail("E_PLIST");
  const runtime = join(root, "runtime"),
    node = join(runtime, "node"),
    receiptPath = join(runtime, "runtime-dependency.json");
  const parsed = JSON.parse(
    (
      await run(
        "/usr/bin/python3",
        ["-I", "-c", PLIST],
        JSON.stringify({
          text: old.text,
          root,
          source: input.source ?? null,
          destination: node,
        }),
      )
    ).stdout,
  );
  const source = parsed.source;
  if (
    !isAbsolute(source) ||
    basename(source) !== "node" ||
    within(source, root)
  )
    fail("E_SOURCE");
  const original = await snapshot(source, { source: true });
  if (original.sha256 !== input.nodeSha256) fail("E_NODE_HASH");
  const provenance = await metadata(source, run, original.stat);
  if (!same(original.stat, await fs.lstat(source))) fail("E_CHANGED");
  const report = {
    diskPrepared: false,
    loadedJobChanged: false,
    userReloadRequired: true,
    nodeVersion: version,
    versionVerification: "pending-private-copy",
    nodeSha256: original.sha256,
    oldPlistSha: old.sha256,
    newPlistSha: sha(parsed.candidate),
    receiptPath,
  };
  const existing = await fs.lstat(runtime).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (existing) fail("E_EXISTS");
  if (!apply) return { ...report, inspected: true };
  await checkParents();
  const receipt = {
    format: 1,
    state: "staged",
    ...report,
    root,
    source,
    destination: node,
    sourceSize: original.stat.size,
    ...provenance,
    helperRevision: revision,
    createdAt: new Date().toISOString(),
    backupPath: join(runtime, "launchagent.before.plist"),
    integrity: "operational-provenance-only; not checked by launcher",
  };
  let pointerChanged = false;
  try {
    await fs.mkdir(runtime, { mode: 0o700 });
    const runtimeInfo = await fs.lstat(runtime);
    if (
      !runtimeInfo.isDirectory() ||
      runtimeInfo.uid !== process.getuid() ||
      (runtimeInfo.mode & 0o777) !== 0o700
    )
      fail("E_DIRECTORY");
    parents.set(runtime, runtimeInfo);
    await checkParents();
    await syncDirectory(root);
    await create(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    const stagedReceipt = await snapshot(receiptPath);
    await create(receipt.backupPath, old.text);
    const staged = join(runtime, ".node-stage");
    const handle = await fs.open(
      staged,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const copied = await snapshot(source, {
        source: true,
        destination: handle,
      });
      if (
        copied.sha256 !== original.sha256 ||
        !same(copied.stat, original.stat)
      )
        fail("E_CHANGED");
      await handle.chmod(0o700);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await snapshot(staged, { mode: 0o700 })).sha256 !== original.sha256)
      fail("E_NODE_HASH");
    await checkParents();
    // link publishes exclusively; unlink the staging name before validation/use (nlink=1).
    await fs.link(staged, node);
    await fs.unlink(staged);
    await syncDirectory(runtime);
    const publishedNode = await snapshot(node, { mode: 0o700 });
    if (publishedNode.sha256 !== original.sha256) fail("E_NODE_HASH");
    await metadata(node, run, publishedNode.stat);
    await checkParents();
    // Never execute the public source path; only this verified private copy.
    if ((await run(node, ["--version"])).stdout.trim() !== `v${version}`)
      fail("E_VERSION");
    const verifiedNode = await snapshot(node, { mode: 0o700 });
    if (verifiedNode.sha256 !== original.sha256) fail("E_NODE_HASH");
    report.versionVerification = "verified-private-copy";
    const candidatePath = join(
      dirname(plist),
      `.com.opencode.v2.serve.${randomUUID()}.plist`,
    );
    await create(candidatePath, parsed.candidate);
    const candidate = await snapshot(candidatePath);
    if (candidate.sha256 !== report.newPlistSha) fail("E_PLIST");
    await checkPublicFiles();
    await checkParents();
    const current = await snapshot(plist);
    if (
      !same(old.stat, current.stat) ||
      current.sha256 !== old.sha256 ||
      !same(verifiedNode.stat, await fs.lstat(node)) ||
      !same(candidate.stat, await fs.lstat(candidatePath)) ||
      !same(original.stat, await fs.lstat(source))
    )
      fail("E_CHANGED");
    if (
      (await snapshot(receipt.backupPath)).sha256 !== old.sha256 ||
      !same(stagedReceipt.stat, (await snapshot(receiptPath)).stat)
    )
      fail("E_CHANGED");
    // Guarded atomic replacement, not a sandbox against concurrent same-UID writers.
    await fs.rename(candidatePath, plist);
    pointerChanged = true;
    await checkParents();
    await syncDirectory(dirname(plist));
    await checkPublicFiles();
    if ((await snapshot(plist)).sha256 !== report.newPlistSha) fail("E_PLIST");
    if (!same(verifiedNode.stat, (await snapshot(node, { mode: 0o700 })).stat))
      fail("E_CHANGED");
    const finalReceipt = join(runtime, ".receipt-complete");
    await create(
      finalReceipt,
      JSON.stringify(
        { ...receipt, ...report, state: "disk-prepared", diskPrepared: true },
        null,
        2,
      ) + "\n",
    );
    await checkParents();
    if (!same(stagedReceipt.stat, (await snapshot(receiptPath)).stat))
      fail("E_CHANGED");
    await fs.rename(finalReceipt, receiptPath);
    await syncDirectory(runtime);
    return { ...report, diskPrepared: true };
  } catch (cause) {
    const error = new Error("E_APPLY_INCOMPLETE");
    error.report = {
      ...report,
      diskPrepared: false,
      plistPointerChanged: pointerChanged,
      incomplete: true,
      causeCode: /^E_[A-Z_]+$/.test(cause.message) ? cause.message : "E_IO",
      failureRecordWritten: false,
    };
    // Best-effort evidence, never overwrite a prior record or write through changed parents.
    try {
      if (!parents.has(runtime)) fail("E_DIRECTORY");
      await checkParents();
      await create(
        join(runtime, "failure.json"),
        JSON.stringify(
          { ...error.report, failureRecordWritten: undefined },
          null,
          2,
        ) + "\n",
      );
      await syncDirectory(runtime);
      error.report.failureRecordWritten = true;
    } catch {
      /* The in-memory report remains authoritative for this invocation. */
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  (await fs.realpath(resolve(process.argv[1])).catch(() => undefined)) ===
    fileURLToPath(import.meta.url)
) {
  Promise.resolve()
    .then(() => runtimeDependency(parseArguments(process.argv.slice(2))))
    .then((report) => console.log(JSON.stringify(report)))
    .catch((error) => {
      console.error(
        JSON.stringify({
          error: /^E_[A-Z_]+$/.test(error.message)
            ? error.message
            : "E_RUNTIME_DEPENDENCY",
          ...(error.report ?? {}),
          loadedJobChanged: false,
        }),
      );
      process.exitCode = 1;
    });
}
