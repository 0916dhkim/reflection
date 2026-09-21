import process from "node:process";

import { createApp } from "@fixture/server/app.js";
import { loadSettings } from "@fixture/server/config.js";
import { Database } from "@fixture/server/database.js";
import { SearchService } from "@fixture/server/search.js";
import { ExtractionWorker } from "@fixture/server/worker.js";
import { parseExtractionResult } from "@fixture/shared/contracts.js";
import {
  claimIdFor,
  equivalenceKey,
  normalizeName,
} from "@fixture/shared/domain.js";

const ENTITY_ID = "6c1f20d1-86da-5e9a-a1a8-7c0a10369602";
const EMBEDDING = [1, ...Array(1023).fill(0)];
const releases = new Map();
let app;
let worker;
let stopping = false;

function send(message) {
  if (process.send) {
    process.send(message);
  }
}

function waitForRelease(sessionId) {
  return new Promise((resolve) => {
    releases.set(sessionId, resolve);
  });
}

function release(sessionId) {
  const resolve = releases.get(sessionId);
  if (resolve) {
    releases.delete(sessionId);
    resolve();
  }
}

function settings() {
  return loadSettings({
    DATABASE_URL: process.env.REHEARSAL_DATABASE_URL ?? "",
    REFLECTION_API_KEY: "fixture-api-key",
    OPENROUTER_API_KEY: "unused",
    VOYAGE_API_KEY: "unused",
    MIGRATIONS_DIR: process.env.REHEARSAL_MIGRATIONS_DIR ?? "migrations",
    WORKER_CONCURRENCY: "2",
    WORKER_POLL_SECONDS: "0.05",
    WORKER_MAX_ATTEMPTS: "1",
    WORKER_RETRY_BACKOFF_SECONDS: "0",
    DATABASE_POOL_MIN_SIZE: "1",
    DATABASE_POOL_MAX_SIZE: "8",
    LOG_LEVEL: "silent",
  });
}

function jobEvent(event, job) {
  send({
    event,
    jobId: job.id,
    sessionId: job.request.session_id,
    sourceId: job.sourceId,
    attempts: job.attempts,
    leaseId: job.leaseId,
  });
}

function extractionFor(job) {
  return parseExtractionResult({
    summary: `Summary ${job.request.session_id}`,
    claims: [
      {
        subject: "Fixture service",
        predicate: "uses",
        object_entity: null,
        object_value: "fixture memory",
        confidence: 1,
      },
    ],
  });
}

function preparedFor(job, extraction) {
  const claim = extraction.claims[0];
  if (!claim) {
    throw new Error("fixture extraction unexpectedly has no claim");
  }
  return {
    id: job.segmentId,
    sessionId: job.request.session_id,
    startUserMessageId: job.request.start_user_message_id,
    endUserMessageId: job.request.end_user_message_id,
    sourceBoundaryVersion: job.request.source_boundary_version,
    startSourceMessageId: job.request.start_source_message_id,
    endSourceMessageId: job.request.end_source_message_id,
    summary: extraction.summary,
    entities: [
      {
        id: ENTITY_ID,
        canonicalName: claim.subject,
        normalizedName: normalizeName(claim.subject),
        description: "Fixture service entity.",
        aliases: [claim.subject],
        embedding: EMBEDDING,
        isNew: true,
      },
    ],
    claims: [
      {
        id: claimIdFor(job.segmentId, 0),
        subject: claim.subject,
        subjectEntityId: ENTITY_ID,
        predicate: claim.predicate,
        confidence: claim.confidence,
        objectEntity: claim.object_entity,
        objectEntityId: null,
        objectValue: claim.object_value,
        equivalenceKey: equivalenceKey(ENTITY_ID, claim.predicate, {
          objectEntityId: null,
          objectValue: claim.object_value,
        }),
        embedding: EMBEDDING,
      },
    ],
    projectionVersion: job.request.projection_version,
  };
}

function fixtureEngine() {
  return {
    async extract(job) {
      jobEvent("extract", job);
      if (job.request.session_id.startsWith("hold-extract-")) {
        await waitForRelease(job.request.session_id);
      }
      if (job.request.session_id.startsWith("fail-extract-")) {
        throw new Error("synthetic extraction failure");
      }
      return extractionFor(job);
    },
    async resolve(job, extraction) {
      jobEvent("resolve", job);
      if (job.request.session_id.startsWith("hold-resolve-")) {
        await waitForRelease(job.request.session_id);
      }
      return preparedFor(job, extraction);
    },
  };
}

function fixtureEmbeddings() {
  return {
    async embed(inputs) {
      return inputs.map(() => EMBEDDING);
    },
  };
}

async function shutdown() {
  if (stopping) {
    return;
  }
  stopping = true;
  try {
    await app?.close();
  } finally {
    send({ event: "stopped" });
  }
}

process.on("message", async (message) => {
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.cmd === "release" && typeof message.sessionId === "string") {
    release(message.sessionId);
    return;
  }
  if (message.cmd === "stop-worker") {
    try {
      await worker.stop();
      send({ id: message.id, ok: true });
    } catch (error) {
      send({
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
});

process.on("SIGTERM", () => {
  void shutdown().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});

try {
  const fixtureSettings = settings();
  const database = new Database(fixtureSettings);
  const embeddings = fixtureEmbeddings();
  worker = new ExtractionWorker(database, fixtureEngine(), fixtureSettings, {
    info() {},
    warn() {},
    error() {},
  });
  const searchService = new SearchService(database, embeddings);
  app = createApp({
    settings: fixtureSettings,
    dependencies: { database, worker, searchService },
    logger: false,
  });
  const address = await app.listen({
    host: "127.0.0.1",
    port: Number(process.env.REHEARSAL_PORT ?? "0"),
  });
  send({ event: "ready", url: address });
} catch (error) {
  const message =
    error instanceof Error ? error.message : "backend startup failed";
  // IPC itself keeps this fixture process alive; mirror main.ts startup failure
  // rather than leaving a non-listening child hanging after onReady rejects.
  if (process.send)
    process.send({ event: "startup-error", message }, () => process.exit(1));
  else process.exit(1);
}
