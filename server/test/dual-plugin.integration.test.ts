import "./dual-plugin-fixture/database-guard.mjs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  parseExtractionResult,
  type SearchResponse,
} from "@reflection/shared/contracts";
import { equivalenceKey } from "@reflection/shared/domain";
import {
  ingestSourceFingerprint,
  parseIngestSegmentCreate,
  parseIngestSessionSegmentsResponse,
  type IngestSegmentCreate,
} from "@reflection/shared/ingestion";
import { createApp } from "../src/app.js";
import { loadSettings } from "../src/config.js";
import { Database } from "../src/database.js";
import type { ExtractionEngine } from "../src/extraction.js";
import type { ValidatedExtractionResult } from "../src/extraction-validation.js";
import { SearchService } from "../src/search.js";
import { ExtractionWorker } from "../src/worker.js";
import { pluginChild } from "./dual-plugin-fixture/child.js";

test("CP010: actual v1 and v2 bundles ingest, search and cross-read one PostgreSQL backend", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "reflection-dual-plugin-"));
  const settings = loadSettings({
    DATABASE_URL: process.env.REFLECTION_TEST_DATABASE_URL,
    MIGRATIONS_DIR: join(root, "migrations"),
    REFLECTION_API_KEY: "fixture-reflection-key",
    OPENROUTER_API_KEY: "fixture-unused",
    VOYAGE_API_KEY: "fixture-unused",
    WORKER_POLL_SECONDS: "0.05",
    WORKER_CONCURRENCY: "2",
  });
  const database = new Database(settings);
  const vector = Array.from({ length: 1024 }, () => 0.01);
  const entityId = randomUUID(),
    errors: string[] = [];
  const engine: Pick<ExtractionEngine, "extract" | "resolve"> = {
    async extract(job) {
      // Only the extraction engine is doubled. Parse the real wire contract;
      // the brand assertion substitutes for provider/source semantic validation.
      return parseExtractionResult({
        summary: `${job.sourceId} fixture summary`,
        claims: [
          {
            subject: "Dual fixture",
            predicate: "supports",
            confidence: 1,
            object_entity: null,
            object_value: "paired recall",
          },
        ],
      }) as ValidatedExtractionResult;
    },
    async resolve(job, extraction) {
      const request = job.request;
      const isNew =
        (
          await database.pool.query("SELECT id FROM entities WHERE id=$1", [
            entityId,
          ])
        ).rowCount === 0;
      const base = {
        id: job.segmentId,
        sessionId: request.session_id,
        summary: extraction.summary,
        projectionVersion: request.projection_version,
        entities: [
          {
            id: entityId,
            canonicalName: "Dual fixture",
            normalizedName: "dual fixture",
            description: "Fixture",
            aliases: [],
            embedding: isNew ? vector : null,
            isNew,
          },
        ],
        claims: [
          {
            id: randomUUID(),
            subject: "Dual fixture",
            subjectEntityId: entityId,
            predicate: "supports",
            confidence: 1,
            objectEntity: null,
            objectEntityId: null,
            objectValue: "paired recall",
            embedding: vector,
            equivalenceKey: equivalenceKey(entityId, "supports", {
              objectEntityId: null,
              objectValue: "paired recall",
            }),
          },
        ],
      };
      return request.source_boundary_version === 3
        ? {
            ...base,
            sourceBoundaryVersion: 3,
            startSourceMessageId: request.start_source_message_id,
            endSourceMessageId: request.end_source_message_id,
          }
        : {
            ...base,
            sourceBoundaryVersion: request.source_boundary_version,
            startSourceMessageId: request.start_source_message_id,
            endSourceMessageId: request.end_source_message_id,
            startUserMessageId: request.start_user_message_id,
            endUserMessageId: request.end_user_message_id,
          };
    },
  };
  const worker = new ExtractionWorker(database, engine, settings, {
    info() {},
    warn() {},
    error: (...args) => {
      errors.push(args.map(String).join(" "));
    },
  });
  const app = createApp({
    settings,
    logger: false,
    dependencies: {
      database,
      worker,
      searchService: new SearchService(database, {
        embed: async (texts) => texts.map(() => vector),
      }),
    },
  });
  const posts: IngestSegmentCreate[] = [];
  app.addHook("onResponse", async (request, reply) => {
    if (
      request.method === "POST" &&
      request.url === "/v1/segments" &&
      reply.statusCode === 202
    )
      posts.push(parseIngestSegmentCreate(request.body));
  });
  const servers: Server[] = [],
    children: ReturnType<typeof pluginChild>[] = [];
  const sources: Record<
    string,
    { kind: string; url: string; username: string; password: string }
  > = {};
  const unavailable = new Set<string>(),
    sourceReads: string[] = [];
  const texts = (version: string) => [
    version + "_ONLY_" + "u".repeat(10000),
    version + "_ONLY_EVENT",
    version + "_ONLY_" + "a".repeat(12000),
    version + "_ONLY_TAIL",
  ];
  const legacy = texts("V1").map((text, index) => ({
    info: {
      id: `msg_${index}`,
      sessionID: "same-session",
      role: index === 0 || index === 3 ? "user" : "assistant",
      time: {
        created: index + 1,
        ...(index === 1 || index === 2 ? { completed: index + 1.5 } : {}),
      },
      ...(index === 1 || index === 2 ? { parentID: "msg_0" } : {}),
    },
    parts: [{ type: "text", text }],
  }));
  const native = texts("V2").map((text, index) => ({
    id: `msg_${index}`,
    type: ["user", "synthetic", "assistant", "user"][index],
    time: { created: index + 1, ...(index === 2 ? { completed: 3.5 } : {}) },
    ...(index === 2
      ? {
          agent: "build",
          model: { providerID: "fixture", id: "model" },
          content: [{ type: "text", text }],
        }
      : { text }),
  }));
  const updated = Date.now();
  try {
    // The sequencer runs the existing database suite first; never share this schema concurrently.
    await database.pool.query(
      "DROP SCHEMA public CASCADE; CREATE SCHEMA public",
    );
    const operator = (...args: string[]) =>
      execFileSync(
        process.execPath,
        [join(root, "scripts/source-ownership.mjs"), ...args],
        {
          env: {
            DATABASE_URL: settings.databaseUrl,
            MIGRATIONS_DIR: settings.migrationsDir,
          },
        },
      );
    operator("expand");
    for (const version of ["v1", "v2"])
      operator(
        "register",
        "--id",
        `fixture-${version}`,
        "--kind",
        `opencode-${version}`,
        "--identity-scheme",
        version === "v1" ? "legacy" : "source-v1",
      );
    operator("install-indexes");
    operator("cutover", "--old-writers-stopped");
    const backend = await app.listen({ host: "127.0.0.1", port: 0 });
    for (const version of ["v1", "v2"]) {
      const sourceId = `fixture-${version}`,
        username = version,
        password = "fixture-only";
      const server = createServer((request, response) => {
        const url = new URL(request.url!, "http://fixture.invalid");
        sourceReads.push(
          `${sourceId}:${url.pathname}:${url.searchParams.get("cursor") ?? "first"}`,
        );
        if (
          request.headers["x-api-key"] ||
          request.headers.authorization !==
            `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
        ) {
          errors.push("source authentication violation");
          response.writeHead(401).end();
          return;
        }
        if (unavailable.has(sourceId)) {
          response.writeHead(503).end();
          return;
        }
        let value: unknown;
        if (
          version === "v1" &&
          url.pathname === "/session/same-session/message"
        )
          value = legacy;
        else if (
          version === "v2" &&
          url.pathname === "/api/session/same-session/message"
        ) {
          const cursor = url.searchParams.get("cursor");
          if (cursor !== null && cursor !== "second") {
            errors.push("unexpected native cursor");
            response.writeHead(400).end();
            return;
          }
          value = {
            data: cursor ? native.slice(2) : native.slice(0, 2),
            cursor: { next: cursor ? null : "second" },
          };
        } else if (version === "v2" && url.pathname === "/api/session")
          value = { data: [], cursor: { next: null } };
        else if (version === "v2" && url.pathname === "/api/session/active")
          value = { data: [] };
        else if (
          version === "v2" &&
          url.pathname === "/api/session/same-session"
        )
          value = {
            data: {
              id: "same-session",
              location: { directory: "/fixture" },
              time: { updated },
            },
          };
        else {
          errors.push(`unexpected source endpoint ${request.url}`);
          response.writeHead(404).end();
          return;
        }
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(value));
      });
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("missing fixture port");
      sources[sourceId] = {
        kind: `opencode-${version}`,
        url: `http://127.0.0.1:${address.port}`,
        username,
        password,
      };
    }
    for (const version of ["v1", "v2"]) {
      const directory = join(home, version),
        config = join(directory, ".config/opencode/reflection.json");
      await mkdir(join(directory, ".config/opencode"), { recursive: true });
      await writeFile(
        config,
        JSON.stringify({
          url: backend,
          apiKey: settings.reflectionApiKey,
          sourceId: `fixture-${version}`,
          sources,
          contextProjection: { enabled: true },
        }),
      );
      const bundle = join(
        root,
        version === "v1"
          ? "plugin/dist/reflection.js"
          : "packages/opencode-v2-plugin/dist/reflection-v2.js",
      );
      const child = pluginChild(directory, version, bundle, config);
      children.push(child);
      await child.ready;
    }
    await Promise.all(children.map((child) => child.command("idle")));
    await expect
      .poll(
        async () =>
          (
            await database.pool.query(
              "SELECT source_id FROM extraction_jobs WHERE status='succeeded' ORDER BY source_id",
            )
          ).rows,
        { timeout: 15000, interval: 50 },
      )
      .toEqual([
        { source_id: "fixture-v1" },
        { source_id: "fixture-v1" },
        { source_id: "fixture-v2" },
      ]);
    expect(posts).toHaveLength(3);
    await expect
      .poll(() => sourceReads.includes("fixture-v2:/api/session:first"))
      .toBe(true);
    const pairs: { source_id: string; segment_id: string }[] = [];
    for (const post of posts) {
      expect(post.session_id).toBe("same-session");
      expect(post.processing_priority).toBe(50);
      const nativePost = post.source_id === "fixture-v2";
      // Native packing leaves the short last chunk open; v1 closes both chunks
      // of the completed turn when the new user tail arrives.
      const start = post.start_source_message_id === "msg_0" ? 0 : 2;
      const end = start === 0 ? 1 : 2;
      if (nativePost) expect(start).toBe(0);
      expect(post.start_source_message_id).toBe(`msg_${start}`);
      expect(post.end_source_message_id).toBe(`msg_${end}`);
      expect(post.source_boundary_version).toBe(nativePost ? 3 : 2);
      expect(post.projection_version).toBe(nativePost ? 3 : 1);
      expect(post.messages).toEqual(
        texts(nativePost ? "V2" : "V1")
          .map((text, index) =>
            nativePost
              ? {
                  id: `msg_${index}`,
                  type: ["user", "synthetic", "assistant", "user"][index],
                  text,
                }
              : {
                  role: index === 0 || index === 3 ? "user" : "assistant",
                  text,
                },
          )
          .slice(start, end + 1),
      );
      const rows = (
        await database.pool.query(
          "SELECT * FROM segments WHERE source_id=$1 AND start_source_message_id=$2",
          [post.source_id, post.start_source_message_id],
        )
      ).rows;
      expect(rows).toHaveLength(1);
      const row = rows[0];
      pairs.push({ source_id: post.source_id, segment_id: row.id });
      expect(row.source_boundary_version).toBe(post.source_boundary_version);
      expect(row.source_fingerprint).toBe(ingestSourceFingerprint(post));
      expect(row.projection_version).toBe(post.projection_version);
      expect(row.summary).toBe(`${post.source_id} fixture summary`);
      expect(
        (
          await database.pool.query(
            "SELECT source_id, source_fingerprint, projection_version, status FROM extraction_jobs WHERE segment_id=$1",
            [row.id],
          )
        ).rows,
      ).toEqual([
        {
          source_id: post.source_id,
          source_fingerprint: row.source_fingerprint,
          projection_version: post.projection_version,
          status: "succeeded",
        },
      ]);
      if (nativePost) {
        expect(post).not.toHaveProperty("start_user_message_id");
        expect(post).not.toHaveProperty("end_user_message_id");
        for (const table of ["segments", "extraction_jobs"]) {
          const stored = (
            await database.pool.query(
              `SELECT start_user_message_id, end_user_message_id FROM ${table} WHERE source_id=$1`,
              [post.source_id],
            )
          ).rows;
          expect(stored).toEqual([
            { start_user_message_id: null, end_user_message_id: null },
          ]);
        }
      }
      const response = await fetch(
        `${backend}/v1/sessions/same-session/segments?source_id=${post.source_id}`,
        { headers: { "x-api-key": settings.reflectionApiKey } },
      );
      expect(response.status).toBe(200);
      const manifest = parseIngestSessionSegmentsResponse(
        await response.json(),
        post.source_id,
      );
      expect(manifest.manifest_version).toBe(nativePost ? 3 : 2);
      expect(manifest.boundaries).toHaveLength(nativePost ? 1 : 2);
      expect(manifest.boundaries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: row.id,
            source_eligible: true,
            source_fingerprint: row.source_fingerprint,
            projection_version: post.projection_version,
          }),
        ]),
      );
      expect(manifest.segments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: row.id, summary: row.summary }),
        ]),
      );
    }
    expect(new Set(pairs.map((pair) => pair.segment_id)).size).toBe(3);
    for (const [index, child] of children.entries()) {
      const search = await child.command("memory_search", {
        query: "paired recall",
      });
      const result: SearchResponse = JSON.parse(search.result);
      expect(result.claims).toHaveLength(1);
      expect(result.claims[0]).toMatchObject({
        subject: "Dual fixture",
        support_count: 3,
        session_count: 2,
      });
      expect(result.claims[0]!.segments).toHaveLength(3);
      expect(result.claims[0]!.segments).toEqual(expect.arrayContaining(pairs));
      const remote = pairs.find(
        (pair) =>
          pair.source_id === (index === 0 ? "fixture-v2" : "fixture-v1"),
      )!;
      const post = posts.find((post) => post.source_id === remote.source_id)!;
      const before = sourceReads.length;
      const read = await child.command("memory_read_segment", remote);
      expect(JSON.parse(read.result)).toMatchObject({
        ...remote,
        messages: post.messages,
      });
      expect(read.sdkReads).toBe(search.sdkReads);
      expect(
        sourceReads
          .slice(before)
          .every((path) => path.startsWith(`${remote.source_id}:`)),
      ).toBe(true);
      expect(sourceReads.length).toBeGreaterThan(before);
      const afterRead = sourceReads.length;
      const wrong = await child.command("memory_read_segment", {
        ...remote,
        source_id: index === 0 ? "fixture-v1" : "fixture-v2",
      });
      expect(JSON.parse(wrong.result)).toEqual({
        error: expect.stringMatching(/unavailable|404|not found/i),
      });
      expect(wrong.sdkReads).toBe(search.sdkReads);
      expect(sourceReads.length).toBe(afterRead);
      unavailable.add(remote.source_id);
      const outage = await child.command("memory_read_segment", remote);
      expect(JSON.parse(outage.result)).toEqual({
        error: expect.stringMatching(/unavailable|503/i),
      });
      expect(outage.sdkReads).toBe(search.sdkReads);
      unavailable.delete(remote.source_id);
      const restored = await child.command("memory_read_segment", remote);
      expect(JSON.parse(restored.result)).toMatchObject({
        ...remote,
        messages: post.messages,
      });
      expect(restored.sdkReads).toBe(search.sdkReads);
    }
    expect(sourceReads.some((path) => path.endsWith(":second"))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    // allSettled keeps one disposal failure from leaking the other child or backend.
    const disposed = await Promise.allSettled(
      children.map((child) => child.close()),
    );
    await Promise.all(
      servers.map(async (server) => {
        const closed = new Promise<void>((resolve) =>
          server.close(() => resolve()),
        );
        server.closeAllConnections();
        await closed;
      }),
    );
    try {
      await app.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    for (const outcome of disposed)
      if (outcome.status === "rejected") throw outcome.reason;
  }
}, 60000);
