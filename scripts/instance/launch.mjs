import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InstanceError,
  acquireLock,
  nativePlan,
  releaseLock,
  validatePreparedRoot,
} from "./contract.mjs";

export function installationRoot(url = import.meta.url) {
  return dirname(dirname(fileURLToPath(url)));
}

export function parseLaunchArguments(arguments_) {
  if (arguments_.length === 1 && arguments_[0] === "--check") return "check";
  if (arguments_.length === 1 && arguments_[0] === "--serve") return "serve";
  throw new InstanceError("E_ARGUMENT");
}

export async function check(root = installationRoot(), validationOptions = {}) {
  await validatePreparedRoot(root, validationOptions);
  return {
    prepared: true,
    activationReady: false,
    port: 4096,
    temporary: true,
  };
}

export async function serve(
  root = installationRoot(),
  spawnChild = spawn,
  validationOptions = {},
  runtime = { platform: process.platform, arch: process.arch },
) {
  if (runtime.platform !== "darwin" || runtime.arch !== "arm64")
    throw new InstanceError("E_PLATFORM");
  const prepared = await validatePreparedRoot(root, {
    ...validationOptions,
    requireActivation: true,
  });
  const secret = prepared.secret;
  let lock;
  let child;
  let childExited = false;
  let childFailed = false;
  let pendingSignal;
  const forward = (signal) => {
    pendingSignal = signal;
    if (!childExited && child?.pid !== undefined) child.kill(signal);
  };
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const oldMask = process.umask(0o077);
  try {
    lock = await acquireLock(prepared.root);
    if (pendingSignal) throw new InstanceError("E_CANCELLED");
    const plan = nativePlan(prepared.root, secret, prepared.manifest.userHome);
    child = spawnChild(plan.executable, plan.arguments, {
      cwd: plan.cwd,
      env: plan.env,
      // Do not append unfiltered child output to launcher logs. Native's own
      // private application logs are not redacted by this launcher.
      stdio: "ignore",
    });
    const code = await new Promise((resolvePromise, reject) => {
      child.once("error", () => {
        childFailed = true;
        if (child.pid === undefined) reject(new InstanceError("E_NATIVE"));
        // A started child still owns the lock until its exit event.
        else child.kill("SIGTERM");
      });
      child.once("exit", (exitCode) => {
        childExited = true;
        resolvePromise(exitCode ?? 1);
      });
      if (pendingSignal && child.pid !== undefined) child.kill(pendingSignal);
    });
    if (code !== 0 || childFailed) throw new InstanceError("E_NATIVE");
  } catch (error) {
    if (error instanceof InstanceError) throw error;
    throw new InstanceError("E_NATIVE");
  } finally {
    try {
      if (lock) await releaseLock(lock);
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
      process.umask(oldMask);
    }
  }
}

export async function main(arguments_ = process.argv.slice(2)) {
  const mode = parseLaunchArguments(arguments_);
  if (mode === "check") {
    const status = await check();
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  await serve();
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `instance-launch: ${error instanceof InstanceError ? error.code : "E_LAUNCH"}\n`,
    );
    process.exitCode = 1;
  });
}
