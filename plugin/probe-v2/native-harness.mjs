import {
  mkdir,
  writeFile,
  readdir,
  readFile,
  copyFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  parseNativeSegmentCreate,
  nativeSegmentIdForRequest,
  nativeSourceFingerprint,
  parseNativeJobResponse,
  parseNativeSegmentResponse,
  parseNativeSessionSegmentsResponse,
} from "../../packages/shared/src/native.ts";
import { parseSourceSegmentResponse } from "../../packages/shared/src/sources.ts";
import { canonicalizeNativeHistory } from "../../packages/opencode-v2-core/src/history.ts";
import { planNativeSegments } from "../../packages/opencode-v2-core/src/segmentation.ts";

const source = {
  id: "fixture-v2",
  kind: "opencode-v2",
  identity_scheme: "source-v1",
};
const legacySource = {
  id: "fixture-v1",
  kind: "opencode-v1",
  identity_scheme: "source-v1",
};
const legacyID = "11111111-1111-4111-8111-111111111111";
const legacyMessages = [
  {
    info: { id: "legacy-user", role: "user", time: { created: 1 } },
    parts: [{ type: "text", text: "LEGACY_USER_EXACT" }],
  },
  {
    info: {
      id: "legacy-assistant",
      role: "assistant",
      parentID: "legacy-user",
      time: { created: 2, completed: 3 },
    },
    parts: [{ type: "text", text: "LEGACY_ASSISTANT_EXACT" }],
  },
];
let legacyReads = 0;
const auth = `Basic ${Buffer.from("opencode:cp002-fixture-only").toString("base64")}`;
const assertions = [],
  requests = [],
  wire = [],
  posts = [],
  errors = [];
const segments = new Map(),
  modes = new Map(),
  loops = new Map();
const servers = [];
const diagnostics = {};
let heldPartialResponse;
const partialText = "NATIVE_PARTIAL_VISIBLE_TEXT";
const imageBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
let child,
  logs = "",
  phase = "setup";
