import { createApp } from "./app.js";

export const app = createApp();

let shutdown: Promise<void> | null = null;

function close(signal: NodeJS.Signals): Promise<void> {
  if (shutdown === null) {
    app.log.info({ signal }, "shutting down");
    shutdown = app.close().catch((error: unknown) => {
      app.log.error({ err: error }, "graceful shutdown failed");
      process.exitCode = 1;
    });
  }
  return shutdown;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void close(signal);
  });
}

try {
  await app.listen({ host: "0.0.0.0", port: 8000 });
} catch (error) {
  app.log.error({ err: error }, "server startup failed");
  process.exitCode = 1;
  try {
    await app.close();
  } catch (closeError) {
    app.log.error({ err: closeError }, "startup cleanup failed");
  }
}
