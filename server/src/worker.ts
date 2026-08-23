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
type WorkerSettings = Pick<
  Settings,
  | "workerPollSeconds"
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

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `Error: ${String(error)}`;
}

export class ExtractionWorker {
  readonly #database: WorkerDatabase;
  readonly #engine: WorkerEngine;
  readonly #settings: WorkerSettings;
  readonly #logger: WorkerLogger;

  #stopping = false;
  #wakeRequested = false;
  #wakeWaiter: (() => void) | null = null;
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
  }

  async process(job: ClaimedJob): Promise<void> {
    try {
      let extractionResult = job.extractionResult;
      if (extractionResult === null) {
        extractionResult = await this.#engine.extract(job);
        const published = await this.#database.publishExtraction(
          job,
          extractionResult,
        );
        if (!published) return;
      }
      const prepared = await this.#engine.resolve(job, extractionResult);
      await this.#database.commitResolution(job, extractionResult, prepared);
    } catch (error) {
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
        return;
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
    while (!this.#stopping) {
      const job = await this.#database.claimOldestJob(connection);
      if (job === null) {
        await this.#waitForWork();
        continue;
      }
      await this.process(job);
    }
  }

  async #tryLock(connection: PoolClient): Promise<boolean> {
    const result = await connection.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [this.#settings.workerLockId],
    );
    return Boolean(result.rows[0]?.acquired);
  }

  async #waitForWork(): Promise<void> {
    if (this.#stopping) return;
    if (this.#wakeRequested) {
      this.#wakeRequested = false;
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#wakeWaiter === finish) this.#wakeWaiter = null;
        resolve();
      };
      const timer = setTimeout(
        finish,
        Math.max(0, this.#settings.workerPollSeconds * 1000),
      );
      timer.unref();
      this.#wakeWaiter = finish;
      if (this.#stopping || this.#wakeRequested) finish();
    });
    this.#wakeRequested = false;
  }
}
