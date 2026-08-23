import { spawnSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";

const [, , label, plistPath, statusPath] = process.argv;
if (
  !label ||
  !plistPath ||
  !statusPath ||
  !plistPath.startsWith("/") ||
  !statusPath.startsWith("/")
) {
  if (statusPath?.startsWith("/")) {
    writeFileSync(
      statusPath,
      `${JSON.stringify(
        {
          completedAt: new Date().toISOString(),
          label: label ?? null,
          plistPath: plistPath ?? null,
          plistRemoved: false,
          unloaded: false,
          restartRequested: false,
          error: "invalid cleanup arguments",
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }
  process.exit(2);
}

await new Promise((resolve) => setTimeout(resolve, 1_000));

const target = `gui/${process.getuid()}/${label}`;
let unloaded = false;
let error = null;
for (let attempt = 1; attempt <= 5; attempt += 1) {
  const result = spawnSync("/bin/launchctl", ["bootout", target], {
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  for (let poll = 1; poll <= 20; poll += 1) {
    const check = spawnSync("/bin/launchctl", ["print", target], {
      stdio: "ignore",
    });
    if (check.status !== 0) {
      unloaded = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (unloaded) break;
  error = output.trim() || `launchctl exited ${result.status}`;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

let plistRemoved = false;
if (unloaded) {
  try {
    unlinkSync(plistPath);
    plistRemoved = true;
  } catch (error) {
    if (error?.code === "ENOENT") plistRemoved = true;
  }
}

let restartRequested = false;
if (!unloaded) {
  const restart = spawnSync("/bin/launchctl", ["kickstart", target], {
    stdio: "ignore",
  });
  restartRequested = restart.status === 0;
}

writeFileSync(
  statusPath,
  `${JSON.stringify(
    {
      completedAt: new Date().toISOString(),
      label,
      plistPath,
      plistRemoved,
      unloaded,
      restartRequested,
      error: unloaded ? null : error,
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

if (!plistRemoved || !unloaded) process.exitCode = 1;
