import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { userInfo } from "node:os";

export const NATIVE_VERSION = "2.0.8";
export const NATIVE_SHA256 =
  "80fb8f312afa53182fbddc1230fe7937ba4b8ec2c5bf1de97510092919662196";
export const REFLECTION_V2_SHA256 =
  "44b6a726c2bb664bb84be23429cc02bd8594347389315db808a9d16da26824ee";
// Conventional paths require an explicit later migration, including persisted
// workspace/session paths. Relocatable assets alone do not migrate an instance.
export const PURPOSE = "temporary-coexistence";
export const SOURCE_IDS = { v1: "danny-opencode-v1", v2: "danny-opencode-v2" };
export const MAX_FILE_BYTES = 250 * 1024 * 1024;
export const ASSET_MAX_BYTES = {
  "bin/opencode": MAX_FILE_BYTES,
  "plugins/reflection-v2/index.js": 10 * 1024 * 1024,
  "bin/launch.mjs": 1024 * 1024,
  "bin/contract.mjs": 1024 * 1024,
};

const MANIFEST_PATHS = {
  home: "home",
  config: "config/opencode",
  nativeConfig: "config/opencode/opencode.json",
  reflectionConfig: "config/reflection-v2.json",
  userPolicy: "config/user-policy.json",
  data: "data",
  cache: "cache",
  nativeCache: "cache/opencode",
  npmCache: "cache/npm",
  pnpmHome: "data/pnpm",
  state: "state",
  nativeState: "state/opencode",
  secrets: "secrets",
  tmp: "tmp",
  database: "data/opencode/opencode.db",
  runtime: "run",
  pty: "run/pty",
  workspace: "workspace",
};

export const ASSETS = [
  { path: "bin/opencode", sha256: NATIVE_SHA256, executable: true },
  {
    path: "plugins/reflection-v2/index.js",
    sha256: REFLECTION_V2_SHA256,
    executable: false,
  },
  { path: "bin/launch.mjs", sha256: "", executable: true },
  { path: "bin/contract.mjs", sha256: "", executable: false },
];

export class InstanceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function fail(code) {
  throw new InstanceError(code);
}

export function isWithin(candidate, directory) {
  const path = relative(directory, candidate);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

export function overlaps(first, second) {
  return isWithin(first, second) || isWithin(second, first);
}

export function sameFileSnapshot(before, after) {
  return (
    after.isFile() &&
    ["size", "mtimeMs", "ctimeMs", "dev", "ino"].every(
      (key) => before[key] === after[key],
    )
  );
}

export async function sha256File(path, maxBytes = MAX_FILE_BYTES) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      !Number.isSafeInteger(before.size) ||
      before.size < 0 ||
      before.size > Math.min(maxBytes, MAX_FILE_BYTES)
    )
      fail("E_FILE");
    if (!sameFileSnapshot(before, await lstat(path))) fail("E_FILE");
    const hash = createHash("sha256");
    let bytes = 0;
    // end is inclusive; skip creating a stream for an empty file.
    if (before.size > 0) {
      const stream = handle.createReadStream({
        start: 0,
        end: before.size - 1,
        autoClose: false,
      });
      for await (const chunk of stream) {
        bytes += chunk.length;
        hash.update(chunk);
      }
    }
    if (
      bytes !== before.size ||
      !sameFileSnapshot(before, await handle.stat()) ||
      !sameFileSnapshot(before, await lstat(path))
    )
      fail("E_FILE");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function privateText(path, maxBytes) {
  const published = await ownedRegular(path);
  if (
    !Number.isSafeInteger(published.size) ||
    published.size < 0 ||
    published.size > maxBytes
  )
    fail("E_FILE");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (!sameFileSnapshot(published, before)) fail("E_FILE");
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) fail("E_FILE");
      offset += bytesRead;
    }
    if (
      !sameFileSnapshot(before, await handle.stat()) ||
      !sameFileSnapshot(before, await lstat(path))
    )
      fail("E_FILE");
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

