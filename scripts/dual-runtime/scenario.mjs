import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  stat,
} from "node:fs/promises";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import {
  canonicalizeNativeHistory,
  hydrateNativeRange,
  readSegmentMessages,
  legacyHistory,
  estimateNativeTokens,
  ingestSegmentIdForRequest,
  ingestSourceFingerprint,
  ownedIngestRequest,
  segmentIdForRequest,
  sourceFingerprint,
} from "./oracle.mjs";
import { assertFixtureEnvironment } from "./fixture-env.mjs";
assertFixtureEnvironment(process.env);
const { Pool } = createRequire("/repo/server/package.json")("pg");
const db = new Pool({ connectionString: process.env.DATABASE_URL });

const state = "/state";
const started = Date.now();
const deadline = started + 300_000;
const assertions = [];
const proxyRequests = [];
const providerRequests = [];
const children = [];
const servers = [];
const sourceIDs = { v1: "fixture-v1", v2: "fixture-v2" };
const passwords = { v1: "fixture-v1", v2: "fixture-v2" };
const fact = "Fixture service uses fixture memory.";
let phase = "bootstrap";
let manifestOutage = false;
let sourceOutage;
let extractionHold = false;
const heldExtractions = [];
const sourceRequests = [];
const extractionRequests = [];
const toolRuns = {};
const fixtureErrors = [];
const diagnostics = {};
const notice = "[System-generated Reflection context";
let backgroundCalls = 0;
let releaseChild;
let childProviderHeld = false;
let imageSteps = 0;
let toolSequence = 0;
let pressureTurn;
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

