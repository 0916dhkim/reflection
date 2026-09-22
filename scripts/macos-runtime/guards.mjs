import { isAbsolute, resolve } from "node:path";

export const CLI_ARCHIVE_URL =
  "https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-2.0.8.tgz";
export const CLI_ARCHIVE_SHA256 =
  "aa8d695a7f8a75577376a56008e147659737aa97dbf6d5677b0986640c4b5c14";
export const CLI_BINARY_SHA256 =
  "80fb8f312afa53182fbddc1230fe7937ba4b8ec2c5bf1de97510092919662196";

export function assertGitHubHostedMacOS(
  environment = process.env,
  runtime = process,
  repository = process.cwd(),
) {
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.RUNNER_OS !== "macOS" ||
    runtime.platform !== "darwin" ||
    runtime.arch !== "arm64" ||
    environment.RUNNER_ENVIRONMENT !== "github-hosted" ||
    !environment.RUNNER_TEMP ||
    !isAbsolute(environment.RUNNER_TEMP) ||
    !environment.GITHUB_WORKSPACE ||
    !isAbsolute(environment.GITHUB_WORKSPACE) ||
    resolve(environment.GITHUB_WORKSPACE) !== resolve(repository) ||
    !environment.GITHUB_RUN_ID ||
    !environment.GITHUB_JOB ||
    !["15", "26"].includes(environment.EXPECTED_MACOS_MAJOR)
  ) {
    throw new Error(
      "macos-v2 may run only on a GitHub-hosted macOS arm64 runner",
    );
  }
}

export function assertPrivatePath(root, candidate) {
  const base = resolve(root);
  const target = resolve(candidate);
  if (target !== base && !target.startsWith(`${base}/`)) {
    throw new Error("macos-v2 refused a path outside its private fixture root");
  }
  return target;
}

export function assertLoopbackUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password
  ) {
    throw new Error("macos-v2 fixture requests must remain loopback HTTP");
  }
  return url;
}

export function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/[^\s"']+/g, "[url]")
    .replace(/Basic\s+[^\s]+/gi, "Basic [redacted]")
    .replace(/(password|token|key)=?[^\s,;]+/gi, "$1=[redacted]");
}

export function childEnvironment({ root, password }) {
  if (!isAbsolute(root)) {
    throw new Error("macos-v2 private root must be absolute");
  }
  if (!password) {
    throw new Error("macos-v2 fixture password is required");
  }
  const nodeBin = resolve(process.execPath, "..");
  return {
    PATH: `${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    SHELL: "/bin/sh",
    HOME: `${root}/home`,
    TMPDIR: `${root}/tmp`,
    XDG_CONFIG_HOME: `${root}/xdg/config`,
    XDG_DATA_HOME: `${root}/xdg/data`,
    XDG_STATE_HOME: `${root}/xdg/state`,
    XDG_CACHE_HOME: `${root}/xdg/cache`,
    OPENCODE_CONFIG_DIR: `${root}/opencode-config`,
    OPENCODE_CONFIG: `${root}/opencode-config/opencode.json`,
    OPENCODE_DB: `${root}/db/opencode.db`,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_FFF: "1",
    OPENCODE_PASSWORD: password,
  };
}

export function sandboxProfile(root, ports) {
  if (!isAbsolute(root) || /["\\\n\r]/.test(root))
    throw Error("Invalid sandbox root");
  if (
    !ports.length ||
    ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)
  )
    throw Error("Invalid sandbox ports");
  // Public OS reads/Mach services are needed on disposable hosted VMs. No
  // credential-bearing environment is inherited; this is not a TCC emulator.
  return `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "${root}") (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))
(deny network*)
${ports.map((port) => `(allow network-outbound (remote ip "localhost:${port}"))\n(allow network-inbound (local ip "localhost:${port}"))\n(allow network-bind (local ip "localhost:${port}"))`).join("\n")}
`;
}

export function sessionRoute(origin, sessionId) {
  assertLoopbackUrl(origin);
  return `/server/${Buffer.from(origin).toString("base64url")}/session/${encodeURIComponent(sessionId)}`;
}