export function privateMode(mode, executable = false) {
  return (mode & 0o777) === (executable ? 0o700 : 0o600);
}

export async function ownedRegular(path, executable = false) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    fail("E_FILE");
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid() ||
    !privateMode(info.mode, executable)
  ) {
    fail("E_FILE");
  }
  return info;
}

async function privateDirectory(path) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    fail("E_TREE");
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o700
  ) {
    fail("E_TREE");
  }
}

async function noSymlinkComponents(root, path) {
  const local = relative(root, path);
  if (local === "" || local.startsWith(`..${sep}`) || local === "..")
    fail("E_TREE");
  let current = root;
  await privateDirectory(current);
  for (const part of local.split(sep)) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch {
      fail("E_TREE");
    }
    if (info.isSymbolicLink()) fail("E_TREE");
  }
}

export function forbiddenRoots(home) {
  return [
    ".opencode",
    ".config/opencode",
    ".local/share/opencode",
    ".cache/opencode",
    ".local/state/opencode",
  ].map((path) => join(home, path));
}

async function resolveExisting(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT") fail("E_ROOT");
    if (
      await lstat(path).catch((error) => {
        if (error.code !== "ENOENT") fail("E_ROOT");
      })
    )
      fail("E_ROOT");
    const parent = dirname(path);
    if (parent === path) fail("E_ROOT");
    return join(await resolveExisting(parent), relative(parent, path));
  }
}