function check(name, condition, detail) {
  assertions.push({
    phase,
    name,
    passed: Boolean(condition),
    ...(detail === undefined ? {} : { detail }),
  });
  assert.ok(condition, name);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function digest(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
function basic(password) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}
function env(extra) {
  return { PATH: "/usr/local/bin:/usr/bin:/bin", TMPDIR: "/tmp", ...extra };
}
function start(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  const entry = { child, output: "" };
  children.push(entry);
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      entry.output = (entry.output + data).slice(-24_000);
    });
  return entry;
}
async function closeChild(entry) {
  if (
    !entry ||
    entry.child.exitCode !== null ||
    entry.child.signalCode !== null
  )
    return;
  entry.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => entry.child.once("exit", resolve)),
    sleep(2_000),
  ]);
  if (entry.child.exitCode === null && entry.child.signalCode === null) {
    entry.child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => entry.child.once("exit", resolve)),
      sleep(1000),
    ]);
  }
}
async function listen(port, handler) {
  const server = createServer((request, response) =>
    Promise.resolve(handler(request, response)).catch((error) => {
      fixtureErrors.push(String(error));
      response.writeHead(500).end();
    }),
  );
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}
async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}
function completion(response, content, tool) {
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(chunk({ role: "assistant" }, null));
  if (tool)
    response.write(
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: `call_${tool.name}_${++toolSequence}`,
              type: "function",
              function: {
                name: tool.name,
                arguments: JSON.stringify(tool.arguments),
              },
            },
          ],
        },
        null,
      ),
    );
  else response.write(chunk({ content }, null));
  response.end(chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n");
}
function toolResult(messages) {
  const content = messages.findLast(
    (message) => message.role === "tool",
  )?.content;
  if (content == null) throw new Error("missing actual host tool result");
  return JSON.parse(
    typeof content === "string"
      ? content
      : content.map((part) => part.text ?? "").join(""),
  );
}
async function startFixtures() {
  await listen(4100, async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions")
      return response.writeHead(404).end();
    const owner = Object.keys(sourceIDs).find(
      (key) => request.headers.authorization === `Bearer fixture-host-${key}`,
    );
    if (!owner) return response.writeHead(401).end();
    const value = await body(request);
    value.harness = {
      phase,
      owner,
      ...(phase === "pressure" ? { pressureTurn } : {}),
    };
    providerRequests.push(value);
    const messages = value.messages ?? [];
    if (phase === "image-archive" && imageSteps++ < 8)
      return completion(response, "", {
        name: "shell",
        arguments: {
          command: `node -e "process.stdout.write('CP012_IMAGE_STEP_${imageSteps}_' + 's'.repeat(16000))"`,
          timeout: 2000,
        },
      });
    if (phase === "background") {
      const users = JSON.stringify(
        messages.filter((message) => message.role === "user"),
      );
      if (
        users.includes("CP012_CHILD_REQUEST") &&
        !users.includes("CP012_BACKGROUND_PARENT")
      ) {
        childProviderHeld = true;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 20000);
          releaseChild = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        return completion(
          response,
          "CP012_CHILD_COMPLETED_CONTENT " + fact + "c".repeat(7000),
        );
      }
      if (backgroundCalls++ === 0) {
        const schema = value.tools.find(
          (tool) => tool.function.name === "subagent",
        )?.function.parameters;
        check(
          "actual native subagent schema exposes background and agent",
          schema?.properties.background?.type === "boolean" &&
            schema.required.includes("agent"),
        );
        return completion(response, "", {
          name: "subagent",
          arguments: {
            agent: "general",
            description: "CP012 independent child work",
            prompt: "CP012_CHILD_REQUEST " + fact,
            background: true,
          },
        });
      }
      return completion(response, "CP012_PARENT_ACK_STABLE");
    }
    const run = toolRuns[owner];
    if (phase.startsWith("tools-") && run) {
      if (++run.calls > 6)
        throw new Error("tool fixture exceeded bounded model loop");
      if (run.step === "search") {
        run.step = "search-result";
        return completion(response, "", {
          name: "memory_search",
          arguments: { query: "Fixture service" },
        });
      }
      if (run.step === "search-result") {
        run.search = toolResult(messages);
        const pairs = (run.search.claims ?? []).flatMap(
          (claim) => claim.segments ?? [],
        );
        check(
          `${owner} search returns both actual source owners`,
          Object.values(sourceIDs).every((id) =>
            pairs.some((pair) => pair.source_id === id),
          ),
        );
        run.pair = pairs.find((pair) => pair.source_id !== sourceIDs[owner]);
        run.step = "read";
      }
      if (run.step === "read") {
        run.step = "read-result";
        return completion(response, "", {
          name: "memory_read_segment",
          arguments: run.pair,
        });
      }
      if (run.step === "read-result") {
        run.result = toolResult(messages);
        run.step = "done";
      }
      return completion(response, "CP012_TOOL_READ_DONE");
    }
    return completion(response, "CP012_HOST_REPLY_" + "r".repeat(2000));
  });
  await listen(4101, async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions")
      return response.writeHead(404).end();
    if (request.headers.authorization !== "Bearer fixture-openrouter")
      return response.writeHead(401).end();
    const value = await body(request);
    if (
      !["reflection_extraction", "entity_resolution"].includes(
        value.response_format?.json_schema?.name,
      )
    )
      return response.writeHead(400).end();
    extractionRequests.push({ phase, value });
    const content = String(value.messages?.at(-1)?.content ?? "{}");
    const input = JSON.parse(content);
    const supported = (input.source_messages ?? []).some(
      (message) =>
        typeof message.text === "string" && message.text.includes(fact),
    );
    let result;
    if (value.response_format?.json_schema?.name === "reflection_extraction") {
      if (extractionHold)
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 20000);
          heldExtractions.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      const marker = createHash("sha256")
        .update(JSON.stringify(input.source_messages))
        .digest("hex")
        .slice(0, 24);
      result = {
        summary: `CP012_SUMMARY_${marker}: ${supported ? fact : "NO_FACT: no supported fixture fact in this source range."}`,
        claims: supported
          ? [
              {
                subject: "Fixture service",
                predicate: "uses",
                confidence: 1,
                object_kind: "literal",
                object_text: "fixture memory",
              },
            ]
          : [],
      };
    } else if (
      value.response_format?.json_schema?.name === "entity_resolution"
    ) {
      const mentions = input.mentions ?? [];
      result = {
        claims: (input.proposed_claims ?? []).map((claim) => ({
          claim_id: claim.claim_id,
          action: supported ? "keep" : "drop",
          reason: supported ? "supported" : "unsupported",
        })),
        resolutions: mentions.map((mention) => ({
          mention_id: mention.mention_id,
          candidate_entity_id:
            mention.candidates?.find(
              (candidate) => candidate.canonical_name === mention.text,
            )?.entity_id ?? null,
          same_new_entity_as: null,
        })),
      };
    } else return response.writeHead(400).end();
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        choices: [
          {
            message: { content: JSON.stringify(result) },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  await listen(4102, async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/embeddings")
      return response.writeHead(404).end();
    if (request.headers.authorization !== "Bearer fixture-voyage")
      return response.writeHead(401).end();
    const value = await body(request);
    if (
      value.output_dimension !== 1024 ||
      !Array.isArray(value.input) ||
      !value.input.every((input) => typeof input === "string") ||
      !["query", "document"].includes(value.input_type)
    )
      return response.writeHead(400).end();
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        data: value.input.map((_input, index) => ({
          index,
          embedding: [1, ...Array(1023).fill(0)],
        })),
      }),
    );
  });
  await listen(4200, async (request, response) => {
    if (request.headers["x-api-key"] !== "fixture-reflection")
      return response.writeHead(401).end();
    const payload = await body(request);
    const entry = {
      phase,
      method: request.method,
      path: request.url,
      body: payload,
    };
    proxyRequests.push(entry);
    if (
      manifestOutage &&
      /^\/v1\/sessions\/[^/]+\/segments\?/.test(request.url)
    ) {
      entry.status = 503;
      return response.writeHead(503).end();
    }
    const upstream = await fetch(`http://127.0.0.1:8000${request.url}`, {
      method: request.method,
      headers: {
        "content-type": "application/json",
        "x-api-key": String(request.headers["x-api-key"] ?? ""),
      },
      body: ["GET", "HEAD"].includes(request.method)
        ? undefined
        : JSON.stringify(payload),
    });
    entry.status = upstream.status;
    entry.result = await upstream.json();
    response
      .writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      })
      .end(JSON.stringify(entry.result));
  });
  for (const [owner, port, target] of [
    ["v1", 4305, 4095],
    ["v2", 4306, 4096],
  ])
    await listen(port, async (request, response) => {
      if ("x-api-key" in request.headers) return response.writeHead(400).end();
      if (request.headers.authorization !== basic(passwords[owner]))
        return response.writeHead(401).end();
      if (
        request.method !== "GET" ||
        !/^\/(?:api\/)?(?:session(?:\/|\?|$)|config(?:\?|$)|info$)/.test(
          request.url,
        )
      )
        return response.writeHead(404).end();
      const url = new URL(request.url, `http://127.0.0.1:${target}`);
      const messagePage = /^\/(?:api\/)?session\/[^/]+\/message$/.test(
        url.pathname,
      );
      const incomingCursor = url.searchParams.get(
        owner === "v1" ? "before" : "cursor",
      );
      if (messagePage) url.searchParams.set("limit", "7");
      const entry = {
        phase,
        owner,
        path: request.url,
        outgoingPath: url.pathname + url.search,
        messagePage,
        incomingCursor,
        outgoingCursor: url.searchParams.get(
          owner === "v1" ? "before" : "cursor",
        ),
        headersPresent: {
          basic: Boolean(request.headers.authorization),
          apiKey: "x-api-key" in request.headers,
        },
        outage: sourceOutage === owner,
      };
      sourceRequests.push(entry);
      if (sourceOutage === owner) return response.writeHead(503).end();
      const upstream = await fetch(url, {
        headers: { authorization: request.headers.authorization },
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      if (!upstream) return response.writeHead(503).end();
      const text = await upstream.text();
      const next = upstream.headers.get("x-next-cursor");
      entry.status = upstream.status;
      if (messagePage && upstream.ok) {
        const page = JSON.parse(text);
        entry.messageCount = owner === "v1" ? page.length : page.data.length;
        entry.nextCursor = owner === "v1" ? next : page.cursor.next;
      }
      entry.headersPresent.nextCursor = next !== null;
      response
        .writeHead(upstream.status, {
          "content-type": "application/json",
          ...(next === null ? {} : { "x-next-cursor": next }),
        })
        .end(text);
    });
}
function runOperator(args) {
  const result = spawnSync(
    "node",
    ["/repo/scripts/source-ownership.mjs", ...args],
    { env: process.env, encoding: "utf8", timeout: 60_000 },
  );
  if (result.status !== 0)
    throw new Error(`operator ${args[0]} failed: ${result.stderr}`);
}
async function backendReady() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch("http://127.0.0.1:8000/healthz", {
        headers: { "x-api-key": "fixture-reflection" },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("actual Reflection server did not become healthy");
}
async function api(host, password, path, payload) {
  const response = await fetch(`http://127.0.0.1:${host}${path}`, {
    method: payload === undefined ? "GET" : "POST",
    headers: {
      authorization: basic(password),
      "content-type": "application/json",
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(20_000),
  }).catch((error) => {
    throw new Error(`${host}${path}: ${error.name}`, { cause: error });
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${host}${path}: ${response.status} ${text.slice(0, 800)}`);
  return text ? JSON.parse(text) : undefined;
}
async function waitV1() {
  for (let i = 0; i < 150; i += 1) {
    try {
      return await api(4095, passwords.v1, "/global/health");
    } catch {
      await sleep(100);
    }
  }
  throw new Error("v1 host did not become healthy");
}
async function waitV2() {
  for (let i = 0; i < 150; i += 1) {
    try {
      return await api(4096, passwords.v2, "/api/info");
    } catch {
      await sleep(100);
    }
  }
  throw new Error("v2 host did not become healthy");
}
async function v1History(id) {
  const messages = [];
  const seen = new Set();
  let before;
  do {
    const query = new URLSearchParams({
      limit: "7",
      ...(before ? { before } : {}),
    });
    const response = await fetch(
      `http://127.0.0.1:4095/session/${id}/message?${query}`,
      {
        headers: { authorization: basic(passwords.v1) },
        signal: AbortSignal.timeout(5000),
      },
    );
    assert.ok(response.ok, "direct v1 oracle history available");
    messages.unshift(...(await response.json()));
    before = response.headers.get("x-next-cursor");
    assert.ok(
      !before || !seen.has(before),
      "direct v1 oracle cursor progresses",
    );
    seen.add(before);
  } while (before);
  return messages;
}
async function v2History(id) {
  const values = [];
  let cursor;
  do {
    const query = new URLSearchParams({
      limit: "100",
      ...(cursor ? { cursor } : { order: "asc" }),
    });
    const page = await api(
      4096,
      passwords.v2,
      `/api/session/${id}/message?${query}`,
    );
    values.push(...page.data);
    cursor = page.cursor.next;
  } while (cursor);
  return values;
}
async function waitJobs() {
  let settledSince;
  let previousCount = -1;
  for (let i = 0; Date.now() < deadline; i += 1) {
    const posts = proxyRequests.filter(
      (request) => request.method === "POST" && request.path === "/v1/segments",
    );
    if (posts.length >= 2) {
      const queue = await fetch("http://127.0.0.1:8000/v1/queue", {
        headers: { "x-api-key": "fixture-reflection" },
      }).then((response) => response.json());
      if (queue.job_counts.failed > 0) {
        diagnostics.failedJobs = (
          await db.query(
            "SELECT id, source_id, status, error FROM extraction_jobs WHERE status = 'failed'",
          )
        ).rows;
        throw new Error(
          "real extraction job failed; see diagnostics.failedJobs",
        );
      }
      if (
        queue.job_counts.pending === 0 &&
        queue.job_counts.running === 0 &&
        queue.job_counts.failed === 0
      ) {
        if (posts.length !== previousCount || settledSince === undefined)
          settledSince = Date.now();
        if (Date.now() - settledSince >= 1000) return posts;
      } else settledSince = undefined;
      previousCount = posts.length;
    }
    await sleep(Math.min(100 + i * 10, 1_000));
  }
  throw new Error("real extraction jobs did not settle");
}
async function routeSources(path) {
  const config = JSON.parse(await readFile(path, "utf8"));
  config.sources[sourceIDs.v1].url = "http://127.0.0.1:4305";
  config.sources[sourceIDs.v2].url = "http://127.0.0.1:4306";
  await writeFile(path, JSON.stringify(config));
}
async function nativePrompt(id, text, extra = {}) {
  await api(4096, passwords.v2, `/api/session/${id}/prompt`, {
    text,
    resume: true,
    ...extra,
  });
  await api(4096, passwords.v2, `/api/experimental/session/${id}/wait`, {});
}
async function toolRound(owner, pair) {
  toolRuns[owner] = { step: pair ? "read" : "search", pair, calls: 0 };
  if (owner === "v1") {
    const session = await api(4095, passwords.v1, "/session", {
      title: "CP012 tool execution",
    });
    await api(4095, passwords.v1, `/session/${session.id}/message`, {
      model: { providerID: "probe", modelID: "model" },
      parts: [{ type: "text", text: "CP012_TOOL_DRIVE" }],
    });
  } else {
    const session = await api(4096, passwords.v2, "/api/session", {
      title: "CP012 tool execution",
      location: { directory: `${state}/v2/workspace` },
      model: { providerID: "probe", id: "tools" },
    });
    await nativePrompt(session.data.id, "CP012_TOOL_DRIVE");
  }
  return toolRuns[owner];
}
async function expectedRead(pair) {
  const metadata = await fetch(
    `http://127.0.0.1:8000/v1/segments/${pair.segment_id}?source_id=${pair.source_id}`,
    { headers: { "x-api-key": "fixture-reflection" } },
  ).then((response) => response.json());
  return canonicalRange(
    metadata,
    pair.source_id === sourceIDs.v2
      ? await v2History(metadata.session_id)
      : await v1History(metadata.session_id),
  );
}
function canonicalRange(metadata, history) {
  if (metadata.source_boundary_version === 3)
    return hydrateNativeRange(canonicalizeNativeHistory(history), metadata);
  return readSegmentMessages(legacyHistory(history), {
    id: metadata.id,
    sourceBoundaryVersion: metadata.source_boundary_version,
    startSourceMessageId: metadata.start_source_message_id,
    endSourceMessageId: metadata.end_source_message_id,
    startUserMessageId: metadata.start_user_message_id,
    endUserMessageId: metadata.end_user_message_id,
  });
}
async function verifyPersistence() {
  await waitJobs();
  const acceptedRequests = proxyRequests.filter(
    (entry) =>
      entry.method === "POST" &&
      entry.path === "/v1/segments" &&
      entry.status >= 200 &&
      entry.status < 300,
  );
  const sources = (
    await db.query(
      "SELECT source_id AS id, kind, identity_scheme FROM reflection_sources",
    )
  ).rows;
  const segments = (await db.query("SELECT * FROM segments")).rows;
  const jobs = (await db.query("SELECT * FROM extraction_jobs")).rows;
  const targets = (await db.query("SELECT * FROM segment_targets")).rows;
  const histories = new Map();
  diagnostics.persistence = { sources, accepted: [], committed: [] };
  for (const owner of ["v1", "v2"]) {
    const source = await fetch(
      `http://127.0.0.1:8000/v1/sources/${sourceIDs[owner]}`,
      { headers: { "x-api-key": "fixture-reflection" } },
    ).then((response) => response.json());
    check(
      `${owner} registry and PG identity scheme match production ownership`,
      source.identity_scheme === (owner === "v1" ? "legacy" : "source-v1") &&
        sources.some(
          (row) =>
            row.id === source.id &&
            row.kind === source.kind &&
            row.identity_scheme === source.identity_scheme,
        ),
    );
    const accepted = acceptedRequests.filter(
      (entry) => entry.body.source_id === source.id,
    );
    const verified = [];
    for (const entry of accepted) {
      const request = entry.body;
      const key = `${source.id}/${request.session_id}`;
      if (!histories.has(key))
        histories.set(
          key,
          owner === "v1"
            ? await v1History(request.session_id)
            : await v2History(request.session_id),
        );
      const id = ingestSegmentIdForRequest(request, source);
      const fingerprint = ingestSourceFingerprint(request);
      verified.push({
        id,
        sourceFingerprint: fingerprint,
        jobID: entry.result.id,
        responseSegmentID: entry.result.segment_id,
        identity:
          id === entry.result.segment_id &&
          jobs.some(
            (job) =>
              String(job.id) === String(entry.result.id) &&
              job.segment_id === id &&
              job.source_id === source.id,
          ),
        fingerprint: fingerprint === entry.result.source_fingerprint,
        canonical:
          JSON.stringify(request.messages) ===
          JSON.stringify(
            canonicalRange({ ...request, id }, histories.get(key)),
          ),
        legacy:
          owner !== "v1" ||
          (id === segmentIdForRequest(request) &&
            fingerprint === sourceFingerprint(request)),
      });
    }
    diagnostics.persistence.accepted.push({ owner, requests: verified });
    check(
      `${owner} every accepted request has production UUID and source fingerprint`,
      verified.length > 0 &&
        verified.every(
          (item) => item.identity && item.fingerprint && item.legacy,
        ),
      { requests: verified.length },
    );
    check(
      `${owner} every accepted canonical payload equals its actual full-history range`,
      verified.every((item) => item.canonical),
    );
    const committed = segments
      .filter((segment) => segment.source_id === source.id)
      .map((segment) => {
        const target = targets.find(
          (target) =>
            target.segment_id === segment.id && target.source_id === source.id,
        );
        const job = jobs.find(
          (job) =>
            job.segment_id === segment.id &&
            job.source_id === source.id &&
            job.status === "succeeded" &&
            String(job.source_generation) ===
              String(segment.source_generation) &&
            job.source_fingerprint === segment.source_fingerprint,
        );
        const request = accepted.findLast(
          (entry) =>
            ingestSegmentIdForRequest(entry.body, source) === segment.id &&
            ingestSourceFingerprint(entry.body) === segment.source_fingerprint,
        )?.body;
        return {
          id: segment.id,
          generation: segment.source_generation,
          priority: job?.processing_priority,
          valid: Boolean(
            request &&
              job &&
              !target &&
              segment.id === ingestSegmentIdForRequest(request, source) &&
              segment.source_fingerprint === ingestSourceFingerprint(request) &&
              segment.source_fingerprint === job.source_fingerprint &&
              String(segment.source_generation) ===
                String(job.source_generation) &&
              JSON.stringify(request.messages) ===
                JSON.stringify(
                  canonicalRange(
                    { ...request, id: segment.id },
                    histories.get(`${source.id}/${segment.session_id}`),
                  ),
                ),
          ),
        };
      });
    diagnostics.persistence.committed.push({ owner, segments: committed });
    check(
      `${owner} latest committed PG rows agree with accepted payload and job generation; completed targets removed`,
      committed.length > 0 && committed.every((item) => item.valid),
      { segments: committed.length },
    );
  }
  check(
    "native PG segment and job user boundaries are SQL NULL",
    [segments, jobs].every(
      (rows) =>
        rows.some((row) => row.source_boundary_version === 3) &&
        rows
          .filter((row) => row.source_boundary_version === 3)
          .every(
            (row) =>
              row.start_user_message_id === null &&
              row.end_user_message_id === null,
          ),
    ),
  );
  check(
    "persistence barrier covers every accepted request without concurrent additions",
    proxyRequests.filter(
      (entry) =>
        entry.method === "POST" &&
        entry.path === "/v1/segments" &&
        entry.status >= 200 &&
        entry.status < 300,
    ).length === acceptedRequests.length,
  );
  const unsupported = (
    await db.query(
      "SELECT s.id, count(c.id)::int AS claims FROM segments s LEFT JOIN claims c ON c.segment_id = s.id WHERE s.summary LIKE '%NO_FACT:%' GROUP BY s.id",
    )
  ).rows;
  check(
    "no-fact source ranges persist summaries without invented claims",
    unsupported.length > 0 && unsupported.every((row) => row.claims === 0),
  );
}
async function main() {
  check(
    "isolated database starts empty",
    (await db.query("SELECT to_regclass('public.segments') AS relation"))
      .rows[0].relation === null,
  );
  await mkdir(`${state}/v1`, { mode: 0o700 });
  await mkdir(`${state}/v2`, { mode: 0o700 });
  await mkdir(`${state}/v1/workspace`, { recursive: true });
  await mkdir(`${state}/v2/workspace`, { recursive: true });
  await startFixtures();
  for (const [port, path] of [
    [4100, "/v1/chat/completions"],
    [4101, "/v1/chat/completions"],
    [4102, "/v1/embeddings"],
  ]) {
    check(
      `upstream ${port} rejects missing authentication`,
      (
        await fetch(`http://127.0.0.1:${port}${path}`, {
          method: "POST",
          body: "{}",
        })
      ).status === 401,
    );
    check(
      `upstream ${port} rejects unexpected path`,
      (
        await fetch(`http://127.0.0.1:${port}/unexpected`, {
          method: "POST",
          body: "{}",
        })
      ).status === 404,
    );
  }
  for (const [owner, port] of [
    ["v1", 4305],
    ["v2", 4306],
  ])
    check(
      `${owner} source proxy rejects Reflection key even with correct Basic auth`,
      (
        await fetch(`http://127.0.0.1:${port}/session/missing/message`, {
          headers: {
            authorization: basic(passwords[owner]),
            "x-api-key": "fixture-reflection",
          },
        })
      ).status === 400,
    );
  check(
    "extraction fixture rejects unknown response schema",
    (
      await fetch("http://127.0.0.1:4101/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer fixture-openrouter" },
        body: JSON.stringify({
          messages: [{ content: "{}" }],
          response_format: { json_schema: { name: "unknown" } },
        }),
      })
    ).status === 400,
  );
  check(
    "embedding fixture rejects unknown input type",
    (
      await fetch("http://127.0.0.1:4102/v1/embeddings", {
        method: "POST",
        headers: { authorization: "Bearer fixture-voyage" },
        body: JSON.stringify({
          input: ["test"],
          output_dimension: 1024,
          input_type: "invalid",
        }),
      })
    ).status === 400,
  );
  runOperator(["expand"]);
  runOperator([
    "register",
    "--id",
    sourceIDs.v1,
    "--kind",
    "opencode-v1",
    "--identity-scheme",
    "legacy",
  ]);
  runOperator([
    "register",
    "--id",
    sourceIDs.v2,
    "--kind",
    "opencode-v2",
    "--identity-scheme",
    "source-v1",
  ]);
  runOperator(["install-indexes"]);
  runOperator(["cutover", "--old-writers-stopped"]);
  runOperator(["enforce", "--old-writers-stopped"]);
  const backend = start("node", ["/repo/server/dist/main.js"], {
    env: process.env,
  });
  await backendReady();
  await cp("/warm-v1/.config/opencode", `${state}/v1/home/.config/opencode`, {
    recursive: true,
  });
  await mkdir(`${state}/v1/home/.config/opencode/plugins`, { recursive: true });
  await cp(
    "/bundles/reflection.js",
    `${state}/v1/home/.config/opencode/plugins/reflection.js`,
  );
  await writeFile(
    `${state}/v1/home/.config/opencode/opencode.json`,
    JSON.stringify({
      model: "probe/model",
      small_model: "probe/model",
      share: "disabled",
      autoupdate: false,
      compaction: { auto: false, prune: false },
      provider: {
        probe: {
          npm: "@ai-sdk/openai-compatible",
          name: "Fixture",
          options: {
            baseURL: "http://127.0.0.1:4100/v1",
            apiKey: "fixture-host-v1",
          },
          models: {
            model: { name: "Fixture", limit: { context: 24000, output: 1000 } },
          },
        },
      },
    }),
  );
  await writeFile(
    `${state}/v1/home/.config/opencode/reflection.json`,
    JSON.stringify({
      url: "http://127.0.0.1:4200",
      apiKey: "fixture-reflection",
      sourceId: sourceIDs.v1,
      sources: {
        [sourceIDs.v1]: {
          kind: "opencode-v1",
          url: "http://127.0.0.1:4095",
          username: "opencode",
          password: passwords.v1,
        },
        [sourceIDs.v2]: {
          kind: "opencode-v2",
          url: "http://127.0.0.1:4096",
          username: "opencode",
          password: passwords.v2,
        },
      },
      contextProjection: { enabled: true },
    }),
  );
  await routeSources(`${state}/v1/home/.config/opencode/reflection.json`);
  const v1 = start(
    "/opt/opencode-v1/bin/opencode",
    ["serve", "--print-logs", "--hostname", "127.0.0.1", "--port", "4095"],
    {
      cwd: `${state}/v1/workspace`,
      env: env({
        HOME: `${state}/v1/home`,
        XDG_CONFIG_HOME: `${state}/v1/home/.config`,
        XDG_CACHE_HOME: `${state}/v1/cache`,
        XDG_DATA_HOME: `${state}/v1/data`,
        XDG_STATE_HOME: `${state}/v1/state`,
        OPENCODE_SERVER_PASSWORD: passwords.v1,
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      }),
    },
  );
  await mkdir(`${state}/v2/home`, { recursive: true });
  await mkdir(`${state}/v2/plugin`, { recursive: true });
  await cp("/bundles/reflection-v2.js", `${state}/v2/plugin/index.js`);
  await writeFile(
    `${state}/v2/reflection.json`,
    JSON.stringify({
      url: "http://127.0.0.1:4200",
      apiKey: "fixture-reflection",
      sourceId: sourceIDs.v2,
      sources: {
        [sourceIDs.v1]: {
          kind: "opencode-v1",
          url: "http://127.0.0.1:4095",
          username: "opencode",
          password: passwords.v1,
        },
        [sourceIDs.v2]: {
          kind: "opencode-v2",
          url: "http://127.0.0.1:4096",
          username: "opencode",
          password: passwords.v2,
        },
      },
      contextProjection: { enabled: true },
    }),
  );
  await writeFile(
    `${state}/v2/config.json`,
    JSON.stringify({
      model: "probe/model",
      update: "disable",
      share: "disabled",
      snapshots: false,
      warming: false,
      compaction: { auto: false },
      plugins: [
        {
          package: `${state}/v2/plugin`,
          options: { configPath: `${state}/v2/reflection.json` },
        },
      ],
      providers: {
        probe: {
          package: "@opencode/ai/providers/openai-compatible",
          transport: "http",
          settings: {
            baseURL: "http://127.0.0.1:4100/v1",
            apiKey: "fixture-host-v2",
          },
          models: {
            model: {
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 24000, output: 1000 },
            },
            anchor: {
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 40000, output: 1000 },
            },
            tools: {
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 96000, output: 1000 },
            },
          },
        },
      },
    }),
  );
  await routeSources(`${state}/v2/reflection.json`);
  await mkdir(`${state}/v2/observer`, { recursive: true });
  await writeFile(
    `${state}/v2/observer/index.js`,
    `export default { id: 'cp012-title-only', async setup(ctx) { await ctx.session.hook('title', event => { event.result = 'CP012 fixture'; }); } };`,
  );
  const nativeConfig = JSON.parse(
    await readFile(`${state}/v2/config.json`, "utf8"),
  );
  nativeConfig.plugins.push({ package: `${state}/v2/observer` });
  nativeConfig.providers.probe.models.smaller = {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 20000, output: 1000 },
  };
  nativeConfig.providers.probe.models.tools.capabilities.input.push("image");
  nativeConfig.providers.probe.models.anchor.capabilities.input.push("image");
  nativeConfig.providers.probe.models.image = {
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    limit: { context: 80000, output: 1000 },
  };
  await writeFile(`${state}/v2/config.json`, JSON.stringify(nativeConfig));
  const startNative = () =>
    start(
      "/opt/opencode-v2/bin/opencode",
      ["serve", "--hostname", "127.0.0.1", "--port", "4096"],
      {
        cwd: `${state}/v2/workspace`,
        env: env({
          HOME: `${state}/v2/home`,
          XDG_CONFIG_HOME: `${state}/v2/config`,
          XDG_CACHE_HOME: `${state}/v2/cache`,
          XDG_DATA_HOME: `${state}/v2/data`,
          XDG_STATE_HOME: `${state}/v2/state`,
          OPENCODE_PASSWORD: passwords.v2,
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_CONFIG: `${state}/v2/config.json`,
        }),
      },
    );
  let v2 = startNative();
  const v1Version = spawnSync("/opt/opencode-v1/bin/opencode", ["--version"], {
    encoding: "utf8",
  });
  const v2Version = spawnSync("/opt/opencode-v2/bin/opencode", ["--version"], {
    encoding: "utf8",
  });
  check(
    "published v1 binary version",
    v1Version.status === 0 &&
      `${v1Version.stdout}${v1Version.stderr}`.includes("1.18.29"),
  );
  check(
    "published v2 binary version",
    v2Version.status === 0 &&
      `${v2Version.stdout}${v2Version.stderr}`.includes("2.0.8"),
  );
  await waitV1();
  await waitV2();
  check(
    "v1 rejects unauthenticated Basic request",
    (await fetch("http://127.0.0.1:4095/global/health")).status === 401,
  );
  check(
    "v2 rejects unauthenticated Basic request",
    (await fetch("http://127.0.0.1:4096/api/info")).status === 401,
  );
  const one = await api(4095, passwords.v1, "/session", {
    title: "CP012 fixed nondefault title",
  });
  const two = await api(4096, passwords.v2, "/api/session", {
    title: "CP012 fixed nondefault title",
    location: { directory: `${state}/v2/workspace` },
    model: { providerID: "probe", id: "model" },
  });
  const v1id = one.id;
  const v2id = two.data.id;
  phase = "pressure";
  let originalNative;
  for (let index = 0; index < 16; index += 1) {
    pressureTurn = index;
    await api(4095, passwords.v1, `/session/${v1id}/message`, {
      model: { providerID: "probe", modelID: "model" },
      parts: [
        { type: "text", text: `${fact} CP012_V1_${index} ${"x".repeat(7000)}` },
      ],
    });
    await api(4096, passwords.v2, `/api/session/${v2id}/prompt`, {
      text: `${fact} CP012_V2_${index} ${"x".repeat(7000)}`,
      resume: true,
    });
    await api(4096, passwords.v2, `/api/experimental/session/${v2id}/wait`, {});
    check(
      `native pressure turn ${index} completes`,
      (await v2History(v2id)).filter(
        (item) => item.type === "assistant" && item.time?.completed,
      ).length ===
        index + 1,
    );
    if (index === 0) originalNative = await v2History(v2id);
  }
  const posts = await waitJobs();
  const v1Messages = await v1History(v1id);
  const v2Messages = await v2History(v2id);
  check(
    "both actual hosts completed ordinary responses",
    JSON.stringify(v1Messages).includes("CP012_HOST_REPLY") &&
      JSON.stringify(v2Messages).includes("CP012_HOST_REPLY"),
  );
  check(
    "both plugins register memory tools exactly once",
    ["v1", "v2"].every((owner) =>
      providerRequests.some(
        (request) =>
          request.harness.owner === owner &&
          ["memory_search", "memory_read_segment"].every(
            (name) =>
              (request.tools ?? []).filter(
                (tool) => tool.function?.name === name,
              ).length === 1,
          ),
      ),
    ),
  );
  check(
    "actual backend received owned native and legacy segment requests",
    posts.some(
      (post) =>
        post.body.source_id === sourceIDs.v1 &&
        [1, 2].includes(post.body.source_boundary_version),
    ) &&
      posts.some(
        (post) =>
          post.body.source_id === sourceIDs.v2 &&
          post.body.source_boundary_version === 3,
      ),
  );
  check(
    "native payload has no fabricated user boundaries",
    proxyRequests
      .filter((request) => request.body?.source_boundary_version === 3)
      .every(
        (request) =>
          !("start_user_message_id" in request.body) &&
          !("end_user_message_id" in request.body),
      ),
  );
  const persisted = {};
  for (const owner of ["v1", "v2"]) {
    const entries = await readdir(`${state}/${owner}/data`, {
      recursive: true,
      withFileTypes: true,
    });
    persisted[owner] = [];
    for (const entry of entries.filter(
      (entry) => entry.isFile() && /\.(db|sqlite|sqlite3)$/.test(entry.name),
    )) {
      const path = `${entry.parentPath}/${entry.name}`;
      const info = await stat(path);
      if (
        (await readFile(path)).subarray(0, 16).toString() ===
        "SQLite format 3\0"
      )
        persisted[owner].push({ path, inode: info.ino, size: info.size });
    }
  }
  diagnostics.persisted = persisted;
  check(
    "both source state prefixes are private to the fixture user",
    ((await stat(`${state}/v1`)).mode & 0o077) === 0 &&
      ((await stat(`${state}/v2`)).mode & 0o077) === 0,
  );
  check(
    "actual hosts persist separate nonempty SQLite databases in their XDG data trees",
    persisted.v1.length > 0 &&
      persisted.v2.length > 0 &&
      persisted.v1.every((one) =>
        persisted.v2.every(
          (two) =>
            one.path !== two.path &&
            one.inode !== two.inode &&
            one.size > 0 &&
            two.size > 0,
        ),
      ),
  );
  const legacySessions = await api(4095, passwords.v1, "/session");
  const nativeSessions = await api(
    4096,
    passwords.v2,
    "/api/session?limit=100",
  );
  check(
    "actual host session lists exclude the other host session",
    legacySessions.some((item) => item.id === v1id) &&
      !legacySessions.some((item) => item.id === v2id) &&
      nativeSessions.data.some((item) => item.id === v2id) &&
      !nativeSessions.data.some((item) => item.id === v1id),
  );
  const effectiveLegacy = await api(4095, passwords.v1, "/config");
  const effectiveNative = await api(
    4096,
    passwords.v2,
    `/api/config?location[directory]=${encodeURIComponent(`${state}/v2/workspace`)}`,
  );
  diagnostics.effectivePlugins = {
    legacy: effectiveLegacy.plugin,
    native: effectiveNative
      .filter((item) => item.type === "document")
      .flatMap((item) => item.info.plugins ?? []),
  };
  check(
    "effective legacy config loads exactly the real Reflection bundle",
    effectiveLegacy.plugin?.length === 1 &&
      effectiveLegacy.plugin[0] ===
        `file://${state}/v1/home/.config/opencode/plugins/reflection.js`,
  );
  check(
    "effective native config loads exactly Reflection and the separate title-only helper",
    diagnostics.effectivePlugins.native.length === 2 &&
      diagnostics.effectivePlugins.native.filter(
        (item) => item.package === `${state}/v2/plugin`,
      ).length === 1 &&
      diagnostics.effectivePlugins.native.filter(
        (item) => item.package === `${state}/v2/observer`,
      ).length === 1,
  );
  check(
    "backend extraction fixture was exercised",
    extractionRequests.some(
      (request) =>
        request.value.response_format?.json_schema?.name ===
        "reflection_extraction",
    ) && proxyRequests.some((request) => request.path === "/v1/segments"),
  );
  check(
    "no host process exited during core composition",
    v1.child.exitCode === null &&
      v2.child.exitCode === null &&
      backend.child.exitCode === null,
  );
  const summaries = (
    await db.query("SELECT id, source_id, summary FROM segments")
  ).rows;
  for (const owner of ["v1", "v2"]) {
    const projected = providerRequests.filter(
      (request) =>
        request.harness.owner === owner &&
        JSON.stringify(request.messages).includes(
          owner === "v1"
            ? "This is system-generated context restoration"
            : notice,
        ),
    );
    check(`${owner} actual pressure projection`, projected.length > 0);
    check(
      `${owner} notice contains real PG segment summary`,
      projected.some((request) =>
        summaries.some(
          (row) =>
            row.source_id === sourceIDs[owner] &&
            JSON.stringify(request.messages).includes(row.summary),
        ),
      ),
    );
    check(
      `${owner} latest user exact once in projected requests`,
      projected.every((request) => {
        const text = JSON.stringify(request.messages);
        const actualUser = `${fact} CP012_${owner.toUpperCase()}_${request.harness.pressureTurn} ${"x".repeat(7000)}`;
        return text.split(actualUser).length === 2;
      }),
    );
  }
  check(
    "native raw history retains every original user unchanged",
    Array.from(
      { length: 16 },
      (_, i) => `${fact} CP012_V2_${i} ${"x".repeat(7000)}`,
    ).every((text) => JSON.stringify(v2Messages).includes(text)) &&
      !JSON.stringify(v2Messages).includes(notice) &&
      !v2Messages.some((item) => item.type === "compaction"),
  );
  check(
    "native pre-projection raw messages remain byte-identical",
    originalNative.every(
      (item) =>
        JSON.stringify(v2Messages.find((next) => next.id === item.id)) ===
        JSON.stringify(item),
    ),
  );
  check(
    "legacy raw history retains every original user unchanged",
    Array.from(
      { length: 16 },
      (_, i) => `${fact} CP012_V1_${i} ${"x".repeat(7000)}`,
    ).every((text) => JSON.stringify(v1Messages).includes(text)) &&
      !JSON.stringify(v1Messages).includes(
        "This is system-generated context restoration",
      ) &&
      !v1Messages.some((item) => item.info?.summary === true),
  );
  for (const owner of ["v1", "v2"]) {
    phase = `tools-${owner}`;
    const run = await toolRound(owner);
    check(
      `${owner} cross-owner exact ordered message array`,
      JSON.stringify(run.result?.messages) ===
        JSON.stringify(await expectedRead(run.pair)),
    );
    const wrong = await toolRound(owner, {
      ...run.pair,
      source_id: sourceIDs[owner],
    });
    check(
      `${owner} wrong source pair refused`,
      Boolean(wrong.result?.error) && !wrong.result?.messages,
    );
    sourceOutage = owner === "v1" ? "v2" : "v1";
    const failed = await toolRound(owner, run.pair);
    check(
      `${owner} source HTTP outage refuses without fallback`,
      Boolean(failed.result?.error) && !failed.result?.messages,
    );
    sourceOutage = undefined;
    const resumed = await toolRound(owner, run.pair);
    check(
      `${owner} source recovery exact ordered messages`,
      JSON.stringify(resumed.result?.messages) ===
        JSON.stringify(run.result.messages),
    );
    const target = owner === "v1" ? "v2" : "v1";
    const pages = sourceRequests.filter(
      (entry) =>
        entry.phase === phase &&
        entry.owner === target &&
        entry.messagePage &&
        entry.status === 200,
    );
    check(
      `${owner} cross-owner reader follows opaque seven-message page cursors`,
      pages.some((page) => page.messageCount === 7 && page.nextCursor) &&
        pages.some(
          (page) =>
            page.incomingCursor &&
            pages.some(
              (previous) => previous.nextCursor === page.incomingCursor,
            ),
        ) &&
        pages.every(
          (page) =>
            page.messageCount <= 7 &&
            page.incomingCursor === page.outgoingCursor &&
            !page.headersPresent.apiKey,
        ),
    );
  }
  check(
    "independent direct source histories extend beyond forced page size",
    v1Messages.length > 7 && v2Messages.length > 7,
  );
  phase = "manual-compaction";
  const beforeCompact = providerRequests.length;
  await api(4096, passwords.v2, `/api/session/${v2id}/compact`, {});
  await api(4096, passwords.v2, `/api/experimental/session/${v2id}/wait`, {});
  check(
    "manual native compaction veto zero dispatch",
    providerRequests.length === beforeCompact,
  );
  check(
    "manual native compaction has no completed checkpoint",
    !(await v2History(v2id)).some(
      (item) => item.type === "compaction" && item.status === "completed",
    ),
  );
  phase = "restart-prime";
  await nativePrompt(v2id, "CP012_CACHE_PRIME");
  await waitJobs();
  const cached = summaries
    .filter(
      (row) =>
        row.source_id === sourceIDs.v2 &&
        JSON.stringify(providerRequests.at(-1).messages).includes(row.summary),
    )
    .map((row) => row.summary);
  check(
    "verified PG summaries present before actual restart",
    cached.length > 0,
  );
  phase = "restart-outage";
  const beforeOutageExtractions = extractionRequests.length;
  const beforeRestartHistory = await v2History(v2id);
  const oldPID = v2.child.pid;
  manifestOutage = true;
  await closeChild(v2);
  v2 = startNative();
  await waitV2();
  const beforeRestart = providerRequests.length;
  await nativePrompt(v2id, "CP012_RESTART_RAW_LATEST");
  const restarted = providerRequests.slice(beforeRestart);
  const afterRestartHistory = await v2History(v2id);
  check(
    "same-state restart replaces process and keeps every prior raw message unchanged",
    v2.child.pid !== oldPID &&
      beforeRestartHistory.every(
        (item) =>
          JSON.stringify(
            afterRestartHistory.find((next) => next.id === item.id),
          ) === JSON.stringify(item),
      ),
  );
  check(
    "cached restart does not re-extract upstream",
    extractionRequests.length === beforeOutageExtractions,
  );
  check(
    "restart retains cached exact summary strings and latest user once",
    restarted.length > 0 &&
      restarted.some(
        (request) =>
          cached.every((summary) =>
            JSON.stringify(request.messages).includes(summary),
          ) &&
          JSON.stringify(request.messages).split("CP012_RESTART_RAW_LATEST")
            .length === 2,
      ),
  );
  check(
    "restart has live registry and manifest-only 503",
    proxyRequests.some(
      (request) =>
        request.phase === phase &&
        request.path.startsWith("/v1/sources/") &&
        request.status === 200,
    ) &&
      proxyRequests.some(
        (request) => request.phase === phase && request.status === 503,
      ),
  );
  phase = "restart-recovery";
  manifestOutage = false;
  await nativePrompt(v2id, "CP012_AFTER_RESTART_RECOVERY " + "z".repeat(7000));
  await nativePrompt(v2id, "CP012_CLOSE_RECOVERY_RANGE " + "z".repeat(7000));
  await waitJobs();
  check(
    "restart recovery commits new real worker summary",
    proxyRequests.some(
      (request) =>
        request.phase === phase &&
        request.path === "/v1/segments" &&
        request.method === "POST",
    ) && extractionRequests.some((request) => request.phase === phase),
  );
  phase = "auto-compaction";
  await mkdir(`${state}/v2/auto-workspace`, { recursive: true });
  await writeFile(
    `${state}/v2/auto-workspace/opencode.json`,
    JSON.stringify({ compaction: { auto: true } }),
  );
  const auto = await api(4096, passwords.v2, "/api/session", {
    title: "CP012 auto enabled",
    location: { directory: `${state}/v2/auto-workspace` },
    model: { providerID: "probe", id: "tools" },
  });
  const effective = await api(
    4096,
    passwords.v2,
    `/api/config?location[directory]=${encodeURIComponent(`${state}/v2/auto-workspace`)}`,
  );
  check(
    "separate workspace effective automatic compaction true",
    effective
      .filter((item) => item.type === "document" && item.info.compaction)
      .at(-1)?.info.compaction.auto === true,
  );
  const beforeAuto = providerRequests.length;
  await nativePrompt(auto.data.id, "CP012_AUTO_MUST_REFUSE");
  check(
    "automatic compaction true refuses dispatch",
    providerRequests.length === beforeAuto &&
      v2.output.includes("effective compaction.auto must be false"),
  );
  phase = "budget-shrink";
  const beforeShrink = providerRequests.length;
  await api(4096, passwords.v2, `/api/session/${v2id}/model`, {
    model: { providerID: "probe", id: "smaller" },
  });
  await nativePrompt(v2id, "CP012_SMALLER_LATEST");
  const smaller = providerRequests.slice(beforeShrink);
  check(
    "actual smaller model continuation safely dispatches",
    smaller.length > 0 &&
      smaller.every(
        (request) =>
          request.model === "smaller" &&
          estimateNativeTokens({
            messages: request.messages,
            tools: request.tools,
          }) <= Math.floor(0.9 * (20000 - 1000)) &&
          JSON.stringify(request.messages).split("CP012_SMALLER_LATEST")
            .length === 2,
      ),
    smaller.map((request) => ({
      model: request.model,
      estimatedInputTokensIncludingTools: estimateNativeTokens({
        messages: request.messages,
        tools: request.tools,
      }),
      outputReserve: 1000,
      hardInputBudget: Math.floor(0.9 * (20000 - 1000)),
    })),
  );
  phase = "upstream-hold";
  extractionHold = true;
  const pending = await api(4096, passwords.v2, "/api/session", {
    title: "CP012 pending extraction",
    location: { directory: `${state}/v2/workspace` },
    model: { providerID: "probe", id: "model" },
  });
  const holdStart = Date.now();
  for (let index = 0; index < 10; index++)
    await nativePrompt(
      pending.data.id,
      `CP012_HELD_${index} ` + "h".repeat(7000),
    );
  const queue = await fetch("http://127.0.0.1:8000/v1/queue", {
    headers: { "x-api-key": "fixture-reflection" },
  }).then((response) => response.json());
  check(
    "held actual extraction leaves real queue pending while prompts complete",
    heldExtractions.length > 0 &&
      queue.job_counts.pending + queue.job_counts.running > 0 &&
      Date.now() - holdStart < 20000,
  );
  check(
    "pending extraction explicitly marks missing summaries",
    providerRequests.some(
      (request) =>
        request.harness.phase === phase &&
        JSON.stringify(request.messages).includes("missing-or-stale-summary"),
    ),
  );
  const heldTargets = (
    await db.query(
      "SELECT *, payload->>'start_user_message_id' AS start_user_message_id FROM segment_targets WHERE source_id = $1",
      [sourceIDs.v2],
    )
  ).rows;
  diagnostics.heldTargets = heldTargets;
  check(
    "held native PG targets have SQL NULL user boundaries and exact production source fingerprints",
    heldTargets.length > 0 &&
      heldTargets.every(
        (target) =>
          target.start_user_message_id === null &&
          target.end_user_message_id === null &&
          target.source_fingerprint ===
            ingestSourceFingerprint(
              ownedIngestRequest(target.payload, sourceIDs.v2),
            ) &&
          proxyRequests.some(
            (entry) =>
              entry.path === "/v1/segments" &&
              entry.body?.source_id === sourceIDs.v2 &&
              ingestSourceFingerprint(entry.body) ===
                target.source_fingerprint &&
              isDeepStrictEqual(entry.body.messages, target.payload.messages),
          ),
      ),
  );
  phase = "upstream-recovery";
  extractionHold = false;
  for (const release of heldExtractions) release();
  await waitJobs();
  check(
    "released extraction commits real PG summary",
    (
      await db.query(
        "SELECT count(*)::int AS count FROM segments WHERE source_id = $1 AND session_id = $2",
        [sourceIDs.v2, pending.data.id],
      )
    ).rows[0].count > 0,
  );
  await nativePrompt(pending.data.id, "CP012_PENDING_RECOVERED");
  check(
    "recovery projects committed summary",
    JSON.stringify(providerRequests.at(-1).messages).includes("CP012_SUMMARY_"),
  );
  for (const imagePhase of ["image-ordinary", "image-archive"]) {
    phase = imagePhase;
    const image = await api(4096, passwords.v2, "/api/session", {
      title: "CP012 image",
      location: { directory: `${state}/v2/workspace` },
      model: {
        providerID: "probe",
        id: imagePhase === "image-archive" ? "image" : "tools",
      },
    });
    await nativePrompt(image.data.id, "CP012_IMAGE_LATEST", {
      files: [{ uri: `data:image/png;base64,${png}`, name: "fixture.png" }],
    });
    const imageHistory = await v2History(image.data.id);
    const requests = providerRequests.filter(
      (request) => request.harness.phase === phase,
    );
    const images = requests
      .flatMap((request) => request.messages)
      .filter((message) => message.role === "user")
      .flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      )
      .filter((part) => part.type === "image_url");
    check(
      `${phase} actual provider image bytes preserved`,
      requests.length > 0 &&
        images.length === requests.length &&
        images.every(
          (part) => part.image_url.url === `data:image/png;base64,${png}`,
        ),
    );
    check(
      `${phase} native raw image unchanged`,
      imageHistory.find((item) => item.type === "user")?.files?.[0]?.data ===
        png && !imageHistory.some((item) => item.type === "compaction"),
    );
    if (imagePhase === "image-archive") {
      diagnostics.image = {
        requests: requests.map((request) => ({
          tokens: estimateNativeTokens(request.messages),
          projected: JSON.stringify(request.messages).includes(notice),
          copied: JSON.stringify(request.messages).includes(
            "[Latest actual user input, copied verbatim]",
          ),
        })),
        history: imageHistory,
      };
      check(
        "image archive executes eight real bounded tools",
        imageSteps === 9 &&
          requests.length === 9 &&
          imageHistory
            .flatMap((item) => item.content ?? [])
            .filter(
              (part) =>
                part.type === "tool" &&
                part.name === "shell" &&
                part.state?.status === "completed" &&
                part.state?.metadata?.exit === 0,
            ).length === 8,
      );
      check(
        "archived image latest-user anchor restored exactly once",
        requests.some(
          (request) =>
            JSON.stringify(request.messages).includes(notice) &&
            JSON.stringify(request.messages).includes(
              "[Latest actual user input, copied verbatim]",
            ) &&
            JSON.stringify(request.messages).split("CP012_IMAGE_LATEST")
              .length === 2,
        ),
      );
    }
  }
  phase = "background";
  const parent = await api(4096, passwords.v2, "/api/session", {
    title: "CP012 background",
    location: { directory: `${state}/v2/workspace` },
    model: { providerID: "probe", id: "tools" },
  });
  await nativePrompt(parent.data.id, "CP012_BACKGROUND_PARENT");
  const acknowledged = await v2History(parent.data.id);
  check(
    "parent acknowledgement persisted before child release",
    childProviderHeld &&
      JSON.stringify(acknowledged).includes("CP012_PARENT_ACK_STABLE") &&
      !JSON.stringify(acknowledged).includes("CP012_CHILD_COMPLETED_CONTENT"),
  );
  releaseChild();
  let completed;
  for (let attempt = 0; attempt < 100; attempt++) {
    completed = await v2History(parent.data.id);
    if (JSON.stringify(completed).includes("CP012_CHILD_COMPLETED_CONTENT"))
      break;
    await sleep(100);
  }
  const notifications = completed.filter(
    (item) =>
      !acknowledged.some((old) => old.id === item.id) &&
      JSON.stringify(item).includes("CP012_CHILD_COMPLETED_CONTENT"),
  );
  check(
    "later child completion is synthetic not user",
    notifications.length > 0 &&
      notifications.every((item) => item.type === "synthetic"),
  );
  const childID = notifications[0]?.text.match(/sessionID="([^"]+)"/)?.[1];
  const childInfo =
    childID && (await api(4096, passwords.v2, `/api/session/${childID}`));
  check(
    "background is genuine parent-child session lineage",
    childInfo?.data.parentID === parent.data.id &&
      JSON.stringify(await v2History(childID)).includes(
        "CP012_CHILD_COMPLETED_CONTENT",
      ),
  );
  check(
    "parent ack remains byte-stable",
    acknowledged
      .filter((item) =>
        JSON.stringify(item).includes("CP012_PARENT_ACK_STABLE"),
      )
      .every(
        (item) =>
          JSON.stringify(completed.find((next) => next.id === item.id)) ===
          JSON.stringify(item),
      ),
  );
  phase = "background-ingestion";
  await api(
    4096,
    passwords.v2,
    `/api/experimental/session/${parent.data.id}/wait`,
    {},
  );
  await api(4096, passwords.v2, `/api/session/${parent.data.id}/model`, {
    model: { providerID: "probe", id: "model" },
  });
  for (let i = 0; i < 8; i++)
    await nativePrompt(
      parent.data.id,
      `CP012_CLOSE_CHILD_RANGE_${i} ` + "k".repeat(7000),
    );
  await waitJobs();
  diagnostics.background = {
    notifications,
    records: canonicalizeNativeHistory(await v2History(parent.data.id)).map(
      (record) => ({
        ...record,
        raw: undefined,
        source: { ...record.source, text: record.source.text.slice(0, 1000) },
      }),
    ),
    posts: proxyRequests.filter(
      (request) => request.body?.session_id === parent.data.id,
    ),
  };
  check(
    "real plugin ingests synthetic child completion",
    proxyRequests.some(
      (request) =>
        request.path === "/v1/segments" &&
        request.body?.session_id === parent.data.id &&
        JSON.stringify(request.body.messages).includes(
          "CP012_CHILD_COMPLETED_CONTENT",
        ),
    ),
  );
  const childPost = proxyRequests.find(
    (request) =>
      request.path === "/v1/segments" &&
      request.body?.session_id === parent.data.id &&
      JSON.stringify(request.body.messages).includes(
        "CP012_CHILD_COMPLETED_CONTENT",
      ),
  );
  const childSegment = (
    await db.query(
      "SELECT id FROM segments WHERE source_id = $1 AND session_id = $2 AND start_source_message_id = $3 AND end_source_message_id = $4",
      [
        sourceIDs.v2,
        parent.data.id,
        childPost.body.start_source_message_id,
        childPost.body.end_source_message_id,
      ],
    )
  ).rows[0];
  phase = "tools-background-read";
  const childRead = await toolRound("v1", {
    source_id: sourceIDs.v2,
    segment_id: childSegment.id,
  });
  check(
    "later committed synthetic content is retrievable through actual host tool",
    JSON.stringify(childRead.result?.messages).includes(
      "CP012_CHILD_COMPLETED_CONTENT",
    ) &&
      JSON.stringify(childRead.result?.messages) ===
        JSON.stringify(await expectedRead(childRead.pair)),
  );
  phase = "persistence";
  await verifyPersistence();
  check(
    "strict fixtures have no protocol errors",
    fixtureErrors.length === 0,
    fixtureErrors,
  );
}

