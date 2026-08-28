export const IDENTIFIER_VALIDATION_CHECK_INTERVAL = 1_024;

const IDENTIFIER_VALIDATION_TIME_SLICE_MS = 8;

// Validation runs on the API thread, so contract-sized inputs must share it with health checks and I/O.
export class CooperativeScheduler {
  #remainingChecks = IDENTIFIER_VALIDATION_CHECK_INTERVAL;
  #deadline = performance.now() + IDENTIFIER_VALIDATION_TIME_SLICE_MS;

  shouldYield(work = 1): boolean {
    this.#remainingChecks -= work;
    if (this.#remainingChecks > 0) return false;
    this.#remainingChecks = IDENTIFIER_VALIDATION_CHECK_INTERVAL;
    return performance.now() >= this.#deadline;
  }

  async yield(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.#deadline = performance.now() + IDENTIFIER_VALIDATION_TIME_SLICE_MS;
  }
}