// Filesystem isolation, not a sandbox against a malicious process with the same UID.
export async function validateLocation(
  root,
  userHome,
  expectedHome = userInfo().homedir,
) {
  if (!isAbsolute(root) || !isAbsolute(userHome)) fail("E_ROOT");
  const home = await realpath(userHome).catch(() => fail("E_ROOT"));
  if (home !== (await realpath(expectedHome).catch(() => fail("E_ROOT"))))
    fail("E_ROOT");
  const canonical = await resolveExisting(root);
  const forbidden = forbiddenRoots(home);
  const resolvedForbidden = await Promise.all(forbidden.map(resolveExisting));
  if (
    canonical === home ||
    !isWithin(canonical, home) ||
    [...forbidden, ...resolvedForbidden].some((path) =>
      overlaps(canonical, path),
    )
  )
    fail("E_ROOT");
  for (let current = dirname(canonical); ; current = dirname(current)) {
    const info = await lstat(current).catch(() => fail("E_ROOT"));
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o022) !== 0
    )
      fail("E_ROOT");
    if (current === home) break;
  }
  return { root: canonical, home, forbidden };
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function stringArray(value) {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function expectedManifest(root, userHome, forbiddenRoots, assetHashes) {
  return {
    format: 1,
    purpose: PURPOSE,
    nativeVersion: NATIVE_VERSION,
    platform: "darwin",
    arch: "arm64",
    hostname: "127.0.0.1",
    port: 4096,
    sourceIds: SOURCE_IDS,
    userHome,
    forbiddenRoots,
    assets: ASSETS.map((asset) => ({
      ...asset,
      sha256: assetHashes[asset.path] ?? asset.sha256,
    })),
    paths: MANIFEST_PATHS,
    activation: "blocked",
    relocation: "explicit-rebind-required",
  };
}

export function requiredDirectories() {
  return [
    "home",
    "config",
    "config/opencode",
    "data",
    "data/opencode",
    "data/pnpm",
    "cache",
    "state",
    "cache/opencode",
    "cache/npm",
    "state/opencode",
    "secrets",
    "tmp",
    "run",
    "run/pty",
    "logs",
    "workspace",
    "plugins",
    "plugins/reflection-v2",
    "bin",
  ];
}

export async function readManifest(root) {
  await noSymlinkComponents(root, join(root, "manifest.json"));
  await ownedRegular(join(root, "manifest.json"));
  let manifest;
  try {
    manifest = JSON.parse(
      await privateText(join(root, "manifest.json"), 2 * 1024 * 1024),
    );
  } catch {
    fail("E_MANIFEST");
  }
  const keys = [
    "format",
    "purpose",
    "nativeVersion",
    "platform",
    "arch",
    "hostname",
    "port",
    "sourceIds",
    "userHome",
    "forbiddenRoots",
    "assets",
    "paths",
    "activation",
    "relocation",
  ];
  if (
    !exactKeys(manifest, keys) ||
    manifest.format !== 1 ||
    manifest.purpose !== PURPOSE ||
    manifest.nativeVersion !== NATIVE_VERSION ||
    manifest.platform !== "darwin" ||
    manifest.arch !== "arm64" ||
    manifest.hostname !== "127.0.0.1" ||
    manifest.port !== 4096 ||
    manifest.activation !== "blocked" ||
    manifest.relocation !== "explicit-rebind-required"
  )
    fail("E_MANIFEST");
  if (
    !exactKeys(manifest.sourceIds, ["v1", "v2"]) ||
    manifest.sourceIds.v1 !== SOURCE_IDS.v1 ||
    manifest.sourceIds.v2 !== SOURCE_IDS.v2 ||
    typeof manifest.userHome !== "string" ||
    !isAbsolute(manifest.userHome) ||
    !stringArray(manifest.forbiddenRoots) ||
    !manifest.forbiddenRoots.every(isAbsolute)
  )
    fail("E_MANIFEST");
  if (JSON.stringify(manifest.paths) !== JSON.stringify(MANIFEST_PATHS))
    fail("E_MANIFEST");
  if (
    JSON.stringify(manifest.forbiddenRoots) !==
    JSON.stringify(forbiddenRoots(manifest.userHome))
  )
    fail("E_MANIFEST");
  if (
    !Array.isArray(manifest.assets) ||
    manifest.assets.length !== ASSETS.length
  )
    fail("E_MANIFEST");
  for (let index = 0; index < ASSETS.length; index += 1) {
    const actual = manifest.assets[index];
    const expected = ASSETS[index];
    if (
      !exactKeys(actual, ["path", "sha256", "executable"]) ||
      actual.path !== expected.path ||
      typeof actual.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(actual.sha256) ||
      actual.executable !== expected.executable
    )
      fail("E_MANIFEST");
  }
  return manifest;
}

export async function validatePreparedRoot(root, options = {}) {
  const canonicalRoot = await realpath(root).catch(() => fail("E_ROOT"));
  const suppliedRoot = await lstat(root).catch(() => fail("E_ROOT"));
  if (!suppliedRoot.isDirectory() || suppliedRoot.isSymbolicLink())
    fail("E_ROOT");
  if (
    await lstat(join(canonicalRoot, "preparation-failed")).catch((error) => {
      if (error.code !== "ENOENT") fail("E_ROOT");
    })
  )
    fail("E_PREPARATION_FAILED");
  const manifest = await readManifest(canonicalRoot);
  await validateLocation(
    canonicalRoot,
    manifest.userHome,
    options.expectedHome,
  );
  for (const directory of requiredDirectories()) {
    const path = join(canonicalRoot, directory);
    await noSymlinkComponents(canonicalRoot, path);
    await privateDirectory(path);
  }
  const assetHashes = {};
  for (const asset of manifest.assets) {
    const path = join(canonicalRoot, asset.path);
    await noSymlinkComponents(canonicalRoot, path);
    await ownedRegular(path, asset.executable);
    assetHashes[asset.path] = await sha256File(
      path,
      ASSET_MAX_BYTES[asset.path],
    );
    const pinned =
      options.expectedAssets?.[asset.path] ??
      (asset.path === "bin/opencode"
        ? NATIVE_SHA256
        : asset.path === "plugins/reflection-v2/index.js"
          ? REFLECTION_V2_SHA256
          : asset.sha256);
    if (asset.sha256 !== pinned || assetHashes[asset.path] !== pinned)
      fail("E_ASSET");
  }
  for (const database of [
    "opencode.db",
    "opencode.db-wal",
    "opencode.db-shm",
  ]) {
    const path = join(canonicalRoot, "data/opencode", database);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      fail("E_DATABASE");
    }
    await noSymlinkComponents(canonicalRoot, path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid() ||
      !privateMode(info.mode)
    )
      fail("E_DATABASE");
  }
  for (const name of [
    "auth.json",
    "opencode-next.db",
    "opencode-next.db-wal",
    "opencode-next.db-shm",
  ]) {
    if (
      await lstat(join(canonicalRoot, "data/opencode", name)).catch((error) => {
        if (error.code !== "ENOENT") fail("E_DATABASE");
      })
    )
      fail("E_LEGACY_DATA");
  }
  for (const path of [
    MANIFEST_PATHS.nativeConfig,
    MANIFEST_PATHS.reflectionConfig,
    MANIFEST_PATHS.userPolicy,
    "secrets/web-password",
    "activation.json",
  ]) {
    if (
      await lstat(join(canonicalRoot, path)).catch((error) => {
        if (error.code !== "ENOENT") fail("E_FILE");
      })
    ) {
      await noSymlinkComponents(canonicalRoot, join(canonicalRoot, path));
      await ownedRegular(join(canonicalRoot, path));
    }
  }
  const secret =
    options.requireActivation === true
      ? await validateActivation(canonicalRoot, manifest)
      : undefined;
  return { root: canonicalRoot, manifest, assetHashes, secret };
}

