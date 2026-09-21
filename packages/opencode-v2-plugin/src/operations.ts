export class Operations {
  private readonly controllers = new Map<
    AbortController,
    { session: string | undefined; background: boolean }
  >();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  readonly deleted = new Set<string>();
  stopped = false;
  run<T>(
    session: string | undefined,
    work: (signal: AbortSignal) => Promise<T>,
    timeout = 60000,
    background = false,
  ): Promise<T> {
    if (this.stopped || (session !== undefined && this.deleted.has(session)))
      return Promise.reject(
        new Error("Reflection: operation unavailable after disposal/deletion"),
      );
    const controller = new AbortController();
    this.controllers.set(controller, { session, background });
    const timer = setTimeout(() => controller.abort(), timeout);
    const task = Promise.resolve()
      .then(() => work(controller.signal))
      .finally(() => {
        clearTimeout(timer);
        this.controllers.delete(controller);
        this.tasks.delete(task);
      });
    this.tasks.add(task);
    return task;
  }
  queue<T>(session: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(session) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(() => {
        if (this.stopped || this.deleted.has(session))
          throw new Error("Reflection: session unavailable");
        return work();
      })
      .finally(() => {
        if (this.queues.get(session) === task) this.queues.delete(session);
      });
    this.queues.set(session, task);
    return task;
  }
  abort(session: string, primaryOnly = false) {
    for (const [controller, entry] of this.controllers)
      if (entry.session === session && (!primaryOnly || !entry.background))
        controller.abort();
  }
  async delete(session: string, remove: () => Promise<void>) {
    this.deleted.add(session);
    this.abort(session);
    const task = (async () => {
      await this.queues.get(session)?.catch(() => {});
      await remove();
    })();
    this.tasks.add(task);
    try {
      await task;
    } finally {
      this.tasks.delete(task);
    }
  }
  async dispose() {
    this.stopped = true;
    for (const controller of this.controllers.keys()) controller.abort();
    await Promise.allSettled([...this.tasks, ...this.queues.values()]);
  }
  get pending() {
    return this.tasks.size + this.queues.size;
  }
}

// The v2 Promise SDK does not propagate native request cancellation into hooks,
// tools, model.list, or storage. Bound our wait and guard every later mutation.
// The host independently prevents primary dispatch after native interruption.
export function bounded<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("Reflection: operation cancelled"));
    };
    if (signal.aborted) {
      promise.catch(() => {});
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
