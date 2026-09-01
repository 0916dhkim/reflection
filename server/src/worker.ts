import type { PoolClient } from "pg";
import { TerminalExtractionValidationError } from "@reflection/shared/domain";

import type { Settings } from "./config.js";
import type { ClaimedJob, Database } from "./database.js";
import type { ExtractionEngine } from "./extraction.js";

type WorkerDatabase = Pick<
  Database,
  | "pool"
  | "recoverRunningJobs"
  | "claimOldestJob"
  | "publishExtraction"
  | "commitResolution"
  | "finishFailedAttempt"
>;
type WorkerEngine = Pick<ExtractionEngine, "extract" | "resolve">;
type ProcessResult = "progressed" | "stale";
type WorkerSettings = Pick<
  Settings,
  | "workerPollSeconds"
  | "workerConcurrency"
  | "workerMaxAttempts"
  | "workerRetryBackoffSeconds"
  | "workerLockId"
>;

export interface WorkerLogger {
  info(message: string, ...values: unknown[]): void;
  warn(message: string, ...values: unknown[]): void;
  error(message: string, ...values: unknown[]): void;
}

const defaultLogger: WorkerLogger = console;
const STALE_WORK_MIN_BACKOFF_MS = 100;

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `Error: ${String(error)}`;
}

function timingText(
  result: string,
  jobId: number,
  totalMs: number,
  extractMs: number,
  reusedExtraction: boolean,
  laneWaitMs: number,
  resolveCommitMs: number,
  claimCount: number,
): string {
  const extractLabel = reusedExtraction
    ? "0.0ms [reused]"
    : `${extractMs.toFixed(1)}ms`;
  return (
    `extraction job ${jobId} ${result} in ${totalMs.toFixed(1)}ms ` +
    `(extract: ${extractLabel}, lane wait: ${laneWaitMs.toFixed(1)}ms, ` +
    `resolve/commit: ${resolveCommitMs.toFixed(1)}ms, claims: ${claimCount})`
  );
}

class ResolutionLane {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(
    operation: () => Promise<T>,
  ): Promise<{ result: T; waitMs: number }> {
    const queueStart = performance.now();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = this.#tail;
    this.#tail = this.#tail.then(
      () => next,
      () => next,
    );
    await current;
    const waitMs = performance.now() - queueStart;
    try {
      const result = await operation();
      return { result, waitMs };
    } finally {
      release();
    }
  }
}

export class ExtractionWorker {
  readonly #database: WorkerDatabase;
  readonly #engine: WorkerEngine;
  readonly #settings: WorkerSettings;
  readonly #logger: WorkerLogger;
  readonly #resolutionLane = new ResolutionLane();

  #stopping = false;
  #wakeRequested = false;
  #wakeWaiter: (() => void) | null = null;
  #taskWaiter: (() => void) | null = null;
  #task: Promise<void> | null = null;

  constructor(
    database: WorkerDatabase,
    engine: WorkerEngine,
    settings: WorkerSettings,
    logger: WorkerLogger = defaultLogger,
  ) {
    this.#database = database;
    this.#engine = engine;
    this.#settings = settings;
    this.#logger = logger;
  }

