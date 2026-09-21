import { fork } from "node:child_process";
import { once } from "node:events";

interface Reply {
  id: number;
  result: string;
  sdkReads: number;
  error?: string;
}

export function pluginChild(
  home: string,
  version: string,
  bundle: string,
  config: string,
) {
  const child = fork(
    new URL("./plugin-child.mjs", import.meta.url),
    [version, bundle, config],
    {
      cwd: home,
      execArgv: [],
      env: {
        HOME: home,
        XDG_CONFIG_HOME: `${home}/.config`,
        XDG_DATA_HOME: `${home}/.local/share`,
        XDG_STATE_HOME: `${home}/.local/state`,
        XDG_CACHE_HOME: `${home}/.cache`,
        TMPDIR: home,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let serial = 0,
    logs = "";
  const pending = new Map<
    number,
    { resolve: (reply: Reply) => void; reject: (error: Error) => void }
  >();
  for (const stream of [child.stdout, child.stderr])
    stream!.on("data", (chunk) => {
      logs = (logs + chunk).slice(-8000);
    });
  const fail = (error: Error) => {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", (code, signal) =>
    fail(new Error(`plugin ${version} exited ${code}/${signal}: ${logs}`)),
  );
  child.on("message", (reply: Reply) => {
    const item = pending.get(reply.id);
    if (!item) return;
    pending.delete(reply.id);
    if (reply.error) item.reject(new Error(`${reply.error}\n${logs}`));
    else item.resolve(reply);
  });
  const wait = (id: number) =>
    new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`plugin ${version} IPC ${id} timed out: ${logs}`));
      }, 15000);
      pending.set(id, {
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  const ready = wait(0);
  const command = (cmd: string, args = {}) => {
    const id = ++serial,
      response = wait(id);
    child.send({ id, cmd, args }, (error) => {
      if (error) fail(error);
    });
    return response;
  };
  return {
    ready,
    command,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      const kill = setTimeout(() => child.kill("SIGKILL"), 16000);
      try {
        await command("dispose");
        await exited;
      } finally {
        clearTimeout(kill);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
      }
    },
  };
}
