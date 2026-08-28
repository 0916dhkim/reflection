import { randomUUID } from "node:crypto";

import {
  ExtractionValidationError,
  TerminalExtractionValidationError,
  sourceFingerprint,
  type PreparedSegment,
} from "@reflection/shared/domain";
import type { ExtractionResult } from "@reflection/shared/contracts";
import { describe, expect, test, vi } from "vitest";

import { UpstreamValidationError } from "../src/clients.js";
import type { Settings } from "../src/config.js";
import type { ClaimedJob } from "../src/database.js";
import type { ValidatedExtractionResult } from "../src/extraction-validation.js";
import { ExtractionWorker, type WorkerLogger } from "../src/worker.js";

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    databaseUrl: "postgresql://unused",
    reflectionApiKey: "test",
    openrouterApiKey: "test",
    voyageApiKey: "test",
    openrouterBaseUrl: "https://openrouter.example/v1",
    voyageBaseUrl: "https://voyage.example/v1",
    extractionModel: "openai/gpt-5.6-luna",
    extractionProvider: "openai",
    extractionReasoningEffort: "medium",
    extractionNativeSchema: true,
    resolutionModel: "openai/gpt-5.6-luna",
    resolutionProvider: "openai",
    resolutionReasoningEffort: "medium",
    resolutionNativeSchema: true,
    embeddingModel: "voyage-4-large",
    embeddingDimensions: 1024,
    databasePoolMinSize: 1,
    databasePoolMaxSize: 8,
    workerPollSeconds: 60,
    workerMaxAttempts: 3,
    workerRetryBackoffSeconds: 0.25,
    workerLockId: 7_320_260_818_001,
    migrationLockId: 7_320_260_818_002,
    requestTimeoutSeconds: 120,
    modelCallTimeoutSeconds: 180,
    migrationsDir: "migrations",
    logLevel: "INFO",
    ...overrides,
  };
}

function extractionResult(summary = "summary"): ValidatedExtractionResult {
  return {
    summary,
    claims: [],
  } as ExtractionResult as ValidatedExtractionResult;
}

function job(
  attempts: number,
  staged: ValidatedExtractionResult | null = null,
): ClaimedJob {
  const request = {
    session_id: "session",
    start_user_message_id: "start",
    end_user_message_id: "end",
    source_boundary_version: 1 as const,
    start_source_message_id: null,
    end_source_message_id: null,
    projection_version: 0 as const,
    processing_priority: 0,
    messages: [{ role: "user" as const, text: "text" }],
  };
  return {
    id: 1,
    segmentId: randomUUID(),
    leaseId: randomUUID(),
    sourceGeneration: 1n,
    sourceFingerprint: sourceFingerprint(request),
    attempts,
    request,
    extractionResult: staged,
  };
}

function prepared(claimed: ClaimedJob): PreparedSegment {
  return {
    id: claimed.segmentId,
    sessionId: claimed.request.session_id,
    startUserMessageId: claimed.request.start_user_message_id,
    endUserMessageId: claimed.request.end_user_message_id,
    sourceBoundaryVersion: claimed.request.source_boundary_version,
    startSourceMessageId: claimed.request.start_source_message_id,
    endSourceMessageId: claimed.request.end_source_message_id,
    summary: "summary",
    entities: [],
    claims: [],
    projectionVersion: claimed.request.projection_version,
  };
}

const logger: WorkerLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

type WorkerDatabase = ConstructorParameters<typeof ExtractionWorker>[0];
type WorkerEngine = ConstructorParameters<typeof ExtractionWorker>[1];

function workerDatabase(value: object): WorkerDatabase {
  return value as WorkerDatabase;
}

function workerEngine(value: object): WorkerEngine {
  return value as WorkerEngine;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
}

