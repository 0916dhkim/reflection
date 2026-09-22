import { open, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  NATIVE_SHA256,
  REFLECTION_V2_SHA256,
  ASSETS,
  ASSET_MAX_BYTES,
  InstanceError,
  fail,
  preparedManifest,
  privateMode,
  requiredDirectories,
  sha256File,
  sameFileSnapshot,
  validateLocation,
} from "./contract.mjs";

function parseArguments(arguments_) {
  const values = {};
  const accepted = new Set(["--root", "--user-home", "--binary", "--bundle"]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (
      !accepted.has(flag) ||
      values[flag] !== undefined ||
      index + 1 >= arguments_.length
    )
      fail("E_ARGUMENT");
    values[flag] = arguments_[index + 1];
    index += 1;
  }
  if (
    Object.keys(values).length !== accepted.size ||
    Object.values(values).some((value) => !isAbsolute(value))
  )
    fail("E_ARGUMENT");
  return {
    root: values["--root"],
    userHome: values["--user-home"],
    binary: values["--binary"],
    bundle: values["--bundle"],
  };
}

async function source(path, expectedHash, maxBytes) {
  const info = await lstat(path).catch(() => fail("E_SOURCE"));
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid()
  )
    fail("E_SOURCE");
  const hash = await sha256File(path, maxBytes).catch(() => fail("E_SOURCE"));
  if (expectedHash !== undefined && hash !== expectedHash) fail("E_SOURCE");
  return hash;
}

async function rootLocation(root, userHome, expectedHome) {
  const location = await validateLocation(root, userHome, expectedHome);
  try {
    await lstat(root);
    fail("E_EXISTS");
  } catch (error) {
    if (error?.code !== "ENOENT") fail("E_EXISTS");
  }
  return location;
}

