export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const MAX_ERROR_DETAIL_CHARS = 500;
export const MAX_ERROR_BODY_BYTES = 4_096;

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
  return redacted
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

export async function boundedErrorText(
  response: Response,
  maxBytes = MAX_ERROR_BODY_BYTES,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remaining = maxBytes;
  let result = "";
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, remaining);
      result += decoder.decode(chunk, {
        stream: chunk.length === value.length,
      });
      remaining -= chunk.length;
      if (chunk.length < value.length) break;
    }
    result += decoder.decode();
    return result;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