describe("ExtractionWorker", () => {
  test.each([
    [1, new Error("transient"), 0.25],
    [3, new Error("exhausted"), null],
    [1, new ExtractionValidationError("invalid model output"), 0.25],
    [1, new UpstreamValidationError("invalid schema output"), 0.25],
    [
      1,
      new TerminalExtractionValidationError("embedding input too large"),
      null,
    ],
  ])(
    "classifies attempt %s %s with retry delay %s",
    async (attempts, error, expectedBackoff) => {
      const finishFailedAttempt = vi.fn(async () => true);
      const database = workerDatabase({ finishFailedAttempt });
      const engine = workerEngine({
        extract: vi.fn(async () => {
          throw error;
        }),
        resolve: vi.fn(),
      });
      const worker = new ExtractionWorker(database, engine, settings(), logger);
      const claimed = job(attempts);

      await worker.process(claimed);

      expect(finishFailedAttempt).toHaveBeenCalledWith(
        claimed,
        `${error.name}: ${error.message}`,
        { retryAfterSeconds: expectedBackoff },
      );
    },
  );

  test("extracts, publishes, resolves, and commits in order", async () => {
    const claimed = job(1);
    const output = prepared(claimed);
    const extracted = extractionResult(output.summary);
    const events: string[] = [];
    const publishExtraction = vi.fn(async () => {
      events.push("publish");
      return true;
    });
    const commitResolution = vi.fn(async () => {
      events.push("commit");
      return true;
    });
    const database = workerDatabase({ publishExtraction, commitResolution });
    const engine = workerEngine({
      extract: vi.fn(async () => {
        events.push("extract");
        return extracted;
      }),
      resolve: vi.fn(async () => {
        events.push("resolve");
        return output;
      }),
    });

    await new ExtractionWorker(database, engine, settings(), logger).process(
      claimed,
    );

    expect(events).toEqual(["extract", "publish", "resolve", "commit"]);
    expect(publishExtraction).toHaveBeenCalledWith(claimed, extracted);
    expect(commitResolution).toHaveBeenCalledWith(claimed, extracted, output);
  });

  test("stops after a stale publish and reuses staged extraction on retry", async () => {
    const fresh = job(1);
    const staleExtracted = extractionResult();
    const staleResolve = vi.fn();
    const staleCommit = vi.fn();
    await new ExtractionWorker(
      workerDatabase({
        publishExtraction: vi.fn(async () => false),
        commitResolution: staleCommit,
      }),
      workerEngine({
        extract: vi.fn(async () => staleExtracted),
        resolve: staleResolve,
      }),
      settings(),
      logger,
    ).process(fresh);
    expect(staleResolve).not.toHaveBeenCalled();
    expect(staleCommit).not.toHaveBeenCalled();

    const staged = job(2, extractionResult("staged"));
    const output = prepared(staged);
    output.summary = "staged";
    const extract = vi.fn();
    const resolve = vi.fn(async () => output);
    const commitResolution = vi.fn(async () => true);
    await new ExtractionWorker(
      workerDatabase({
        publishExtraction: vi.fn(),
        commitResolution,
      }),
      workerEngine({ extract, resolve }),
      settings(),
      logger,
    ).process(staged);
    expect(extract).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith(staged, staged.extractionResult);
    expect(commitResolution).toHaveBeenCalledWith(
      staged,
      staged.extractionResult,
      output,
    );
  });

  test("holds one physical client while locked, recovers before claiming, and unlocks before release", async () => {
    const events: string[] = [];
    const claimed = deferred<void>();
    const connection = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) {
          events.push("lock");
          return { rows: [{ acquired: true }] };
        }
        events.push("unlock");
        return { rows: [] };
      }),
      release: vi.fn(() => events.push("release")),
    };
    const database = workerDatabase({
      pool: {
        connect: vi.fn(async () => {
          events.push("connect");
          return connection;
        }),
      },
      recoverRunningJobs: vi.fn(async () => {
        events.push("recover");
        return 2;
      }),
      claimOldestJob: vi.fn(async () => {
        events.push("claim");
        claimed.resolve();
        return null;
      }),
    });
    const worker = new ExtractionWorker(
      database,
      workerEngine({ extract: vi.fn(), resolve: vi.fn() }),
      settings(),
      logger,
    );

    worker.start();
    await claimed.promise;
    expect(connection.release).not.toHaveBeenCalled();
    await worker.stop();

    expect(events).toEqual([
      "connect",
      "lock",
      "recover",
      "claim",
      "unlock",
      "release",
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      "recovered 2 interrupted extraction jobs",
    );
  });

  test("wake interrupts lock-election polling", async () => {
    let connections = 0;
    const releases: number[] = [];
    const database = workerDatabase({
      pool: {
        connect: vi.fn(async () => {
          connections += 1;
          const current = connections;
          return {
            query: vi.fn(async () => ({ rows: [{ acquired: false }] })),
            release: vi.fn(() => releases.push(current)),
          };
        }),
      },
    });
    const worker = new ExtractionWorker(
      database,
      workerEngine({ extract: vi.fn(), resolve: vi.fn() }),
      settings(),
      logger,
    );

    worker.start();
    await waitUntil(() => connections === 1);
    worker.wake();
    await waitUntil(() => connections === 2);
    await worker.stop();

    expect(releases).toEqual([1, 2]);
  });

  test("backs off after stale work despite ordinary wake signals", async () => {
    const claimed = job(1);
    const firstPublish = deferred<void>();
    const connection = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("pg_try_advisory_lock")
          ? [{ acquired: true }]
          : [{ unlocked: true }],
      })),
      release: vi.fn(),
    };
    const claimOldestJob = vi.fn(async () => claimed);
    const database = workerDatabase({
      pool: { connect: vi.fn(async () => connection) },
      recoverRunningJobs: vi.fn(async () => 0),
      claimOldestJob,
      publishExtraction: vi.fn(async () => {
        firstPublish.resolve();
        return false;
      }),
    });
    const worker = new ExtractionWorker(
      database,
      workerEngine({
        extract: vi.fn(async () => extractionResult()),
        resolve: vi.fn(),
      }),
      settings({ workerPollSeconds: 60 }),
      logger,
    );

    worker.start();
    await firstPublish.promise;
    worker.wake();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(claimOldestJob).toHaveBeenCalledOnce();
    await worker.stop();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  test("graceful stop waits for the in-flight extraction to commit", async () => {
    const claimed = job(1);
    const resolution = deferred<PreparedSegment>();
    const preparing = deferred<void>();
    let nextJob: ClaimedJob | null = claimed;
    const connection = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("pg_try_advisory_lock") ? [{ acquired: true }] : [],
      })),
      release: vi.fn(),
    };
    const commitResolution = vi.fn(async () => true);
    const database = workerDatabase({
      pool: { connect: vi.fn(async () => connection) },
      recoverRunningJobs: vi.fn(async () => 0),
      claimOldestJob: vi.fn(async () => {
        const current = nextJob;
        nextJob = null;
        return current;
      }),
      publishExtraction: vi.fn(async () => true),
      commitResolution,
    });
    const engine = workerEngine({
      extract: vi.fn(async () => extractionResult()),
      resolve: vi.fn(async () => {
        preparing.resolve();
        return resolution.promise;
      }),
    });
    const worker = new ExtractionWorker(database, engine, settings(), logger);

    worker.start();
    await preparing.promise;
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(stopped).toBe(false);

    const output = prepared(claimed);
    resolution.resolve(output);
    await stopping;

    expect(commitResolution).toHaveBeenCalledWith(
      claimed,
      extractionResult(),
      output,
    );
    expect(connection.release).toHaveBeenCalledOnce();
  });
});