  start(): void {
    if (this.#task === null) this.#task = this.#run();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.wake();
    if (this.#task !== null) await this.#task;
  }

  wake(): void {
    this.#wakeRequested = true;
    this.#wakeWaiter?.();
    this.#taskWaiter?.();
  }

  async process(job: ClaimedJob): Promise<ProcessResult> {
    const startTime = performance.now();
    let extractMs = 0;
    let laneWaitMs = 0;
    let resolveCommitMs = 0;
    const reusedExtraction = job.extractionResult !== null;
    let extractionResult = job.extractionResult;

    try {
      if (extractionResult === null) {
        const extractStart = performance.now();
        extractionResult = await this.#engine.extract(job);
        extractMs = performance.now() - extractStart;
        const published = await this.#database.publishExtraction(
          job,
          extractionResult,
        );
        if (!published) {
          const totalMs = performance.now() - startTime;
          this.#logger.info(
            timingText(
              "stale",
              job.id,
              totalMs,
              extractMs,
              reusedExtraction,
              0,
              0,
              extractionResult.claims.length,
            ),
          );
          return "stale";
        }
      }

      const currentExtraction = extractionResult;
      let result: ProcessResult;
      if (currentExtraction.claims.length > 0) {
        const resolution = await this.#resolutionLane.run(async () => {
          const rcStart = performance.now();
          const prepared = await this.#engine.resolve(job, currentExtraction);
          const committed = await this.#database.commitResolution(
            job,
            currentExtraction,
            prepared,
          );
          resolveCommitMs = performance.now() - rcStart;
          return committed ? "progressed" : "stale";
        });
        laneWaitMs = resolution.waitMs;
        result = resolution.result;
      } else {
        const rcStart = performance.now();
        const prepared = await this.#engine.resolve(job, currentExtraction);
        const committed = await this.#database.commitResolution(
          job,
          currentExtraction,
          prepared,
        );
        resolveCommitMs = performance.now() - rcStart;
        result = committed ? "progressed" : "stale";
      }

      const totalMs = performance.now() - startTime;
      this.#logger.info(
        timingText(
          result,
          job.id,
          totalMs,
          extractMs,
          reusedExtraction,
          laneWaitMs,
          resolveCommitMs,
          extractionResult.claims.length,
        ),
      );
      return result;
    } catch (error) {
      const totalMs = performance.now() - startTime;
      const claimCount = extractionResult?.claims.length ?? 0;

      if (error instanceof TerminalExtractionValidationError) {
        this.#logger.error(
          `extraction job ${job.id} has invalid deterministic input`,
          error,
        );
        const updated = await this.#database.finishFailedAttempt(
          job,
          errorText(error),
          { retryAfterSeconds: null },
        );
        if (!updated) {
          this.#logger.info(
            `ignored deterministic failure from stale lease for job ${job.id}`,
          );
        }
        this.#logger.info(
          timingText(
            "failed (terminal)",
            job.id,
            totalMs,
            extractMs,
            reusedExtraction,
            laneWaitMs,
            resolveCommitMs,
            claimCount,
          ),
        );
        return updated ? "progressed" : "stale";
      }

      const shouldRetry = job.attempts < this.#settings.workerMaxAttempts;
      this.#logger.error(
        `extraction job ${job.id} attempt ${job.attempts} failed${shouldRetry ? "; retrying" : ""}`,
        error,
      );
      const updated = await this.#database.finishFailedAttempt(
        job,
        errorText(error),
        {
          retryAfterSeconds: shouldRetry
            ? this.#settings.workerRetryBackoffSeconds
            : null,
        },
      );
      if (!updated) {
        this.#logger.info(`ignored failure from stale lease for job ${job.id}`);
      }
      this.#logger.info(
        timingText(
          shouldRetry ? "failed (retryable)" : "failed (exhausted)",
          job.id,
          totalMs,
          extractMs,
          reusedExtraction,
          laneWaitMs,
          resolveCommitMs,
          claimCount,
        ),
      );
      return updated ? "progressed" : "stale";
    }
  }

  async #run(): Promise<void> {
    while (!this.#stopping) {
      let connection: PoolClient | null = null;
      let destroyConnection = false;
      try {
        connection = await this.#database.pool.connect();
        const acquired = await this.#tryLock(connection);
        if (!acquired) {
          await this.#waitForWork();
          continue;
        }
        try {
          const recovered = await this.#database.recoverRunningJobs(connection);
          if (recovered > 0) {
            this.#logger.warn(
              `recovered ${recovered} interrupted extraction jobs`,
            );
          }
          await this.#workLoop(connection);
        } finally {
          try {
            const unlocked = await connection.query<{ unlocked: boolean }>(
              "SELECT pg_advisory_unlock($1) AS unlocked",
              [this.#settings.workerLockId],
            );
            destroyConnection = unlocked.rows[0]?.unlocked !== true;
          } catch {
            destroyConnection = true;
          }
        }
      } catch (error) {
        this.#logger.error("worker loop failed; retrying", error);
        await this.#waitForWork();
      } finally {
        connection?.release(destroyConnection);
      }
    }
  }

  async #workLoop(connection: PoolClient): Promise<void> {
    const activeTasks = new Set<Promise<void>>();
    const activeSessions = new Set<string>();
    let staleBackoff = false;
    let taskWaiter: (() => void) | null = null;

    const onTaskComplete = () => {
      taskWaiter?.();
    };

    try {
      while (!this.#stopping) {
        if (staleBackoff) {
          staleBackoff = false;
          await this.#waitForWork(false);
          if (this.#stopping) break;
        }

        if (activeTasks.size >= this.#settings.workerConcurrency) {
          await new Promise<void>((resolve) => {
            taskWaiter = resolve;
            this.#taskWaiter = resolve;
            if (
              this.#stopping ||
              activeTasks.size < this.#settings.workerConcurrency
            ) {
              resolve();
            }
          });
          taskWaiter = null;
          this.#taskWaiter = null;
          if (this.#stopping) break;
          continue;
        }

        const job = await this.#database.claimOldestJob(
          connection,
          Array.from(activeSessions),
        );

        if (this.#stopping) {
          if (job !== null) {
            activeSessions.add(job.request.session_id);
            const task = this.#dispatchJob(job, activeSessions, (result) => {
              if (result === "stale") staleBackoff = true;
            }).finally(() => {
              activeTasks.delete(task);
              onTaskComplete();
            });
            activeTasks.add(task);
          }
          break;
        }

        if (job === null) {
          if (activeTasks.size > 0) {
            let listenerResolved = false;
            const listener = () => {
              if (listenerResolved) return;
              listenerResolved = true;
              this.wake();
            };
            taskWaiter = listener;
            try {
              await this.#waitForWork(true);
            } finally {
              taskWaiter = null;
            }
          } else {
            await this.#waitForWork(true);
          }
          continue;
        }

        activeSessions.add(job.request.session_id);
        const task = this.#dispatchJob(job, activeSessions, (result) => {
          if (result === "stale") staleBackoff = true;
        }).finally(() => {
          activeTasks.delete(task);
          onTaskComplete();
        });
        activeTasks.add(task);
      }
    } finally {
      taskWaiter = null;
      this.#taskWaiter = null;
      if (activeTasks.size > 0) {
        await Promise.allSettled(activeTasks);
      }
    }
  }

  async #dispatchJob(
    job: ClaimedJob,
    activeSessions: Set<string>,
    onFinished: (result: ProcessResult) => void,
  ): Promise<void> {
    try {
      const result = await this.process(job);
      onFinished(result);
    } catch (error) {
      this.#logger.error(`unexpected error processing job ${job.id}`, error);
    } finally {
      activeSessions.delete(job.request.session_id);
    }
  }

  async #tryLock(connection: PoolClient): Promise<boolean> {
    const result = await connection.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [this.#settings.workerLockId],
    );
    return Boolean(result.rows[0]?.acquired);
  }

  async #waitForWork(allowWake = true): Promise<void> {
    if (this.#stopping) return;
    if (allowWake && this.#wakeRequested) {
      this.#wakeRequested = false;
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#wakeWaiter === wake) this.#wakeWaiter = null;
        resolve();
      };
      const wake = () => {
        if (this.#stopping || allowWake) finish();
      };
      const timer = setTimeout(
        finish,
        Math.max(
          allowWake ? 0 : STALE_WORK_MIN_BACKOFF_MS,
          this.#settings.workerPollSeconds * 1000,
        ),
      );
      timer.unref();
      this.#wakeWaiter = wake;
      if (this.#stopping || (allowWake && this.#wakeRequested)) finish();
    });
    this.#wakeRequested = false;
  }
}