export async function manifestSha256(root) {
  return sha256File(join(root, "manifest.json"));
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasPlaceholder(text) {
  return /__OPENCODE_|REPLACE_[A-Z0-9_]+|__PLACEHOLDER|<redacted>/i.test(text);
}

async function privateJson(root, relativePath) {
  const path = join(root, relativePath);
  await noSymlinkComponents(root, path);
  await ownedRegular(path);
  let text;
  try {
    text = await privateText(
      path,
      relativePath === MANIFEST_PATHS.userPolicy
        ? 1024 * 1024
        : 2 * 1024 * 1024,
    );
    if (hasPlaceholder(text)) fail("E_CONFIG");
    return {
      value: JSON.parse(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    };
  } catch (error) {
    if (error instanceof InstanceError) throw error;
    fail("E_CONFIG");
  }
}

function requiredText(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !/[\0\r\n]/.test(value) &&
    !hasPlaceholder(value)
  );
}

export function validateActiveConfig(
  root,
  nativeConfig,
  reflectionConfig,
  policy,
  secret,
) {
  // Critical binding checks only. The binding workflow must use the full 2.0.8
  // schema decoder; the pinned plugin performs full policy parsing fail-closed.
  if (
    !object(nativeConfig) ||
    Object.hasOwn(nativeConfig, "plugin") ||
    nativeConfig.compaction?.auto !== false ||
    nativeConfig.update !== "disable" ||
    !Array.isArray(nativeConfig.plugins)
  )
    fail("E_CONFIG");
  const plugins = nativeConfig.plugins;
  if (
    plugins.length !== 1 ||
    !exactKeys(plugins[0], ["package", "options"]) ||
    plugins[0].package !== join(root, "plugins/reflection-v2") ||
    !exactKeys(plugins[0].options, ["configPath", "userPolicyPath"]) ||
    plugins[0].options.configPath !== join(root, "config/reflection-v2.json") ||
    plugins[0].options.userPolicyPath !== join(root, "config/user-policy.json")
  )
    fail("E_CONFIG");
  if (
    !exactKeys(reflectionConfig, [
      "url",
      "apiKey",
      "sourceId",
      "sources",
      "contextProjection",
    ]) ||
    reflectionConfig.sourceId !== SOURCE_IDS.v2 ||
    reflectionConfig.contextProjection?.enabled !== true ||
    !requiredText(reflectionConfig.apiKey) ||
    !requiredText(reflectionConfig.url)
  )
    fail("E_CONFIG");
  let url;
  try {
    url = new URL(reflectionConfig.url);
  } catch {
    fail("E_CONFIG");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    fail("E_CONFIG");
  if (!exactKeys(reflectionConfig.sources, [SOURCE_IDS.v1, SOURCE_IDS.v2]))
    fail("E_CONFIG");
  const v1 = reflectionConfig.sources[SOURCE_IDS.v1],
    v2 = reflectionConfig.sources[SOURCE_IDS.v2];
  if (
    !exactKeys(v1, ["kind", "url"]) ||
    v1.kind !== "opencode-v1" ||
    v1.url !== "http://127.0.0.1:4097" ||
    !exactKeys(v2, ["kind", "url", "username", "password"]) ||
    v2.kind !== "opencode-v2" ||
    v2.url !== "http://127.0.0.1:4096" ||
    v2.username !== "opencode" ||
    v2.password !== secret
  )
    fail("E_CONFIG");
  if (
    !exactKeys(policy, [
      "version",
      "instructionFiles",
      "modelAllowlists",
      "geminiOpenRouterToolGuard",
    ]) ||
    policy.version !== 1 ||
    !stringArray(policy.instructionFiles) ||
    !policy.instructionFiles.every(isAbsolute) ||
    !object(policy.modelAllowlists) ||
    !Object.values(policy.modelAllowlists).every(
      (models) => stringArray(models) && models.every(requiredText),
    ) ||
    policy.geminiOpenRouterToolGuard !== true
  )
    fail("E_CONFIG");
}

export async function validateActivation(root, manifest) {
  const activationPath = join(root, "activation.json");
  await lstat(activationPath).catch((error) =>
    fail(error.code === "ENOENT" ? "E_NOT_ACTIVATED" : "E_ACTIVATION"),
  );
  await noSymlinkComponents(root, activationPath);
  await ownedRegular(activationPath);
  let activation;
  try {
    activation = JSON.parse(await privateText(activationPath, 2 * 1024 * 1024));
  } catch {
    fail("E_ACTIVATION");
  }
  if (
    !exactKeys(activation, [
      "format",
      "approved",
      "manifestSha256",
      "configSha256",
      "attestations",
    ]) ||
    activation.format !== 1 ||
    activation.approved !== true ||
    !exactKeys(activation.configSha256, [
      "nativeConfig",
      "reflectionConfig",
      "userPolicy",
    ]) ||
    !exactKeys(activation.attestations, [
      "v1PortMoved",
      "v1ReaderVerified",
      "nativeSourceRegistered",
      "accessVerified",
    ]) ||
    !Object.values(activation.attestations).every((value) => value === true)
  )
    fail("E_ACTIVATION");
  const secretDir = join(root, "secrets");
  await noSymlinkComponents(root, secretDir);
  await privateDirectory(secretDir);
  const secretPath = join(secretDir, "web-password");
  await noSymlinkComponents(root, secretPath);
  await ownedRegular(secretPath);
  let secret;
  try {
    secret = await privateText(secretPath, 256);
  } catch {
    fail("E_SECRET");
  }
  if (
    !requiredText(secret) ||
    secret.length < 16 ||
    secret.length > 256 ||
    /[\0\r\n]/.test(secret) ||
    hasPlaceholder(secret)
  )
    fail("E_SECRET");
  const [native, reflection, policy] = await Promise.all([
    privateJson(root, MANIFEST_PATHS.nativeConfig),
    privateJson(root, MANIFEST_PATHS.reflectionConfig),
    privateJson(root, MANIFEST_PATHS.userPolicy),
  ]);
  if (
    activation.manifestSha256 !== (await manifestSha256(root)) ||
    activation.configSha256.nativeConfig !== native.sha256 ||
    activation.configSha256.reflectionConfig !== reflection.sha256 ||
    activation.configSha256.userPolicy !== policy.sha256 ||
    !Object.values(activation.configSha256).every(
      (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    )
  )
    fail("E_ACTIVATION");
  validateActiveConfig(
    root,
    native.value,
    reflection.value,
    policy.value,
    secret,
  );
  // Owner attestation bound to these bytes, not live port/registration proof.
  return secret;
}

export function buildChildEnvironment(
  root,
  secret,
  userHome = userInfo().homedir,
) {
  if (!isAbsolute(userHome) || /[:\0\r\n]/.test(userHome)) fail("E_ROOT");
  return {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    TMPDIR: join(root, "tmp"),
    OPENCODE_CONFIG_DIR: join(root, "config/opencode"),
    OPENCODE_CONFIG: join(root, "config/opencode/opencode.json"),
    OPENCODE_DB: join(root, "data/opencode/opencode.db"),
    OPENCODE_PTY_RUNTIME_DIR: join(root, "run/pty"),
    XDG_RUNTIME_DIR: join(root, "run"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_CONFIG_PROJECT_DISABLE: "0",
    OPENCODE_PASSWORD: secret,
    PATH: `${join(userHome, "Library/pnpm/bin")}:${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    PNPM_HOME: join(root, "data/pnpm"),
    npm_config_cache: join(root, "cache/npm"),
    TERM: "dumb",
    LANG: "en_US.UTF-8",
  };
}

export function nativePlan(root, secret, userHome = userInfo().homedir) {
  return {
    executable: join(root, "bin/opencode"),
    arguments: ["serve", "--hostname", "127.0.0.1", "--port", "4096"],
    cwd: join(root, "workspace"),
    env: buildChildEnvironment(root, secret, userHome),
  };
}

async function checkLockParents(parents) {
  for (const [path, original] of parents) {
    await privateDirectory(path);
    const current = await lstat(path);
    if (current.dev !== original.dev || current.ino !== original.ino)
      fail("E_LOCKED");
  }
}

export async function acquireLock(root) {
  const path = join(root, "run/instance.lock");
  const parents = await Promise.all(
    [root, join(root, "run")].map(async (path) => {
      await privateDirectory(path);
      return [path, await lstat(path)];
    }),
  );
  const nonce = randomBytes(24).toString("hex");
  let handle;
  try {
    await checkLockParents(parents);
    handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch {
    fail("E_LOCKED");
  }
  try {
    const info = await handle.stat();
    await checkLockParents(parents);
    if (
      info.uid !== process.getuid() ||
      info.nlink !== 1 ||
      !privateMode(info.mode)
    )
      fail("E_LOCKED");
    await handle.writeFile(`${process.pid}:${nonce}\n`);
    await checkLockParents(parents);
    const published = await ownedRegular(path);
    if (published.ino !== info.ino || published.dev !== info.dev)
      fail("E_LOCKED");
    return { path, nonce, ino: info.ino, dev: info.dev, parents };
  } finally {
    await handle.close();
  }
}

export async function releaseLock(lock) {
  let handle;
  try {
    await checkLockParents(lock.parents);
    const info = await lstat(lock.path);
    if (
      info.isFile() &&
      !info.isSymbolicLink() &&
      info.nlink === 1 &&
      info.ino === lock.ino &&
      info.dev === lock.dev &&
      info.uid === process.getuid() &&
      privateMode(info.mode)
    ) {
      handle = await open(
        lock.path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const held = await handle.stat();
      const expected = `${process.pid}:${lock.nonce}\n`;
      if (
        held.ino !== lock.ino ||
        held.dev !== lock.dev ||
        held.size !== Buffer.byteLength(expected)
      )
        return;
      if ((await handle.readFile("utf8")) !== expected) return;
      await checkLockParents(lock.parents);
      const published = await ownedRegular(lock.path);
      if (published.ino !== lock.ino || published.dev !== lock.dev) return;
      // Node cannot atomically compare-and-unlink. Same-UID replacement between
      // this check and unlink remains outside the isolation guarantee. SIGKILL
      // can leave a stale lock; never reclaim it or signal its recorded PID.
      const { unlink } = await import("node:fs/promises");
      await unlink(lock.path);
    }
  } catch {
    /* A forged or replaced lock is intentionally left in place. */
  } finally {
    await handle?.close();
  }
}

export function preparedManifest(root, userHome, forbiddenRoots, assetHashes) {
  return expectedManifest(root, userHome, forbiddenRoots, assetHashes);
}