let failure;
let timeout;
try {
  await Promise.race([
    main(),
    new Promise((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("dual runtime exceeded 300 seconds")),
        300_000,
      );
    }),
  ]);
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  if (!assertions.some((item) => item.phase === phase && !item.passed))
    assertions.push({
      phase,
      name: "phase completes without runtime error",
      passed: false,
    });
} finally {
  clearTimeout(timeout);
  releaseChild?.();
  for (const release of heldExtractions) release();
  for (const child of children.reverse()) await closeChild(child);
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await db.end();
}
const report = {
  outcome: failure ? "failed" : "passed",
  elapsedMs: Date.now() - started,
  assertions,
  passed: assertions.filter((item) => item.passed).length,
  failed: assertions.filter((item) => !item.passed).length,
  failure,
  childOutput: children.map((item) => item.output),
  provenance: {
    v1BinarySha256: await digest("/opt/opencode-v1/bin/opencode"),
    v2BinarySha256: await digest("/opt/opencode-v2/bin/opencode"),
    v1PluginBundleSha256: await digest("/bundles/reflection.js"),
    v2PluginBundleSha256: await digest("/bundles/reflection-v2.js"),
    backendBundleSha256: await digest("/repo/server/dist/main.js"),
    oracleBundleSha256: await digest("/harness/oracle.mjs"),
    generatedWarmPnpmLockSha256: await digest(
      "/warm-v1/.config/opencode/pnpm-lock.yaml",
    ),
    generatedWarmNpmCompatibilityLockSha256: await digest(
      "/warm-v1/.config/opencode/package-lock.json",
    ),
  },
  remainingGates: [
    "Commercial-provider semantic/quality validation",
    "GTK end-to-end adoption",
    "Operator-approved production adoption (no production state imported or changed)",
  ],
  limitations: [
    "Separate terminal extraction failed-status/retry case not exercised; real upstream hold/pending/recovery is covered",
    "Media coverage is one inline PNG, ordinary and archived latest-user restoration; not all media formats",
    "Background ingestion is proven on subsequent closed ranges under projection pressure, not autonomous idle-only ingestion",
  ],
  evidence: {
    providerRequests,
    backendRequests: proxyRequests,
    sourceRequests,
    extractionRequests,
  },
};
report.phase = phase;
report.counts = {
  providerRequests: providerRequests.length,
  extractionRequests: extractionRequests.length,
  sourceReads: sourceRequests.length,
  backendRequests: proxyRequests.length,
};
report.nativeToolSchemas = providerRequests.find(
  (request) => request.harness.owner === "v2",
)?.tools;
report.toolRuns = toolRuns;
report.fixtureErrors = fixtureErrors;
report.diagnostics = diagnostics;
report.phaseCounts = Object.fromEntries(
  [...new Set(assertions.map((item) => item.phase))].map((name) => [
    name,
    {
      passed: assertions.filter((item) => item.phase === name && item.passed)
        .length,
      failed: assertions.filter((item) => item.phase === name && !item.passed)
        .length,
      providerRequests: providerRequests.filter(
        (item) => item.harness.phase === name,
      ).length,
    },
  ]),
);
report.internalGates = Object.fromEntries(
  [
    "bootstrap",
    "pressure",
    "tools-v1",
    "tools-v2",
    "manual-compaction",
    "restart-prime",
    "restart-outage",
    "restart-recovery",
    "auto-compaction",
    "budget-shrink",
    "upstream-hold",
    "upstream-recovery",
    "image-ordinary",
    "image-archive",
    "background",
    "background-ingestion",
    "tools-background-read",
    "persistence",
  ].map((name) => [
    name,
    failure && phase === name
      ? "failed"
      : report.phaseCounts[name]?.failed
        ? "failed"
        : report.phaseCounts[name]?.passed
          ? "passed"
          : "not-run",
  ]),
);
console.log(JSON.stringify(report));
if (failure) process.exitCode = 1;