export async function prepareInstance(input, hashes = {}) {
  const location = await rootLocation(
    input.root,
    input.userHome,
    hashes.expectedHome,
  );
  const thisFile = fileURLToPath(new URL("./launch.mjs", import.meta.url));
  const contractFile = fileURLToPath(
    new URL("./contract.mjs", import.meta.url),
  );
  const sourceHashes = {
    "bin/opencode": await source(
      input.binary,
      hashes.binary ?? NATIVE_SHA256,
      ASSET_MAX_BYTES["bin/opencode"],
    ),
    "plugins/reflection-v2/index.js": await source(
      input.bundle,
      hashes.bundle ?? REFLECTION_V2_SHA256,
      ASSET_MAX_BYTES["plugins/reflection-v2/index.js"],
    ),
    "bin/launch.mjs": await source(
      thisFile,
      undefined,
      ASSET_MAX_BYTES["bin/launch.mjs"],
    ),
    "bin/contract.mjs": await source(
      contractFile,
      undefined,
      ASSET_MAX_BYTES["bin/contract.mjs"],
    ),
  };
  let created = false;
  const directories = new Map();
  const files = new Map();
  // Node has no openat/renameat/unlinkat API. These bounded identity checks
  // detect replacement, but are not atomic against an adversarial same-UID
  // process swapping a parent between the check and path-based open/mkdir.
  const assertDirectories = async () => {
    await validateLocation(location.root, location.home, hashes.expectedHome);
    if ((await realpath(location.root)) !== location.root) fail("E_ROOT");
    for (const [path, original] of directories) {
      const current = await lstat(path);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.ino !== original.ino ||
        current.dev !== original.dev ||
        current.uid !== process.getuid() ||
        (current.mode & 0o777) !== 0o700
      )
        fail("E_ROOT");
    }
  };
  const assertFile = async (path, original, executable) => {
    const current = await lstat(path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.ino !== original.ino ||
      current.dev !== original.dev ||
      current.uid !== process.getuid() ||
      !privateMode(current.mode, executable)
    )
      fail("E_COPY");
  };
  const writeManaged = async (
    path,
    sourcePath,
    text,
    executable,
    expectedHash,
    maxBytes = 1024 * 1024,
  ) => {
    let inputHandle, outputHandle;
    let inputInfo;
    try {
      if (sourcePath) {
        inputHandle = await open(
          sourcePath,
          constants.O_RDONLY |
            constants.O_NONBLOCK |
            (constants.O_NOFOLLOW ?? 0),
        );
        inputInfo = await inputHandle.stat();
        if (
          !inputInfo.isFile() ||
          inputInfo.nlink !== 1 ||
          inputInfo.uid !== process.getuid() ||
          !Number.isSafeInteger(inputInfo.size) ||
          inputInfo.size < 0 ||
          inputInfo.size > maxBytes
        )
          fail("E_SOURCE");
      }
      await assertDirectories();
      outputHandle = await open(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_RDWR |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const original = await outputHandle.stat();
      await assertDirectories();
      await assertFile(path, original, false);
      const buffer = inputHandle
        ? Buffer.alloc(1024 * 1024)
        : Buffer.from(text);
      let position = 0;
      const size = inputInfo?.size ?? buffer.length;
      if (size > maxBytes) fail("E_COPY");
      while (position < size) {
        const bytesRead = inputHandle
          ? (
              await inputHandle.read(
                buffer,
                0,
                Math.min(buffer.length, size - position),
                position,
              )
            ).bytesRead
          : position === 0
            ? buffer.length
            : 0;
        if (bytesRead === 0) fail("E_COPY");
        let offset = 0;
        while (offset < bytesRead) {
          await assertDirectories();
          await assertFile(path, original, false);
          const { bytesWritten } = await outputHandle.write(
            buffer,
            offset,
            bytesRead - offset,
            position + offset,
          );
          if (bytesWritten <= 0) fail("E_COPY");
          offset += bytesWritten;
          await assertDirectories();
          await assertFile(path, original, false);
        }
        position += bytesRead;
      }
      if (
        inputHandle &&
        (!sameFileSnapshot(inputInfo, await inputHandle.stat()) ||
          !sameFileSnapshot(inputInfo, await lstat(sourcePath)))
      )
        fail("E_COPY");
      // Hash the held destination descriptor, not a potentially replaced path.
      const hash = createHash("sha256");
      let readPosition = 0;
      const outputInfo = await outputHandle.stat();
      if (outputInfo.size !== size) fail("E_COPY");
      while (readPosition < size) {
        const { bytesRead } = await outputHandle.read(
          buffer,
          0,
          Math.min(buffer.length, size - readPosition),
          readPosition,
        );
        if (bytesRead === 0) fail("E_COPY");
        hash.update(buffer.subarray(0, bytesRead));
        readPosition += bytesRead;
      }
      const digest = hash.digest("hex");
      if (
        digest !== expectedHash ||
        !sameFileSnapshot(outputInfo, await outputHandle.stat())
      )
        fail("E_COPY");
      await assertDirectories();
      await assertFile(path, original, false);
      await outputHandle.chmod(executable ? 0o700 : 0o600);
      await assertDirectories();
      await assertFile(path, original, executable);
      files.set(path, { original, executable });
      return digest;
    } finally {
      try {
        await outputHandle?.close();
      } finally {
        await inputHandle?.close();
      }
    }
  };
  const writeText = (path, text) =>
    writeManaged(
      path,
      undefined,
      text,
      false,
      createHash("sha256").update(text).digest("hex"),
    );
  const makeDirectory = async (path) => {
    if (created) await assertDirectories();
    await mkdir(path, { mode: 0o700 });
    directories.set(path, await lstat(path));
    await assertDirectories();
  };
  const oldMask = process.umask(0o077);
  try {
    await makeDirectory(location.root);
    created = true;
    for (const directory of requiredDirectories()) {
      await makeDirectory(join(location.root, directory));
    }
    const inputs = {
      "bin/opencode": input.binary,
      "plugins/reflection-v2/index.js": input.bundle,
      "bin/launch.mjs": thisFile,
      "bin/contract.mjs": contractFile,
    };
    const copied = {};
    for (const asset of ASSETS) {
      copied[asset.path] = await writeManaged(
        join(location.root, asset.path),
        inputs[asset.path],
        undefined,
        asset.executable,
        sourceHashes[asset.path],
        ASSET_MAX_BYTES[asset.path],
      );
      if (copied[asset.path] !== sourceHashes[asset.path]) fail("E_COPY");
    }
    const manifest = preparedManifest(
      location.root,
      location.home,
      location.forbidden,
      copied,
    );
    await writeText(
      join(location.root, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await assertDirectories();
    for (const [path, { original, executable }] of files)
      await assertFile(path, original, executable);
    return manifest;
  } catch (error) {
    if (created) {
      try {
        await writeText(join(location.root, "preparation-failed"), "failed\n");
      } catch {
        /* preserve the first failure */
      }
    }
    throw error;
  } finally {
    process.umask(oldMask);
  }
}

export { parseArguments };

async function main() {
  const manifest = await prepareInstance(parseArguments(process.argv.slice(2)));
  process.stdout.write(
    `${JSON.stringify({ status: "prepared", purpose: manifest.purpose, counts: { assets: manifest.assets.length } })}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `instance-prepare: ${error instanceof InstanceError ? error.code : "E_PREPARE"}\n`,
    );
    process.exitCode = 1;
  });
}