const text = JSON.stringify;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function check(name, ok, detail) {
  assertions.push({
    name,
    ok: Boolean(ok),
    ...(detail === undefined ? {} : { detail }),
  });
}
function requireCheck(name, ok, detail) {
  check(name, ok, detail);
  if (!ok) throw new Error(name);
}
async function eventually(fn, name, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${name}`);
}
async function api(path, body) {
  const response = await fetch(`http://127.0.0.1:4096/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: text(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const value = await response.text();
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${value.slice(0, 500)}`);
  return value ? JSON.parse(value) : undefined;
}
async function history(id) {
  const result = [],
    seen = new Set();
  let cursor;
  do {
    const query = new URLSearchParams({
      limit: "7",
      ...(cursor ? { cursor } : { order: "asc" }),
    });
    const page = await api(`/session/${id}/message?${query}`);
    if (!Array.isArray(page.data) || !page.cursor)
      throw new Error("Invalid native history page");
    result.push(...page.data);
    cursor = page.cursor.next;
    if (cursor && seen.has(cursor)) throw new Error("Repeated history cursor");
    seen.add(cursor);
    if (seen.size > 100) throw new Error("History page limit");
  } while (cursor);
  return result;
}
async function session(
  label,
  model = "mock",
  directory = "/state/native-workspace",
) {
  const value = await api("/session", {
    title: label,
    location: { directory },
    model: { providerID: "probe", id: model },
  });
  return value.data.id;
}
async function prompt(id, value) {
  await api(`/session/${id}/prompt`, { text: value, resume: true });
  await api(`/experimental/session/${id}/wait`, {});
}
async function listen(port, handler) {
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const raw = Buffer.concat(chunks).toString();
      await handler(req, res, raw ? JSON.parse(raw) : undefined);
    } catch (error) {
      errors.push(String(error.stack ?? error));
      if (!res.headersSent) res.writeHead(500);
      res.end(text({ error: String(error) }));
    }
  });
  servers.push(server);
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
}
function manifest(id) {
  const entries = [...segments.values()].filter(
    (item) => item.request.session_id === id,
  );
  return parseNativeSessionSegmentsResponse(
    {
      source_id: source.id,
      session_id: id,
      manifest_version: 2,
      segments: entries
        .filter((item) => !item.pending)
        .map((item) => ({
          ...item.boundary,
          projection_version: 3,
          summary: item.summary,
        })),
      boundaries: entries
        .filter((item) => !item.pending)
        .map((item) => ({
          ...item.boundary,
          projection_version: 3,
          source_eligible: true,
          source_fingerprint: item.fingerprint,
        })),
      targets: entries.map((item) => ({
        ...item.boundary,
        projection_version: 3,
        source_fingerprint: item.fingerprint,
        status: item.pending ? "pending" : "succeeded",
      })),
    },
    source.id,
  );
}
async function reflection(req, res, body) {
  const url = new URL(req.url, "http://localhost");
  if (req.headers["x-api-key"] !== "native-fixture-only")
    throw new Error("Missing Reflection authentication");
  wire.push({ method: req.method, path: req.url, body });
  let value;
  if (url.pathname === `/v1/sources/${source.id}`) value = source;
  else if (url.pathname === `/v1/sources/${legacySource.id}`)
    value = legacySource;
  else if (url.pathname === `/v1/segments/${legacyID}`) {
    if (url.searchParams.get("source_id") !== legacySource.id)
      throw new Error("Unpaired legacy read");
    const now = new Date().toISOString();
    value = parseSourceSegmentResponse(
      {
        id: legacyID,
        source_id: legacySource.id,
        session_id: "legacy-session",
        source_boundary_version: 2,
        start_source_message_id: "legacy-user",
        end_source_message_id: "legacy-assistant",
        start_user_message_id: "legacy-user",
        end_user_message_id: "legacy-user",
        summary: "Legacy fixture",
        claims: [],
        created_at: now,
        updated_at: now,
      },
      legacySource.id,
    );
  } else if (url.pathname === "/v1/segments" && req.method === "POST") {
    const request = parseNativeSegmentCreate(body);
    const id = nativeSegmentIdForRequest(request, source);
    const fingerprint = nativeSourceFingerprint(request);
    posts.push(request);
    const boundary = {
      id,
      source_boundary_version: 3,
      start_source_message_id: request.start_source_message_id,
      end_source_message_id: request.end_source_message_id,
    };
    const pending = modes.get(request.session_id) === "pending";
    segments.set(id, {
      request,
      fingerprint,
      boundary,
      pending,
      summary: `NATIVE_VERIFIED_SUMMARY ${id}: deterministic fixture conversation.`,
    });
    const now = new Date().toISOString();
    value = parseNativeJobResponse(
      {
        source_id: source.id,
        id: posts.length,
        segment_id: id,
        source_fingerprint: fingerprint,
        projection_version: 3,
        source_boundary_version: 3,
        start_source_message_id: request.start_source_message_id,
        end_source_message_id: request.end_source_message_id,
        status: pending ? "pending" : "succeeded",
        attempts: 1,
        error: null,
        created_at: now,
        started_at: now,
        finished_at: pending ? null : now,
        next_attempt_at: now,
      },
      source.id,
    );
  } else if (/^\/v1\/sessions\/[^/]+\/segments$/.test(url.pathname)) {
    if (url.searchParams.get("source_id") !== source.id)
      throw new Error("Unpaired manifest read");
    const id = decodeURIComponent(url.pathname.split("/")[3]);
    if (modes.get(id) === "unavailable") {
      res.writeHead(503).end();
      return;
    }
    value = manifest(id);
    if (modes.get(id) === "wrong-source")
      value = { ...value, source_id: "wrong-source" };
  } else if (url.pathname === "/v1/search") {
    value = {
      claims: [],
      segments: [...segments.keys()].map((segment_id) => ({
        source_id: source.id,
        segment_id,
      })),
    };
  } else if (url.pathname.startsWith("/v1/segments/")) {
    if (url.searchParams.get("source_id") !== source.id)
      throw new Error("Unpaired segment read");
    const item = segments.get(url.pathname.split("/")[3]);
    if (!item) {
      res.writeHead(404).end();
      return;
    }
    const now = new Date().toISOString();
    value = parseNativeSegmentResponse(
      {
        ...item.boundary,
        source_id: source.id,
        session_id: item.request.session_id,
        summary: item.summary,
        claims: [],
        created_at: now,
        updated_at: now,
      },
      source.id,
    );
  } else
    throw new Error(`Unexpected Reflection route: ${req.method} ${req.url}`);
  wire.push({ response: value });
  res.writeHead(200, { "content-type": "application/json" }).end(text(value));
}
function complete(res, content, tool) {
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: `call_native_${requests.length}`,
            type: "function",
            function: { name: tool.name, arguments: text(tool.input) },
          },
        ],
      }
    : { content };
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [data, finish] of [
    [{ role: "assistant" }, null],
    [delta, null],
    [{}, tool ? "tool_calls" : "stop"],
  ]) {
    res.write(
      `data: ${text({ id: "native-fixture", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: data, finish_reason: finish }] })}\n\n`,
    );
  }
  res.end("data: [DONE]\n\n");
}
async function provider(req, res, body) {
  if (req.url !== "/v1/chat/completions")
    throw new Error(`Unexpected provider route ${req.url}`);
  requests.push({ phase, body });
  const all = text(body.messages),
    count = loops.get(phase) ?? 0;
  loops.set(phase, count + 1);
  if (
    phase === "partial-interrupt" &&
    all.includes("NATIVE_PARTIAL_INTERRUPT")
  ) {
    if (heldPartialResponse)
      throw new Error("Unexpected repeated partial-stream request");
    heldPartialResponse = res;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    for (const delta of [{ role: "assistant" }, { content: partialText }]) {
      res.write(
        `data: ${text({ id: "native-partial", object: "chat.completion.chunk", created: 0, model: "tools", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      );
    }
    // Intentionally no finish chunk, DONE sentinel, end(), or timer. Only the
    // native interrupt (or harness cleanup on failure) can close this stream.
    return;
  }
  if (phase === "tools" && count < 4) {
    const id = [...segments.keys()][0];
    const calls = [
      { name: "memory_search", input: { query: "native fixture" } },
      {
        name: "memory_read_segment",
        input: { source_id: source.id, segment_id: id },
      },
      {
        name: "memory_read_segment",
        input: { source_id: "not-configured", segment_id: id },
      },
      {
        name: "memory_read_segment",
        input: { source_id: legacySource.id, segment_id: legacyID },
      },
    ];
    return complete(res, null, calls[count]);
  }
  if (phase === "anchor" && count < 8)
    return complete(res, null, { name: "fixture_step", input: {} });
  if (phase === "async") {
    if (all.includes("NATIVE_ASYNC_RESULT"))
      return complete(res, "NATIVE_ASYNC_DONE");
    if (body.messages.some((message) => message.role === "tool"))
      return complete(res, "NATIVE_ASYNC_ACK");
    return complete(res, null, {
      name: "shell",
      input: {
        background: true,
        command:
          'i=0; while [ ! -f /state/release-native ]; do i=$((i+1)); [ "$i" -ge 200 ] && exit 124; sleep 0.05; done; printf NATIVE_ASYNC_; printf RESULT',
      },
    });
  }
  return complete(res, `NATIVE_REPLY_${phase}_` + "r".repeat(2000));
}
async function main() {
  await mkdir("/state/home", { recursive: true });
  await mkdir("/state/native-workspace", { recursive: true });
  await mkdir("/state/config/opencode", { recursive: true });
  await mkdir("/state/reflection-plugin", { recursive: true });
  await mkdir("/state/native-runner", { recursive: true });
  await copyFile(
    "/harness/reflection-v2.js",
    "/state/reflection-plugin/index.js",
  );
  // This helper never changes context, dispatch, compaction, or Reflection tools.
  await writeFile(
    "/state/native-runner/index.js",
    `import { appendFileSync } from "node:fs";
    export default { id: "native-fixture", async setup(ctx) {
    const stop = new AbortController();
    appendFileSync("/state/native-events.jsonl", JSON.stringify({kind:"setup", runtime:process.execPath, location:ctx.location}) + "\\n");
    const observe = (async () => { for await (const event of ctx.event.subscribe({signal:stop.signal})) {
      if (JSON.stringify(event).includes("session")) appendFileSync("/state/native-events.jsonl", JSON.stringify({kind:"event", location:ctx.location, event:{type:event.type, data:{sessionID:event.data?.sessionID, status:event.data?.status, keys:Object.keys(event.data ?? {}), ...(event.data?.delta === "NATIVE_PARTIAL_VISIBLE_TEXT" ? {delta:event.data.delta} : {}), ...(event.type?.startsWith("session.execution.") ? event.data : {})}}}) + "\\n");
    } })().catch(error => { if (!stop.signal.aborted) appendFileSync("/state/native-events.jsonl", JSON.stringify({kind:"observer-error", error:String(error)}) + "\\n"); });
    await ctx.session.hook("title", event => { event.result = "Native fixture"; });
    await ctx.tool.transform(editor => editor.add({ name: "fixture_step", description: "Return deterministic fixture output", options: { codemode: false }, input: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: "NATIVE_STEP_" + "s".repeat(8000) }) }));
    return async () => { stop.abort(); await observe; };
  } };`,
  );
  await writeFile(
    "/state/reflection-v2.json",
    text({
      url: "http://127.0.0.1:4200",
      apiKey: "native-fixture-only",
      sourceId: source.id,
      sources: {
        [source.id]: {
          kind: source.kind,
          url: "http://127.0.0.1:4096",
          username: "opencode",
          password: "cp002-fixture-only",
        },
        [legacySource.id]: {
          kind: legacySource.kind,
          url: "http://127.0.0.1:4300",
          username: "legacy",
          password: "legacy-fixture-only",
        },
      },
      contextProjection: { enabled: true },
    }),
  );
  const config = {
    model: "probe/mock",
    update: "disable",
    share: "disabled",
    snapshots: false,
    warming: false,
    compaction: { auto: false },
    plugins: [
      {
        package: "/state/reflection-plugin",
        options: { configPath: "/state/reflection-v2.json" },
      },
      { package: "/state/native-runner" },
    ],
    providers: {
      probe: {
        package: "@opencode/ai/providers/openai-compatible",
        transport: "http",
        settings: {
          baseURL: "http://127.0.0.1:4100/v1",
          apiKey: "fixture-only",
        },
        models: Object.fromEntries(
          [
            ["mock", 24000],
            ["anchor", 40000],
            ["tools", 96000],
          ].map(([id, context]) => [
            id,
            {
              capabilities: {
                tools: true,
                input: id === "tools" ? ["text", "image"] : ["text"],
                output: ["text"],
              },
              limit: { context, output: 1000 },
            },
          ]),
        ),
      },
    },
  };
  await writeFile("/state/native-config.json", text(config));
  await listen(4200, reflection);
  await listen(4100, provider);
  await listen(4300, (req, res) => {
    if (
      req.headers.authorization !==
        `Basic ${Buffer.from("legacy:legacy-fixture-only").toString("base64")}` ||
      !req.url.startsWith("/session/legacy-session/message?")
    )
      throw new Error("Invalid legacy reader request");
    legacyReads++;
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(text(legacyMessages));
  });
  child = spawn(
    "/opt/opencode/bin/opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", "4096"],
    {
      cwd: "/state/native-workspace",
      env: { ...process.env, OPENCODE_CONFIG: "/state/native-config.json" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      logs = (logs + chunk).slice(-24000);
    });
  child.on("error", (error) => errors.push(String(error)));
  await eventually(
    async () => {
      try {
        return Boolean(await api("/info"));
      } catch {
        return false;
      }
    },
    "native boot",
    20000,
  );
  phase = "ordinary";
  const ordinary = await session("ordinary");
  logs += `\nEffective config: ${text(await api("/config"))}\n`;
  await prompt(ordinary, "NATIVE_ORDINARY");
  check(
    "actual bundled plugin reaches authenticated source registry",
    wire.some((item) => item.path === `/v1/sources/${source.id}`),
  );
  // Check the independent veto even when the first projection reveals an adapter bug.
  if (requests.length === 0) {
    await api(`/session/${ordinary}/compact`, {});
    await api(`/experimental/session/${ordinary}/wait`, {});
    check(
      "manual compaction blocked with zero provider calls",
      requests.length === 0 &&
        !(await history(ordinary)).some(
          (item) => item.type === "compaction" && item.status === "completed",
        ),
    );
  }
  requireCheck(
    "actual plugin dispatches ordinary request",
    requests.length === 1,
    { requests: requests.length },
  );
  check(
    "actual plugin registers native memory tools",
    ["memory_search", "memory_read_segment"].every((name) =>
      requests[0].body.tools.some((tool) => tool.function?.name === name),
    ),
  );

  phase = "pressure";
  const pressure = await session("pressure");
  const markers = [];
  for (let i = 0; i < 16; i++) {
    const marker = `NATIVE_TURN_${i}_`;
    markers.push(marker);
    await prompt(pressure, marker + "u".repeat(2000));
    const turnHistory = await history(pressure);
    requireCheck(
      `pressure turn ${i} completed`,
      turnHistory.filter(
        (item) =>
          item.type === "assistant" &&
          item.time?.completed &&
          text(item).includes("NATIVE_REPLY_pressure"),
      ).length ===
        i + 1,
    );
  }
  const projected = requests.filter(
    (item) =>
      item.phase === phase &&
      text(item.body).includes("[System-generated Reflection context"),
  );
  check("pressure reaches actual Reflection projection", projected.length > 0);
  check(
    "projection contains verified summary",
    projected.some((item) =>
      text(item.body).includes("NATIVE_VERIFIED_SUMMARY"),
    ),
  );
  const full = await history(pressure);
  check(
    "latest user in raw tail is not duplicated or restored",
    projected.length > 0 &&
      projected.every((item) => {
        const value = text(item.body.messages);
        const latest = [...markers]
          .reverse()
          .find((marker) => value.includes(marker));
        return (
          latest != null &&
          value.split(latest).length === 2 &&
          !value.includes("[Latest actual user input, copied verbatim]")
        );
      }),
  );
  check(
    "projection never invokes native compaction",
    !full.some((item) => item.type === "compaction"),
  );
  check(
    "projection retains canonical full history",
    markers.every((marker) => text(full).includes(marker)) &&
      !text(full).includes("[System-generated Reflection context"),
  );
  requireCheck(
    "actual plugin ingests native source segments",
    posts.length > 0,
  );
  check(
    "native requests preserve typed arrays",
    posts.every(
      (post) =>
        Array.isArray(post.messages) &&
        post.messages.every((message) => typeof message.type === "string"),
    ),
  );

  phase = "tools";
  const tools = await session("tools", "tools");
  await prompt(tools, "NATIVE_TOOLS");
  const toolHistory = await history(tools);
  check(
    "actual memory search executes",
    wire.some((item) => item.path === "/v1/search"),
  );
  check(
    "actual paired native read executes",
    wire.some(
      (item) =>
        item.path?.startsWith("/v1/segments/") &&
        item.path.includes("source_id=fixture-v2"),
    ),
  );
  check(
    "native tool returns hydrated history",
    text(toolHistory).includes("stable ordered history") &&
      text(toolHistory).includes("NATIVE_TURN_"),
  );
  check(
    "native tool refusal is returned as text",
    text(toolHistory).includes("requested source is not configured") &&
      text(toolHistory).includes("NATIVE_REPLY_tools"),
  );
  check(
    "legacy cross-source read uses configured v1 endpoint",
    legacyReads === 1 &&
      text(toolHistory).includes("LEGACY_USER_EXACT") &&
      text(toolHistory).includes("LEGACY_ASSISTANT_EXACT"),
    {
      legacyReads,
      result: toolHistory
        .flatMap((item) => item.content ?? [])
        .filter(
          (part) => part.type === "tool" && text(part).includes(legacyID),
        ),
    },
  );

  phase = "anchor";
  const anchor = await session("anchor", "anchor");
  const anchorText = "NATIVE_LATEST_USER_" + "a".repeat(30000);
  await prompt(anchor, anchorText);
  const anchorHistory = await history(anchor);
  check(
    "anchor tool continuation reaches terminal reply",
    text(anchorHistory).includes("NATIVE_REPLY_anchor"),
  );
  check(
    "anchor completes eight real tools without native compaction",
    anchorHistory
      .flatMap((item) => item.content ?? [])
      .filter(
        (part) =>
          part.type === "tool" &&
          part.name === "fixture_step" &&
          part.state?.status === "completed",
      ).length === 8 &&
      !anchorHistory.some((item) => item.type === "compaction"),
  );
  const user = anchorHistory.find((item) => item.type === "user");
  const anchorProjected = requests.filter(
    (item) =>
      item.phase === phase &&
      text(item.body).includes("[System-generated Reflection context"),
  );
  check(
    "assistant-only continuation projects archived latest user",
    anchorProjected.length > 0 &&
      posts.some(
        (post) =>
          post.session_id === anchor &&
          post.messages.some((item) => item.id === user?.id),
      ),
  );
  check(
    "latest user restored exactly once in projected payload",
    anchorProjected.length > 0 &&
      anchorProjected.every(
        (item) =>
          text(item.body.messages).split(anchorText).length === 2 &&
          text(item.body.messages).includes(
            "[Latest actual user input, copied verbatim]",
          ),
      ),
  );
  check(
    "latest user retains canonical identity",
    anchorHistory.filter((item) => item.type === "user").length === 1 &&
      text(user).includes(anchorText),
  );

  phase = "unavailable";
  const priorPressurePayload = text(
    requests.filter((item) => item.phase === "pressure").at(-1)?.body.messages,
  );
  const cachedRanges = [...segments.values()].filter(
    (item) =>
      item.request.session_id === pressure &&
      priorPressurePayload.includes(item.summary),
  );
  requireCheck(
    "outage starts with uniquely identified verified summaries in projected payload",
    cachedRanges.length > 0,
  );
  modes.set(pressure, "unavailable");
  const beforeUnavailable = requests.length;
  const outageUser = "NATIVE_UNAVAILABLE_" + "u".repeat(2000);
  await prompt(pressure, outageUser);
  const cachedOutageRequests = requests.slice(beforeUnavailable);
  check(
    "manifest outage preserves exact verified cached summaries and latest user once",
    cachedOutageRequests.length === 1 &&
      cachedOutageRequests.every(
        (item) =>
          cachedRanges.every((range) =>
            text(item.body.messages).includes(range.summary),
          ) && text(item.body.messages).split(outageUser).length === 2,
      ) &&
      text(await history(pressure)).includes("NATIVE_REPLY_unavailable"),
  );
  const outageOmissions = cachedOutageRequests.flatMap((item) =>
    [
      ...text(item.body.messages).matchAll(
        /\[Reflection omitted ([^\]]+): missing-or-stale-summary\]/g,
      ),
    ].map((match) => match[1]),
  );
  const outagePlan = planNativeSegments({
    source,
    sessionId: pressure,
    records: canonicalizeNativeHistory(await history(pressure)),
    manifest: {
      source_id: source.id,
      session_id: pressure,
      manifest_version: 2,
      segments: [],
      boundaries: [],
      targets: [],
    },
  });
  check(
    "cached outage omits only genuinely uncached source ranges",
    outageOmissions.every(
      (span) =>
        !cachedRanges.some(
          (range) =>
            span ===
            `${range.boundary.start_source_message_id}..${range.boundary.end_source_message_id}`,
        ) &&
        outagePlan.some(
          (range) =>
            span ===
            `${range.request.start_source_message_id}..${range.request.end_source_message_id}`,
        ),
    ),
  );
  diagnostics.cachedOutage = {
    cachedSummaries: cachedRanges.map((range) => range.summary),
    omissions: outageOmissions,
  };
  modes.delete(pressure);
  phase = "recovered";
  await prompt(pressure, "NATIVE_RECOVERED");
  check(
    "manifest recovery resumes verified summaries",
    requests.some(
      (item) =>
        item.phase === phase &&
        text(item.body.messages).includes("NATIVE_VERIFIED_SUMMARY"),
    ) && text(await history(pressure)).includes("NATIVE_REPLY_recovered"),
  );

  phase = "uncached-outage";
  const uncached = await session("fresh uncached manifest outage");
  modes.set(uncached, "unavailable");
  for (let i = 0; i < 16; i++) {
    await prompt(uncached, `NATIVE_UNCACHED_${i}_` + "u".repeat(2000));
    requireCheck(
      `uncached outage turn ${i} completed`,
      (await history(uncached)).filter(
        (item) =>
          item.type === "assistant" &&
          item.time?.completed &&
          text(item).includes("NATIVE_REPLY_uncached-outage"),
      ).length ===
        i + 1,
    );
  }
  const uncachedRequests = requests.filter(
    (item) => item.phase === "uncached-outage",
  );
  check(
    "fresh uncached outage projects explicit missing-summary markers",
    uncachedRequests.some(
      (item) =>
        text(item.body.messages).includes(
          "[System-generated Reflection context",
        ) &&
        /\[Reflection omitted [^\]]+: missing-or-stale-summary\]/.test(
          text(item.body.messages),
        ),
    ),
  );
  check(
    "fresh uncached outage invents no verified summary or extraction completion",
    uncachedRequests.length === 16 &&
      uncachedRequests.every(
        (item) => !text(item.body.messages).includes("NATIVE_VERIFIED_SUMMARY"),
      ) &&
      !posts.some((post) => post.session_id === uncached) &&
      manifest(uncached).segments.length === 0,
  );
  modes.delete(uncached);
  phase = "uncached-recovered";
  await prompt(uncached, "NATIVE_UNCACHED_RECOVERED");
  requireCheck(
    "fresh outage first recovery turn completes",
    text(await history(uncached)).includes("NATIVE_REPLY_uncached-recovered"),
  );
  await eventually(
    () => manifest(uncached).segments.length > 0,
    "recovered idle ingestion publishes verified summaries",
    5000,
  );
  await prompt(uncached, "NATIVE_UNCACHED_RECOVERED_VERIFIED");
  const recoveredRanges = [...segments.values()].filter(
    (item) => item.request.session_id === uncached,
  );
  check(
    "fresh outage recovery introduces newly verified source-owned summaries",
    recoveredRanges.length > 0 &&
      requests.some(
        (item) =>
          item.phase === "uncached-recovered" &&
          recoveredRanges.some((range) =>
            text(item.body.messages).includes(range.summary),
          ),
      ) &&
      text(await history(uncached)).includes("NATIVE_REPLY_uncached-recovered"),
  );

  phase = "wrong-source";
  const rejected = await session("wrong source");
  modes.set(rejected, "wrong-source");
  const beforeRejected = requests.length;
  await prompt(rejected, "NATIVE_REJECT");
  check(
    "malformed ownership causes zero provider dispatch",
    requests.length === beforeRejected,
  );
  check(
    "rejected request produces no completed model assistant",
    !(await history(rejected)).some(
      (item) => item.type === "assistant" && item.time?.completed && item.model,
    ),
  );

  phase = "compact";
  const beforeCompact = requests.length;
  await api(`/session/${ordinary}/compact`, {});
  await api(`/experimental/session/${ordinary}/wait`, {});
  check(
    "manual compaction has zero provider dispatch",
    requests.length === beforeCompact,
  );
  check(
    "manual compaction never completes",
    !(await history(ordinary)).some(
      (item) => item.type === "compaction" && item.status === "completed",
    ),
  );

  phase = "async";
  const asyncID = await session("background shell");
  await prompt(asyncID, "NATIVE_ASYNC");
  const beforeAsync = await history(asyncID);
  check(
    "background shell acknowledged before release",
    text(beforeAsync).includes("NATIVE_ASYNC_ACK") &&
      !text(beforeAsync).includes("NATIVE_ASYNC_RESULT"),
  );
  await writeFile("/state/release-native", "release");
  await eventually(
    async () => text(await history(asyncID)).includes("NATIVE_ASYNC_DONE"),
    "background synthetic completion",
  );
  const afterAsync = await history(asyncID);
  check(
    "background completion appends synthetic source record",
    afterAsync.some(
      (item) =>
        item.type === "synthetic" && text(item).includes("NATIVE_ASYNC_RESULT"),
    ),
  );
  check(
    "background completion preserves source acknowledgment",
    beforeAsync
      .filter((item) => item.type === "assistant" && item.time?.completed)
      .every(
        (item) =>
          text(afterAsync.find((after) => after.id === item.id)) === text(item),
      ),
  );
  check(
    "native wire never fabricates user boundaries",
    wire.every(
      (item) =>
        !/start_user_message_id|end_user_message_id/.test(text(item)) ||
        item.response?.source_id === legacySource.id,
    ),
  );
  phase = "partial-interrupt";
  const partialSession = await session("partial stream interruption", "tools");
  diagnostics.partialSession = partialSession;
  await api(`/session/${partialSession}/prompt`, {
    text: "NATIVE_PARTIAL_INTERRUPT",
    resume: true,
  });
  let partialBefore;
  let streamingHistory;
  await eventually(
    async () => {
      const events = (await readFile("/state/native-events.jsonl", "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      streamingHistory = await history(partialSession);
      partialBefore = streamingHistory.find(
        (item) => item.type === "assistant",
      );
      return (
        partialBefore != null &&
        events.some(
          (item) =>
            item.event?.type === "session.text.delta" &&
            item.event.data.sessionID === partialSession &&
            item.event.data.delta === partialText,
        )
      );
    },
    "native emits exact partial delta and exposes source assistant before interruption",
    5000,
  );
  const streamingCanonical = canonicalizeNativeHistory(streamingHistory);
  const streamingSource = streamingCanonical.find(
    (record) => record.source.id === partialBefore.id,
  );
  check(
    "streaming source assistant remains canonically incomplete",
    partialBefore.time?.completed == null &&
      streamingSource?.complete === false,
  );
  const streamingPlan = planNativeSegments({
    source,
    sessionId: partialSession,
    records: streamingCanonical,
    manifest: manifest(partialSession),
    allowOpenSnapshot: true,
  });
  check(
    "no segment finalizes or submits the incomplete streaming source",
    streamingPlan.every(
      (segment) =>
        !segment.request.messages.some(
          (message) => message.id === partialBefore.id,
        ),
    ) &&
      !posts.some(
        (post) =>
          post.session_id === partialSession &&
          post.messages.some((message) => message.id === partialBefore.id),
      ),
  );
  requireCheck(
    "native partial delta arrives while provider stream remains unfinished",
    heldPartialResponse != null &&
      !heldPartialResponse.writableEnded &&
      !heldPartialResponse.destroyed &&
      !Number.isFinite(partialBefore?.time?.completed),
  );
  await api(`/session/${partialSession}/interrupt`, {});
  await api(`/experimental/session/${partialSession}/wait`, {});
  await eventually(
    () => heldPartialResponse.destroyed,
    "native interrupt closes held provider stream",
    5000,
  );
  const partialSettledHistory = await history(partialSession);
  requireCheck(
    "interrupted native assistant exists in settled history",
    partialSettledHistory.some((item) => item.id === partialBefore.id),
  );
  const partialSettled = partialSettledHistory.find(
    (item) => item.id === partialBefore.id,
  );
  const settledCanonical = canonicalizeNativeHistory(partialSettledHistory);
  diagnostics.partial = {
    beforeInterrupt: partialBefore,
    apiTextBufferedDuringStream: !text(partialBefore).includes(partialText),
    streamingSourceComplete: streamingSource?.complete,
    streamingPlannedSegmentCount: streamingPlan.length,
    session: await api(`/session/${partialSession}`),
    active: await api("/session/active"),
    assistant: {
      id: partialSettled?.id,
      time: partialSettled?.time,
      error: partialSettled?.error,
      tools: (partialSettled?.content ?? [])
        .filter((part) => part.type === "tool")
        .map((part) => ({ id: part.id, state: part.state })),
    },
    canonical: settledCanonical.map((record) => ({
      id: record.source.id,
      type: record.source.type,
      complete: record.complete,
      text: record.source.text.slice(0, 500),
    })),
  };
  check(
    "interruption completes source and preserves exact canonical partial text",
    Number.isFinite(partialSettled?.time?.completed) &&
      settledCanonical.some(
        (record) =>
          record.source.id === partialBefore.id &&
          record.complete &&
          record.source.text === partialText,
      ),
  );
  phase = "partial-resume";
  await prompt(partialSession, "NATIVE_AFTER_INTERRUPT_" + "c".repeat(24000));
  const resumedHistory = await history(partialSession);
  const resumedCanonical = canonicalizeNativeHistory(resumedHistory);
  check(
    "normal prompt after interruption reaches terminal reply",
    text(resumedHistory).includes("NATIVE_REPLY_partial-resume"),
  );
  const prior = resumedCanonical.find(
    (record) => record.source.id === partialBefore.id,
  );
  check(
    "interrupted source has no permanent incomplete barrier after resume",
    prior?.complete === true && prior.source.text.includes(partialText),
    { id: prior?.source.id, complete: prior?.complete },
  );
  const resumePlan = planNativeSegments({
    source,
    sessionId: partialSession,
    records: resumedCanonical,
    manifest: manifest(partialSession),
  });
  check(
    "closed segmentation crosses interrupted record without losing partial text",
    resumePlan.some(
      (segment) =>
        segment.closed &&
        segment.request.messages.some(
          (message) =>
            message.id === partialBefore.id &&
            message.text.includes(partialText),
        ),
    ) &&
      resumePlan.some((segment) =>
        segment.request.messages.some((message) =>
          message.text.includes("NATIVE_AFTER_INTERRUPT_"),
        ),
      ),
  );
  check(
    "partial interruption and resume never invoke native compaction",
    !resumedHistory.some((item) => item.type === "compaction"),
  );
  diagnostics.partial.afterResume = resumedCanonical.map((record) => ({
    id: record.source.id,
    type: record.source.type,
    complete: record.complete,
  }));

  phase = "image";
  const imageSession = await session("native image input", "tools");
  diagnostics.imageSession = imageSession;
  await writeFile("/state/tiny.png", Buffer.from(imageBase64, "base64"));
  await api(`/session/${imageSession}/prompt`, {
    text: "NATIVE_IMAGE_INPUT",
    files: [{ uri: "file:///state/tiny.png" }],
    resume: true,
  });
  await api(`/experimental/session/${imageSession}/wait`, {});
  const imageHistory = await history(imageSession);
  const imageUser = imageHistory.find((item) => item.type === "user");
  const imageCanonical = canonicalizeNativeHistory(imageHistory).find(
    (record) => record.source.id === imageUser?.id,
  );
  const imageRequests = requests.filter((item) => item.phase === "image");
  const images = imageRequests
    .flatMap((item) => item.body.messages)
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .filter((part) => part.type === "image_url");
  check(
    "actual image prompt dispatches and completes",
    imageRequests.length === 1 &&
      text(imageHistory).includes("NATIVE_REPLY_image"),
  );
  check(
    "provider receives original PNG bytes as one image_url",
    images.length === 1 &&
      images[0].image_url?.url === `data:image/png;base64,${imageBase64}`,
  );
  check(
    "native canonical image descriptor omits binary explicitly",
    imageCanonical != null &&
      imageCanonical.source.text.includes("NATIVE_IMAGE_INPUT") &&
      imageCanonical.source.text.includes("binary content omitted") &&
      imageCanonical.source.text.includes("image/png") &&
      !imageCanonical.source.text.includes(imageBase64),
  );
  check(
    "canonicalization preserves original native image bytes",
    imageCanonical != null &&
      text(imageCanonical.raw) === text(imageUser) &&
      imageUser.files?.some(
        (file) => file.mime === "image/png" && file.data === imageBase64,
      ),
  );
  check(
    "ordinary image prompt uses no projection or native compaction",
    imageRequests.length === 1 &&
      !text(imageRequests[0].body.messages).includes(
        "[System-generated Reflection context",
      ) &&
      !imageHistory.some((item) => item.type === "compaction"),
  );
  diagnostics.image = {
    sourceFiles: imageUser?.files?.map((file) => ({
      mime: file.mime,
      uri: file.uri,
      dataLength: file.data?.length,
    })),
    canonicalText: imageCanonical?.source.text,
    providerImages: images,
  };

  phase = "inline-image";
  const inlineSession = await session("native inline PNG input", "tools");
  diagnostics.inlineImageSession = inlineSession;
  await api(`/session/${inlineSession}/prompt`, {
    text: "NATIVE_INLINE_IMAGE_INPUT",
    files: [
      { uri: `data:image/png;base64,${imageBase64}`, name: "inline.png" },
    ],
    resume: true,
  });
  await api(`/experimental/session/${inlineSession}/wait`, {});
  const inlineHistory = await history(inlineSession);
  const inlineUser = inlineHistory.find((item) => item.type === "user");
  const inlineCanonical = canonicalizeNativeHistory(inlineHistory).find(
    (record) => record.source.id === inlineUser?.id,
  );
  const inlineRequests = requests.filter(
    (item) => item.phase === "inline-image",
  );
  const inlineImages = inlineRequests
    .flatMap((item) => item.body.messages)
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .filter((part) => part.type === "image_url");
  check(
    "inline PNG persists actual inline source and original name",
    inlineUser?.files?.length === 1 &&
      inlineUser.files[0].source?.type === "inline" &&
      inlineUser.files[0].name === "inline.png" &&
      inlineUser.files[0].mime === "image/png" &&
      inlineUser.files[0].data === imageBase64,
  );
  check(
    "inline PNG ordinary model step dispatches and completes",
    inlineRequests.length === 1 &&
      inlineHistory.some(
        (item) =>
          item.type === "assistant" &&
          Number.isFinite(item.time?.completed) &&
          text(item).includes("NATIVE_REPLY_inline-image"),
      ),
  );
  check(
    "inline PNG reaches provider as exact original image_url bytes",
    inlineImages.length === 1 &&
      inlineImages[0].image_url?.url === `data:image/png;base64,${imageBase64}`,
  );
  check(
    "inline canonical descriptor preserves name and MIME but omits binary",
    inlineCanonical != null &&
      inlineCanonical.source.text.includes("NATIVE_INLINE_IMAGE_INPUT") &&
      inlineCanonical.source.text.includes("inline.png") &&
      inlineCanonical.source.text.includes("image/png") &&
      inlineCanonical.source.text.includes("binary content omitted") &&
      !inlineCanonical.source.text.includes(imageBase64),
  );
  check(
    "inline canonicalization leaves original native attachment unchanged",
    inlineCanonical != null && text(inlineCanonical.raw) === text(inlineUser),
  );
  check(
    "ordinary inline PNG uses no projection or native compaction",
    inlineRequests.length === 1 &&
      !text(inlineRequests[0].body.messages).includes(
        "[System-generated Reflection context",
      ) &&
      !inlineHistory.some((item) => item.type === "compaction"),
  );
  diagnostics.inlineImage = {
    sourceFiles: inlineUser?.files?.map((file) => ({
      source: file.source,
      name: file.name,
      mime: file.mime,
      dataLength: file.data?.length,
    })),
    canonicalText: inlineCanonical?.source.text,
    providerImages: inlineImages,
  };

  phase = "pending";
  const pending = await session("pending summary");
  modes.set(pending, "pending");
  const pendingStart = Date.now();
  for (let i = 0; i < 12; i++) {
    await prompt(pending, `NATIVE_PENDING_${i}_` + "p".repeat(2000));
    requireCheck(
      `pending turn ${i} completed`,
      (await history(pending)).filter(
        (item) =>
          item.type === "assistant" &&
          item.time?.completed &&
          text(item).includes("NATIVE_REPLY_pending"),
      ).length ===
        i + 1,
    );
  }
  const pendingElapsed = Date.now() - pendingStart;
  const pendingEntries = [...segments.values()].filter(
    (item) => item.request.session_id === pending,
  );
  check(
    "pending jobs project explicit omissions without waiting for extraction",
    pendingEntries.length > 0 &&
      pendingEntries.every((item) => item.pending) &&
      requests.some(
        (item) =>
          item.phase === "pending" &&
          /\[Reflection omitted [^\]]+: missing-or-stale-summary\]/.test(
            text(item.body.messages),
          ),
      ) &&
      manifest(pending).segments.length === 0,
  );
  check(
    "pending projection finishes within bounded five seconds",
    pendingElapsed < 5000,
    {
      elapsedMs: pendingElapsed,
      posts: posts.filter((post) => post.session_id === pending).length,
    },
  );

  phase = "idle-only";
  const idle = await session("idle ingestion only", "tools");
  const idleText = "NATIVE_IDLE_ONLY_" + "i".repeat(24000);
  diagnostics.idleSession = idle;
  await prompt(idle, idleText);
  const idleHistory = await history(idle);
  requireCheck(
    "idle-only actual turn completes without projection",
    text(idleHistory).includes("NATIVE_REPLY_idle-only") &&
      requests.filter((item) => item.phase === "idle-only").length === 1 &&
      requests
        .filter((item) => item.phase === "idle-only")
        .every(
          (item) =>
            !text(item.body.messages).includes(
              "[System-generated Reflection context",
            ),
        ),
  );
  const idleDeadline = Date.now() + 5000;
  while (
    Date.now() < idleDeadline &&
    !posts.some(
      (post) => post.session_id === idle && post.processing_priority === 50,
    )
  )
    await sleep(100);
  const idlePosts = posts.filter((post) => post.session_id === idle);
  diagnostics.idle = {
    posts: idlePosts.length,
    priorities: idlePosts.map((post) => post.processing_priority),
    session: await api(`/session/${idle}`),
    active: await api("/session/active"),
    history: idleHistory.map((item) => ({
      id: item.id,
      type: item.type,
      time: item.time,
    })),
  };
  diagnostics.idle.wire = wire
    .filter((item) => item.path?.includes(idle))
    .map((item) => ({ method: item.method, path: item.path }));
  check(
    "idle-only closed segment submitted at priority 50 within five seconds",
    idlePosts.some((post) => post.processing_priority === 50),
    diagnostics.idle,
  );
  check(
    "idle-only never uses foreground priority 100",
    idlePosts.every((post) => post.processing_priority !== 100),
  );
  const canonical = canonicalizeNativeHistory(idleHistory).map(
    (record) => record.source,
  );
  const idlePlan = planNativeSegments({
    source,
    sessionId: idle,
    records: canonicalizeNativeHistory(idleHistory),
    manifest: manifest(idle),
  });
  check(
    "idle-only transcript has an eligible closed original source segment",
    idlePlan.some(
      (segment) =>
        segment.closed &&
        segment.request.messages.some((item) => item.text.includes(idleText)),
    ),
  );
  diagnostics.idle.closedPlan = idlePlan
    .filter((segment) => segment.closed)
    .map((segment) => ({
      id: segment.id,
      fingerprint: segment.fingerprint,
      start: segment.request.start_source_message_id,
      end: segment.request.end_source_message_id,
    }));
  check(
    "idle-only submission preserves original canonical payload and fingerprint",
    idlePosts.length > 0 &&
      idlePosts.every((post) => {
        const start = canonical.findIndex(
          (item) => item.id === post.start_source_message_id,
        );
        const end = canonical.findIndex(
          (item) => item.id === post.end_source_message_id,
        );
        const original = { ...post, messages: canonical.slice(start, end + 1) };
        const stored = segments.get(nativeSegmentIdForRequest(post, source));
        return (
          start >= 0 &&
          end >= start &&
          text(original.messages) === text(post.messages) &&
          nativeSourceFingerprint(original) === stored?.fingerprint &&
          post.messages.some(
            (item) => item.type === "user" && item.text.includes(idleText),
          )
        );
      }),
  );

  phase = "auto-enabled";
  await mkdir("/state/auto-workspace", { recursive: true });
  await writeFile(
    "/state/auto-workspace/opencode.json",
    text({ compaction: { auto: true } }),
  );
  const auto = await session("auto enabled", "tools", "/state/auto-workspace");
  const effective = await api(
    "/config?location[directory]=%2Fstate%2Fauto-workspace",
  );
  requireCheck(
    "auto-enabled fixture has effective auto true",
    effective
      .filter((item) => item.type === "document" && item.info.compaction)
      .at(-1)?.info.compaction.auto === true,
  );
  const beforeAuto = requests.length;
  await prompt(auto, "NATIVE_AUTO_ENABLED");
  check(
    "automatic-compaction-enabled config blocks provider dispatch",
    requests.length === beforeAuto &&
      !(await history(auto)).some(
        (item) =>
          item.type === "assistant" && item.time?.completed && item.model,
      ),
  );
  check(
    "automatic-compaction-enabled guard reports explicit refusal",
    logs.includes("effective compaction.auto must be false"),
  );
  check("fixture servers had no protocol errors", errors.length === 0, errors);
}

