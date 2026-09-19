import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// No host configuration, credentials, mounts, published ports, or external
// networking enter the test container. Only the image build downloads packages.
const image = "reflection-opencode-v2-probe:2.0.8";
const context = fileURLToPath(new URL(".", import.meta.url));
const container = `reflection-v2-probe-${process.pid}`;

function docker(args, timeout) {
  const result = spawnSync("docker", args, { stdio: "inherit", timeout });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Docker failed (${result.status}): ${result.error ?? args[0]}`,
    );
  }
}

try {
  docker(
    ["build", "--platform", "linux/arm64", "--tag", image, context],
    300_000,
  );
  docker(
    [
      "run",
      "--rm",
      "--name",
      container,
      "--platform",
      "linux/arm64",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--memory",
      "4g",
      "--tmpfs",
      "/state:rw,nosuid,nodev,mode=1777",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,mode=1777",
      image,
      "/usr/bin/env",
      "-i",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "HOME=/state/home",
      "TMPDIR=/tmp",
      "XDG_CONFIG_HOME=/state/config",
      "XDG_DATA_HOME=/state/data",
      "XDG_CACHE_HOME=/state/cache",
      "XDG_STATE_HOME=/state/state",
      "OPENCODE_CONFIG_DIR=/state/config/opencode",
      "OPENCODE_DISABLE_MODELS_FETCH=1",
      "OPENCODE_DISABLE_FFF=1",
      "OPENCODE_PASSWORD=cp002-fixture-only",
      "PROBE_SERVER_URL=http://127.0.0.1:4096",
      "PROBE_SERVER_PASSWORD=cp002-fixture-only",
      "node",
      "/harness/harness.mjs",
    ],
    120_000,
  );
} finally {
  // A killed Docker client does not necessarily stop the container.
  spawnSync("docker", ["rm", "--force", container], {
    stdio: "ignore",
    timeout: 10_000,
  });
}
