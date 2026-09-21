import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rmdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function fail(message) {
  throw new Error(message);
}

export function parseArguments(arguments_) {
  let output;
  let allowDirty = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--out") {
      if (output !== undefined || index + 1 === arguments_.length) {
        fail("--out requires exactly one destination");
      }
      output = arguments_[index + 1];
      index += 1;
    } else if (argument === "--allow-dirty") {
      if (allowDirty) {
        fail("--allow-dirty may be specified only once");
      }
      allowDirty = true;
    } else {
      fail("unknown argument");
    }
  }

  if (output === undefined) {
    fail("--out is required");
  }
  if (!isAbsolute(output)) {
    fail("--out must be an absolute path");
  }
  return { allowDirty, output };
}

export function isWithin(candidate, directory) {
  const path = relative(directory, candidate);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

function isMissing(error) {
  return typeof error === "object" && error !== null && error.code === "ENOENT";
}

async function canonicalLocation(path) {
  const missing = [];
  let current = resolve(path);
  while (true) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if (!isMissing(error) || dirname(current) === current) throw error;
      missing.push(basename(current));
      current = dirname(current);
    }
  }
}

async function outputPath(destination) {
  const output = resolve(destination);
  const parent = dirname(output);
  let parentInfo;
  try {
    parentInfo = await stat(parent);
  } catch {
    fail("--out parent directory must already exist");
  }
  if (!parentInfo.isDirectory()) {
    fail("--out parent must be a directory");
  }

  const canonicalOutput = join(await realpath(parent), basename(output));
  const [canonicalRoot, canonicalHome] = await Promise.all([
    realpath(root),
    realpath(homedir()),
  ]);
  const protectedRoots = await Promise.all(
    [
      ...[
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "XDG_CACHE_HOME",
        "OPENCODE_CONFIG_DIR",
      ]
        .map((key) => process.env[key])
        .filter((path) => path != null && isAbsolute(path)),
      "/etc",
      "/var/lib",
      "/var/cache",
      "/Library/LaunchAgents",
      "/Library/LaunchDaemons",
      "/System/Library/LaunchAgents",
      "/System/Library/LaunchDaemons",
      "/usr/lib/systemd",
      "/usr/local/lib/systemd",
    ].map(canonicalLocation),
  );
  validateOutputLocation(
    canonicalOutput,
    canonicalRoot,
    canonicalHome,
    protectedRoots,
  );
  try {
    await lstat(canonicalOutput);
    fail("--out destination already exists; choose a new path");
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  return canonicalOutput;
}

export function validateOutputLocation(
  output,
  repository,
  home,
  protectedRoots = [],
) {
  if (dirname(output) === output) {
    fail("--out must not be a filesystem root");
  }
  if (isWithin(output, repository)) {
    fail("--out must be outside the repository");
  }
  if (isWithin(output, home)) {
    fail(
      "--out must not be inside the user home, config, data, or service paths",
    );
  }
  if (protectedRoots.some((path) => isWithin(output, path)))
    fail(
      "--out must not be inside configured or system config/data/service paths",
    );
}

function command(command_, arguments_, options = {}) {
  const result = spawnSync(command_, arguments_, {
    cwd: root,
    encoding: "utf8",
    timeout: options.timeout,
    ...options,
  });
  if (result.error) {
    fail(result.error.message);
  }
  return result;
}

function git(arguments_) {
  const result = command("git", arguments_, { timeout: 30_000 });
  if (result.status !== 0) {
    fail(result.error?.message || result.stderr.trim() || "git command failed");
  }
  return result.stdout.trim();
}

function runPnpm(arguments_) {
  const result = command("pnpm", arguments_, {
    stdio: "inherit",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    fail(`pnpm ${arguments_.join(" ")} failed`);
  }
}

async function hashFile(file) {
  const contents = await readFile(file);
  return {
    bytes: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

async function requiredInput(file) {
  const input = await lstat(file);
  if (!input.isFile() || input.isSymbolicLink()) {
    fail(`required package input is not a regular file: ${file}`);
  }
}

async function sourceIdentity() {
  const lockfile = join(root, "pnpm-lock.yaml");
  await requiredInput(lockfile);
  return {
    commit: git(["rev-parse", "HEAD"]),
    tree: git(["rev-parse", "HEAD^{tree}"]),
    lockfile_sha256: (await hashFile(lockfile)).sha256,
  };
}

function identitiesMatch(first, second) {
  return (
    first.commit === second.commit &&
    first.tree === second.tree &&
    first.lockfile_sha256 === second.lockfile_sha256
  );
}

async function packageBundles(staging, dirty, identity) {
  const files = [
    ["plugin/dist/reflection.js", "v1/reflection.js"],
    ["packages/opencode-v2-plugin/dist/reflection-v2.js", "v2/index.js"],
    [
      "plugin/delivery/reflection-v1.example.json",
      "examples/reflection-v1.example.json",
    ],
    [
      "plugin/delivery/reflection-v2.example.json",
      "examples/reflection-v2.example.json",
    ],
    [
      "plugin/delivery/opencode-v2.example.json",
      "examples/opencode-v2.example.json",
    ],
  ];

  for (const [source, destination] of files) {
    const sourcePath = join(root, source);
    await requiredInput(sourcePath);
    const destinationPath = join(staging, destination);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }

  const checksums = {};
  for (const [, destination] of files) {
    checksums[destination] = await hashFile(join(staging, destination));
  }

  const manifest = {
    format: 1,
    dirty,
    git: identity,
    artifact_file_count: files.length + 1,
    checksummed_file_count: files.length,
    files: checksums,
  };
  await writeFile(
    join(staging, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function main() {
  const { allowDirty, output } = parseArguments(process.argv.slice(2));
  const destination = await outputPath(output);
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "" && !allowDirty) {
    fail(
      "working tree is not clean; use --allow-dirty only for development packages",
    );
  }
  const identity = await sourceIdentity();

  const lock = `${destination}.lock`;
  try {
    await mkdir(lock);
  } catch {
    fail("package destination is reserved by another package operation");
  }

  let staging;
  try {
    staging = await mkdtemp(
      join(dirname(destination), `.${basename(destination)}.staging-`),
    );
    runPnpm(["--filter", "opencode-reflection-plugin", "build"]);
    runPnpm(["verify:plugin-bundle"]);
    runPnpm(["--filter", "@reflection/opencode-v2-plugin", "build"]);
    runPnpm(["verify:v2-plugin-bundle"]);
    const finalIdentity = await sourceIdentity();
    if (!identitiesMatch(identity, finalIdentity)) {
      fail("source identity changed during build; artifact was not published");
    }
    const finalStatus = git([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (finalStatus !== "" && !allowDirty) {
      fail("build changed the working tree; artifact was not published");
    }
    await packageBundles(staging, allowDirty || finalStatus !== "", identity);

    try {
      await lstat(destination);
      fail(
        "--out destination appeared while packaging; artifact was not published",
      );
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    await rename(staging, destination);
    staging = undefined;
  } finally {
    if (staging !== undefined) {
      await rm(staging, { recursive: true, force: true });
    }
    await rmdir(lock);
  }
}

const invokedPath = process.argv[1]
  ? await realpath(process.argv[1]).catch(() => undefined)
  : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `package-opencode: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