let failure, timer;
try {
  await Promise.race([
    main(),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Native harness timed out in ${phase}`)),
        110000,
      );
    }),
  ]);
} catch (error) {
  failure = String(error.stack ?? error);
} finally {
  clearTimeout(timer);
  heldPartialResponse?.destroy();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), sleep(2000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  for (const root of ["/state/data", "/state/state"]) {
    for (const file of await readdir(root, { recursive: true }).catch(
      () => [],
    )) {
      if (file.endsWith(".log"))
        logs = (
          logs +
          `\n${file}:\n` +
          (await readFile(`${root}/${file}`, "utf8")).slice(-16000)
        ).slice(-32000);
    }
  }
  const observed = (
    await readFile("/state/native-events.jsonl", "utf8").catch(() => "")
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  diagnostics.observer = observed
    .filter(
      (item) =>
        item.kind !== "event" ||
        [
          diagnostics.idleSession,
          diagnostics.partialSession,
          diagnostics.imageSession,
          diagnostics.inlineImageSession,
        ].some((id) => id != null && text(item.event).includes(id)),
    )
    .slice(-90);
  diagnostics.eventTypes = [
    ...new Set(observed.map((item) => item.event?.type).filter(Boolean)),
  ];
}
const failed = Boolean(
  failure || assertions.some((item) => !item.ok) || errors.length,
);
console.log(
  text({
    outcome: failed ? "failed" : "passed",
    phase,
    assertions,
    failure,
    errors,
    diagnostics,
    providerRequests: requests.length,
    assertionCounts: {
      passed: assertions.filter((item) => item.ok).length,
      failed: assertions.filter((item) => !item.ok).length,
    },
    providerRequestsByPhase: Object.fromEntries(
      [...new Set(requests.map((item) => item.phase))].map((name) => [
        name,
        requests.filter((item) => item.phase === name).length,
      ]),
    ),
    posts: posts.map((post) => ({
      session: post.session_id,
      priority: post.processing_priority,
      types: post.messages.map((item) => item.type),
    })),
    scope: {
      runtime: "published native 2.0.8, actual bundled plugin",
      backend: "in-memory shared-contract fixture, not PostgreSQL",
      crossSourceLegacy: "asserted",
      automaticCompactionEnabled: "asserted",
      pending: "asserted with five-second bound",
      idleIngestion: "priority 50 and canonical fingerprint asserted",
      partialInterruption:
        "held stream, terminal source completion, and resumed segmentation asserted",
      imageInput:
        "ordinary native media dispatch and byte preservation asserted; image archive restoration not tested",
    },
    ...(failed
      ? {
          logs,
          providerSnapshots: requests.slice(-3).map((item) => ({
            phase: item.phase,
            roles: item.body.messages.map((message) => message.role),
            tools: item.body.tools?.map((tool) => tool.function?.name),
          })),
        }
      : {}),
  }),
);
process.exit(failed ? 1 : 0);
