export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const MAX_ERROR_DETAIL_CHARS = 500;

interface DisposableSignal {
  signal: AbortSignal;
  dispose(): void;
}

export function combineAbortSignals(
  signals: ReadonlyArray<AbortSignal | null | undefined>,
): DisposableSignal {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];

  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }

    const listener = () => controller.abort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }

  return {
    signal: controller.signal,
    dispose() {
      for (const entry of listeners) {
        entry.signal.removeEventListener("abort", entry.listener);
      }
    },
  };
}

export function requestSignal(
  userSignal?: AbortSignal | null,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): DisposableSignal {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be positive");
  }

  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () =>
      timeoutController.abort(
        new Error(`request timed out after ${timeoutMs}ms`),
      ),
    timeoutMs,
  );
  const combined = combineAbortSignals([userSignal, timeoutController.signal]);

  return {
    signal: combined.signal,
    dispose() {
      clearTimeout(timeout);
      combined.dispose();
    },
  };
}

export function safeErrorDetail(
  value: string,
  apiKey: string,
  maxChars = MAX_ERROR_DETAIL_CHARS,
): string {
  const redacted = value.split(apiKey).join("[REDACTED]");
  return redacted.replace(/\s+/g, " ").trim().slice(0, maxChars);
}
