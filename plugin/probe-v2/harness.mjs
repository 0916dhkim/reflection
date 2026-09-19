import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const state = "/state";
const serverURL = process.env.PROBE_SERVER_URL;
const password = process.env.PROBE_SERVER_PASSWORD;
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
const assertions = [];
const providerRequests = [];
let child;
let mock;
let overallTimer;

function check(name, condition, detail = undefined) {
  const assertion = {
    name,
    ok: Boolean(condition),
    ...(detail === undefined ? {} : { detail }),
  };
  assertions.push(assertion);
  return assertion.ok;
}

function requireValue(name, value, detail = undefined) {
  if (!check(name, value != null, detail)) {
    throw new Error(`required value missing: ${name}`);
  }
  return value;
}

function json(value) {
  return typeof value === "string"
    ? value
    : (JSON.stringify(value) ?? String(value));
}

function contains(value, marker) {
  return json(value).includes(marker);
}

function messageID(message) {
  return message?.info?.id ?? message?.id;
}

function messageType(message) {
  return message?.info?.type ?? message?.type;
}

function messageModel(message) {
  return message?.info?.model ?? message?.model;
}

function messageParts(message) {
  return Array.isArray(message?.parts)
    ? message.parts
    : Array.isArray(message?.content)
      ? message.content
      : [];
}

function messageIDs(messages) {
  return messages.map(messageID).filter((id) => typeof id === "string");
}

function toolNames(body) {
  return (body.tools ?? []).flatMap((tool) =>
    typeof tool?.function?.name === "string" ? [tool.function.name] : [],
  );
}

function latestUserText(messages) {
  for (const message of [...messages].reverse()) {
    if (message?.role === "user") {
      return json(message.content);
    }
  }
  return "";
}

function sse(response, chunks) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function chunk(delta, finishReason = null, model = "mock") {
  return {
    id: "cp002-completion",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function textCompletion(content, model) {
  return [
    chunk({ role: "assistant" }, null, model),
    chunk({ content }, null, model),
    chunk({}, "stop", model),
  ];
}

const compactionSummary = [
  "## Objective",
  "- Exercise the CP002 synthetic probe fixture.",
  "",
  "## Requirements",
  "- Use the local fixture provider only.",
  "",
  "## Decisions",
  "- The fixture uses deterministic mock responses.",
  "",
  "## Work State",
  "### Completed",
  "- The fixture conversation completed.",
  "",
  "### Active",
  "- (none)",
  "",
  "### Blocked",
  "- (none)",
  "",
  "## Next Move",
  "1. (none)",
  "",
  "## Relevant Files",
  "- (none)",
  "",
  "## Important Context",
  "- CP002_COMPACTION_SUMMARY fixture only.",
].join("\n");

function toolCompletion(name, input, model) {
  const callID = name === "shell" ? "call_cp002_async" : "call_cp002_echo";
  return [
    chunk({ role: "assistant" }, null, model),
    chunk(
      {
        tool_calls: [
          {
            index: 0,
            id: callID,
            type: "function",
            function: { name, arguments: JSON.stringify(input) },
          },
        ],
      },
      null,
      model,
    ),
    chunk({}, "tool_calls", model),
  ];
}

async function startMock() {
  mock = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunkPart of request) {
      chunks.push(chunkPart);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const bodyText = json(body.messages ?? []);
    const userText = latestUserText(body.messages ?? []);
    const model = typeof body.model === "string" ? body.model : "mock";
    const shellSchema = (body.tools ?? []).find(
      (tool) => tool?.type === "function" && tool.function?.name === "shell",
    )?.function?.parameters;
    providerRequests.push({
      messages: bodyText,
      userText,
      model,
      toolNames: toolNames(body),
      shellInputProperties: Object.keys(shellSchema?.properties ?? {}),
    });
    if (bodyText.includes("CP002_TOOL_RESULT")) {
      sse(response, textCompletion("CP002_TOOL_FOLLOWUP", model));
      return;
    }
    if (bodyText.includes("CP002_ASYNC_RESULT")) {
      sse(response, textCompletion("CP002_ASYNC_DONE_SEEN", model));
      return;
    }
    if (userText.includes("CP002_ASYNC")) {
      const shell = (body.tools ?? []).find(
        (tool) => tool?.type === "function" && tool.function?.name === "shell",
      );
      if (!shell) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: "shell tool missing",
            toolNames: toolNames(body),
          }),
        );
        return;
      }
      if ((body.messages ?? []).some((message) => message?.role === "tool")) {
        sse(response, textCompletion("CP002_ASYNC_ACK_SEEN", model));
        return;
      }
      const command =
        'i=0; while [ ! -f /state/release-async ]; do i=$((i + 1)); [ "$i" -ge 200 ] && exit 124; sleep 0.05; done; printf CP002_ASYNC_; printf RESULT';
      sse(
        response,
        toolCompletion(
          shell.function.name,
          { command, background: true },
          model,
        ),
      );
      return;
    }
    if (userText.includes("CP002_TOOL")) {
      const name = toolNames(body).find((tool) => tool.includes("probe_echo"));
      if (!name) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: "probe_echo tool missing",
            toolNames: toolNames(body),
          }),
        );
        return;
      }
      sse(response, toolCompletion(name, { text: "fixture" }, model));
      return;
    }
    if (
      userText.includes("CP002_ORDINARY") ||
      userText.includes("CP002_BULK")
    ) {
      sse(response, textCompletion("CP002_REPLY", model));
      return;
    }
    if (
      bodyText.toLowerCase().includes("summar") ||
      bodyText.toLowerCase().includes("compact")
    ) {
      sse(response, textCompletion(compactionSummary, model));
      return;
    }
    sse(response, textCompletion("CP002_REPLY", model));
  });
  await new Promise((resolve, reject) => {
    mock.once("error", reject);
    mock.listen(4100, "127.0.0.1", resolve);
  });
}

async function request(path, options = {}) {
  const response = await fetch(`${serverURL}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(10_000),
    headers: { authorization: auth, ...(options.headers ?? {}) },
  });
  const raw = await response.text();
  let body;
  try {
    body = raw === "" ? undefined : JSON.parse(raw);
  } catch {
    body = raw;
  }
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${path} returned ${response.status}: ${json(body).slice(0, 400)}`,
    );
  }
  return body;
}

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await request("/api/info");
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`server did not become healthy: ${lastError}`);
}

function pageData(body) {
  if (
    !body ||
    !Array.isArray(body.data) ||
    !body.cursor ||
    !("next" in body.cursor)
  ) {
    throw new Error("message endpoint did not return {data,cursor:{next?}}");
  }
  if (
    body.cursor.next !== undefined &&
    body.cursor.next !== null &&
    typeof body.cursor.next !== "string"
  ) {
    throw new Error(
      `message cursor.next has invalid shape: ${json(body.cursor)}`,
    );
  }
  return { data: body.data, next: body.cursor.next ?? undefined };
}

async function history(sessionID, limit = 200) {
  const messages = [];
  const seenCursors = new Set();
  let cursor;
  let pages = 0;
  do {
    if (pages >= 100) {
      throw new Error("message pagination exceeded 100 pages");
    }
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw new Error("message pagination repeated a cursor");
      }
      seenCursors.add(cursor);
      query.set("cursor", cursor);
    } else {
      query.set("order", "asc");
    }
    const page = pageData(
      await request(
        `/api/session/${encodeURIComponent(sessionID)}/message?${query}`,
      ),
    );
    messages.push(...page.data);
    cursor = page.next;
    pages += 1;
  } while (cursor !== undefined);
  return { messages, pages };
}

async function waitSession(sessionID) {
  return request(
    `/api/experimental/session/${encodeURIComponent(sessionID)}/wait`,
    { method: "POST" },
  );
}

async function settledSession(sessionID) {
  // Wait is an execution-settlement API, not prompt success. Network/server
  // failures must not be mistaken for successful settlement.
  return { settled: true, result: await waitSession(sessionID) };
}

async function waitForHistory(sessionID, predicate, name) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await history(sessionID);
    if (predicate(current.messages)) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`history condition not reached: ${name}`);
}

async function events() {
  const raw = await readFile(`${state}/events.jsonl`, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForEvent(predicate, name) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const event = (await events()).find(predicate);
      if (event) {
        return event;
      }
    } catch {
      // The plugin has not written its report yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`expected plugin event was not written: ${name}`);
}

async function createSession(title) {
  const session = await request("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      location: { directory: "/workspace" },
      model: { providerID: "probe", id: "mock" },
    }),
  });
  return requireValue(`create session ${title}`, session?.data?.id, {
    model: session?.data?.model,
    directory: session?.data?.location?.directory,
  });
}

async function prompt(sessionID, marker, options = {}) {
  await request(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: marker, resume: options.resume ?? true }),
  });
}

async function settlePrompt(sessionID, marker, options = {}) {
  await prompt(sessionID, marker, options);
  return waitSession(sessionID);
}

async function stopChild() {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  let killTimer;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => {
      killTimer = setTimeout(resolve, 3_000);
    }),
  ]);
  clearTimeout(killTimer);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

async function main() {
  check("required probe environment", Boolean(serverURL && password));
  await Promise.all(
    [
      "events.jsonl",
      "report.json",
      "opencode.stdout.log",
      "opencode.stderr.log",
      "release-async",
    ].map((file) => rm(`${state}/${file}`, { force: true })),
  );
  await mkdir(`${state}/home`, { recursive: true });

  const version = spawnSync("/opt/opencode/bin/opencode", ["--version"], {
    encoding: "utf8",
  });
  check("native CLI version command exits", version.status === 0, {
    status: version.status,
    stderr: version.stderr,
  });
  check(
    "native CLI is pinned to 2.0.8",
    `${version.stdout}${version.stderr}`.includes("2.0.8"),
    version.stdout.trim(),
  );

  await startMock();
  const stdout = createWriteStream(`${state}/opencode.stdout.log`, {
    flags: "a",
  });
  const stderr = createWriteStream(`${state}/opencode.stderr.log`, {
    flags: "a",
  });
  child = spawn(
    "/opt/opencode/bin/opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", "4096"],
    {
      cwd: "/workspace",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);

  const info = await waitForServer();
  check("authenticated server info", Boolean(info));
  const noAuth = await fetch(`${serverURL}/api/info`, {
    signal: AbortSignal.timeout(10_000),
  });
  check("server requires HTTP Basic authentication", noAuth.status === 401, {
    status: noAuth.status,
  });

  const ordinary = await createSession("CP002 ordinary");
  await settlePrompt(ordinary, "CP002_ORDINARY_ONE");
  const setup = await waitForEvent((event) => event.kind === "setup", "setup");
  check("workspace plugin auto-discovered", setup.kind === "setup");
  check("native runtime reports Bun", typeof setup.versions?.bun === "string", {
    bun: setup.versions?.bun,
  });
  check(
    "native runtime app location recorded",
    setup.appLocation === "/opt/opencode/bin/opencode",
    setup.appLocation,
  );
  await settlePrompt(ordinary, "CP002_ORDINARY_TWO");
  const ordinaryHistory = await history(ordinary);
  const ordinaryEvent = await waitForEvent(
    (event) =>
      event.kind === "context" &&
      event.sessionID === ordinary &&
      contains(event.history, "CP002_ORDINARY_TWO"),
    "ordinary context",
  );
  const renderedIDs = messageIDs(ordinaryEvent.messages);
  const sourceIDs = new Set(messageIDs(ordinaryEvent.history));
  check(
    "outgoing system includes marker",
    contains(ordinaryEvent.system, "CP002_CONTEXT_MARKER"),
  );
  check(
    "marker is not persisted",
    !contains(ordinaryHistory.messages, "CP002_CONTEXT_MARKER"),
  );
  check(
    "marker reached the mock provider",
    providerRequests.some(
      (request) =>
        request.messages.includes("CP002_ORDINARY_TWO") &&
        request.messages.includes("CP002_CONTEXT_MARKER"),
    ),
  );
  check(
    "ID-bearing rendered messages are source-owned",
    renderedIDs.every((id) => sourceIDs.has(id)),
    { renderedIDs, sourceIDs: [...sourceIDs] },
  );
  const ordinaryUserOneID = messageID(
    ordinaryEvent.history.find((message) =>
      contains(message, "CP002_ORDINARY_ONE"),
    ),
  );
  const ordinaryUserTwoID = messageID(
    ordinaryEvent.history.find((message) =>
      contains(message, "CP002_ORDINARY_TWO"),
    ),
  );
  const ordinaryAssistant = ordinaryEvent.history.find((message) =>
    contains(message, "CP002_REPLY"),
  );
  const ordinaryAssistantID = messageID(ordinaryAssistant);
  check(
    "ordinary pre-assistant snapshot has two user IDs and a completed assistant ID",
    [ordinaryUserOneID, ordinaryUserTwoID, ordinaryAssistantID].every(
      (id) => typeof id === "string",
    ),
    {
      ordinaryUserOneID,
      ordinaryUserTwoID,
      ordinaryAssistantID,
    },
  );
  check(
    "ordinary source IDs all remain in rendered history",
    [ordinaryUserOneID, ordinaryUserTwoID, ordinaryAssistantID].every((id) =>
      renderedIDs.includes(id),
    ),
    { renderedIDs },
  );
  check(
    "ordinary source assistant completed at a finite time",
    Number.isFinite(
      ordinaryAssistant?.info?.time?.completed ??
        ordinaryAssistant?.time?.completed,
    ),
  );

  await request(`/api/session/${encodeURIComponent(ordinary)}/model`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: { providerID: "probe", id: "mock-small" } }),
  });
  await settlePrompt(ordinary, "CP002_MODEL_SMALL");
  const smallModelEvent = await waitForEvent(
    (event) =>
      event.kind === "context" &&
      event.sessionID === ordinary &&
      contains(event.history, "CP002_MODEL_SMALL"),
    "model switch context",
  );
  const smallModelUserID = messageID(
    smallModelEvent.history.find((message) =>
      contains(message, "CP002_MODEL_SMALL"),
    ),
  );
  check(
    "model switch selects mock-small",
    smallModelEvent.model?.providerID === "probe" &&
      smallModelEvent.model?.id === "mock-small",
    smallModelEvent.model,
  );
  check(
    "model switch preserves source ownership",
    typeof smallModelUserID === "string" &&
      messageIDs(smallModelEvent.messages).includes(smallModelUserID),
    { smallModelUserID },
  );
  check(
    "mock received mock-small",
    providerRequests.some(
      (request) =>
        request.model === "mock-small" &&
        request.messages.includes("CP002_MODEL_SMALL"),
    ),
  );

  const toolSession = await createSession("CP002 tool");
  await settlePrompt(toolSession, "CP002_TOOL");
  const toolHistory = await history(toolSession);
  const toolEvent = await waitForEvent(
    (event) =>
      event.kind === "context" &&
      event.sessionID === toolSession &&
      contains(event.messages, "CP002_TOOL_RESULT"),
    "tool continuation",
  );
  const renderedAssistant = toolEvent.messages.find(
    (message) =>
      message?.role === "assistant" && contains(message, "call_cp002"),
  );
  const renderedResult = toolEvent.messages.find(
    (message) => message?.role === "tool" && contains(message, "call_cp002"),
  );
  const renderedCall = messageParts(renderedAssistant).find(
    (part) => part?.type === "tool-call",
  );
  const renderedResultPart = messageParts(renderedResult).find(
    (part) => part?.type === "tool-result",
  );
  const callID = renderedCall?.id;
  const sourceAssistant = toolHistory.messages.find((message) =>
    messageParts(message).some(
      (part) => part?.type === "tool" && part.id === callID,
    ),
  );
  check(
    "tool executor returned fixture result",
    contains(toolHistory.messages, "CP002_TOOL_RESULT"),
  );
  check(
    "tool followup completed",
    contains(toolHistory.messages, "CP002_TOOL_FOLLOWUP"),
  );
  check(
    "stored assistant tool content retains the v2 call ID",
    callID === "call_cp002_echo" &&
      typeof messageID(sourceAssistant) === "string" &&
      messageID(renderedAssistant) === messageID(sourceAssistant),
    { callID, assistantID: messageID(sourceAssistant) },
  );
  check(
    "tool result maps to the stored assistant call and has no outer ID",
    renderedResultPart?.id === callID &&
      !Object.prototype.hasOwnProperty.call(renderedResult ?? {}, "id"),
    {
      callID,
      toolResultID: renderedResultPart?.id,
      resultID: renderedResult?.id,
    },
  );

  const rejected = await createSession("CP002 rejected");
  const beforeReject = providerRequests.length;
  await prompt(rejected, "CP002_ABORT");
  await waitForEvent(
    (event) => event.kind === "context.abort" && event.sessionID === rejected,
    "abort hook",
  );
  const rejectedSettlement = await settledSession(rejected);
  const rejectedHistory = await history(rejected);
  const activeSessions = await request("/api/session/active");
  const activeSessionData = requireValue(
    "active session endpoint returns data",
    activeSessions?.data,
    { type: typeof activeSessions?.data },
  );
  const activeSessionIDs = Array.isArray(activeSessionData)
    ? activeSessionData.map((session) => session.id)
    : Object.keys(activeSessionData);
  check(
    "abort session settles after rejection",
    rejectedSettlement.settled === true,
    rejectedSettlement,
  );
  check(
    "abort session is no longer active",
    !activeSessionIDs.includes(rejected),
  );
  check(
    "abort creates no model-output assistant",
    !rejectedHistory.messages.some(
      (message) =>
        messageType(message) === "assistant" && messageModel(message) != null,
    ),
  );
  check(
    "abort prompt has zero provider dispatches",
    providerRequests.length === beforeReject,
    { beforeReject, after: providerRequests.length },
  );

  const cancelled = await createSession("CP002 cancelled");
  const beforeCancel = providerRequests.length;
  await prompt(cancelled, "CP002_CANCEL");
  await waitForEvent(
    (event) =>
      event.kind === "context.cancel.wait" && event.sessionID === cancelled,
    "cancel hook delay",
  );
  await request(`/api/session/${encodeURIComponent(cancelled)}/interrupt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  await waitForEvent(
    (event) =>
      event.kind === "context.cancel.delay.complete" &&
      event.sessionID === cancelled,
    "cancel hook delay completion",
  );
  const cancelledSettlement = await settledSession(cancelled);
  check(
    "cancelled prompt settles",
    cancelledSettlement.settled === true,
    cancelledSettlement,
  );
  check(
    "cancelled prompt has zero provider dispatches",
    providerRequests.length === beforeCancel,
    { beforeCancel, after: providerRequests.length },
  );

  const asynchronous = await createSession("CP002 asynchronous shell");
  await settlePrompt(asynchronous, "CP002_ASYNC");
  const asynchronousBeforeRelease = await history(asynchronous);
  const asynchronousAcknowledgment = requireValue(
    "original background tool owner exists",
    asynchronousBeforeRelease.messages.find((message) =>
      messageParts(message).some(
        (part) => part.type === "tool" && part.id === "call_cp002_async",
      ),
    ),
  );
  const acknowledgedTool = messageParts(asynchronousAcknowledgment).find(
    (part) => part.type === "tool" && part.id === "call_cp002_async",
  );
  const asynchronousHash = createHash("sha256")
    .update(json(asynchronousAcknowledgment))
    .digest("hex");
  const shellRequest = providerRequests.find((request) =>
    request.userText.includes("CP002_ASYNC"),
  );
  check(
    "async shell tool advertises command and background inputs",
    shellRequest?.toolNames.includes("shell") &&
      shellRequest.shellInputProperties.includes("command") &&
      shellRequest.shellInputProperties.includes("background"),
    shellRequest?.shellInputProperties,
  );
  check(
    "async assistant acknowledges while job output is pending",
    acknowledgedTool?.state?.status === "completed" &&
      Number.isFinite(asynchronousAcknowledgment.time?.completed) &&
      contains(asynchronousBeforeRelease.messages, "CP002_ASYNC_ACK_SEEN") &&
      !contains(asynchronousBeforeRelease.messages, "CP002_ASYNC_RESULT"),
  );
  await writeFile(`${state}/release-async`, "release\n");
  await waitForHistory(
    asynchronous,
    (messages) =>
      contains(messages, "CP002_ASYNC_RESULT") &&
      messages.some((message) => messageType(message) === "synthetic"),
    "async synthetic completion",
  );
  await settledSession(asynchronous);
  const asynchronousAfterRelease = await history(asynchronous);
  const asynchronousAcknowledgmentAfterRelease =
    asynchronousAfterRelease.messages.find(
      (message) => messageID(message) === messageID(asynchronousAcknowledgment),
    );
  const asynchronousSynthetic = asynchronousAfterRelease.messages.find(
    (message) =>
      messageType(message) === "synthetic" &&
      contains(message, "CP002_ASYNC_RESULT"),
  );
  check(
    "async completion preserves the original assistant acknowledgment",
    createHash("sha256")
      .update(json(asynchronousAcknowledgmentAfterRelease))
      .digest("hex") === asynchronousHash,
  );
  check(
    "async completion appends a non-user synthetic message",
    Boolean(asynchronousSynthetic) &&
      messageType(asynchronousSynthetic) !== "user",
  );
  check(
    "async notification receives a terminal model response",
    contains(asynchronousAfterRelease.messages, "CP002_ASYNC_DONE_SEEN"),
  );

  const bulk = await createSession("CP002 bulk");
  for (let index = 0; index < 27; index += 1) {
    await settlePrompt(bulk, `CP002_BULK_${index}`);
  }
  const beforeCompact = await history(bulk, 7);
  const beforeCompactLarge = await history(bulk, 200);
  const compact = await request(
    `/api/session/${encodeURIComponent(bulk)}/compact`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  await waitSession(bulk);
  await settlePrompt(bulk, "CP002_AFTER_COMPACT");
  const bulkHistory = await history(bulk, 7);
  const activeContext = await request(
    `/api/session/${encodeURIComponent(bulk)}/context`,
  );
  const activeData = activeContext?.data;
  const activeMessages = requireValue(
    "context endpoint returns data",
    activeData,
    { count: Array.isArray(activeData) ? activeData.length : null },
  );
  const beforeIDs = messageIDs(beforeCompact.messages);
  const largeIDs = messageIDs(beforeCompactLarge.messages);
  const afterIDs = new Set(messageIDs(bulkHistory.messages));
  const normalBulkMessages = beforeCompact.messages.filter((message) =>
    ["user", "assistant"].includes(messageType(message)),
  );
  check(
    "bulk fixture delivered fifty-four normal user and assistant messages",
    normalBulkMessages.length === 54,
    { count: normalBulkMessages.length },
  );
  check("bulk transcript used cursor pagination", bulkHistory.pages > 1, {
    pages: bulkHistory.pages,
  });
  check(
    "pagination preserves unique ordered IDs against a large page",
    new Set(beforeIDs).size === beforeIDs.length &&
      beforeIDs.length === largeIDs.length &&
      beforeIDs[0] === largeIDs[0] &&
      beforeIDs.at(-1) === largeIDs.at(-1) &&
      beforeIDs.every((id, index) => id === largeIDs[index]),
    { paged: beforeIDs.length, large: largeIDs.length },
  );
  check(
    "no automatic compaction occurred in this fixture before explicit compact",
    !beforeCompact.messages.some(
      (message) => messageType(message) === "compaction",
    ),
  );
  const compactionRecord = bulkHistory.messages.find(
    (message) =>
      message?.type === "compaction" || message?.info?.type === "compaction",
  );
  check(
    "explicit compaction request completed",
    compactionRecord?.status === "completed" &&
      contains(compactionRecord, "CP002_COMPACTION_SUMMARY"),
    {
      accepted: Boolean(compact),
      status: compactionRecord?.status,
      error: compactionRecord?.error?.message,
    },
  );
  check(
    "compaction preserves every earlier full-history ID",
    beforeIDs.every((id) => afterIDs.has(id)),
    { before: beforeIDs.length, after: afterIDs.size },
  );
  check(
    "active context shrinks after compaction",
    Array.isArray(activeMessages) &&
      activeMessages.length < beforeCompact.messages.length,
    {
      active: Array.isArray(activeMessages) ? activeMessages.length : null,
      full: beforeCompact.messages.length,
    },
  );
  const bulkHook = await waitForEvent(
    (event) =>
      event.kind === "context" &&
      event.sessionID === bulk &&
      contains(event.history, "CP002_AFTER_COMPACT"),
    "post-compaction hook history",
  );
  const bulkHookIDs = new Set(messageIDs(bulkHook.history));
  check(
    "post-compaction hook retains old full-history IDs",
    beforeIDs.every((id) => bulkHookIDs.has(id)),
  );
  check(
    "hook performed authenticated paginated full-history fetch",
    Array.isArray(bulkHook.history) &&
      bulkHook.history.length > 50 &&
      Array.isArray(bulkHook.activeContext) &&
      bulkHook.activeContext.length < bulkHook.history.length,
    {
      history: bulkHook.history?.length,
      activeContext: bulkHook.activeContext?.length,
    },
  );

  const failed = assertions.filter((assertion) => !assertion.ok);
  if (failed.length > 0) {
    throw new Error(
      `failed assertions: ${failed.map((assertion) => assertion.name).join(", ")}`,
    );
  }
  return { info, ordinary, toolSession, rejected, cancelled, bulk };
}

let outcome = "failed";
let failure;
try {
  await new Promise((resolve, reject) => {
    overallTimer = setTimeout(
      () => reject(new Error("harness timed out after 110 seconds")),
      110_000,
    );
    main().then(resolve, reject);
  });
  outcome = "passed";
} catch (error) {
  failure =
    error instanceof Error
      ? { message: error.message, stack: error.stack }
      : { message: String(error) };
} finally {
  clearTimeout(overallTimer);
  await stopChild();
  if (mock) {
    await new Promise((resolve) => mock.close(resolve));
  }
}

const report = {
  outcome,
  scope: {
    modelSwitch: "tested",
    backgroundShell: "tested",
    backgroundSubagent: "not tested",
  },
  assertions,
  failure,
  providerRequests: providerRequests.length,
  providerToolNames: providerRequests
    .map((request) => request.toolNames)
    .filter((names) => names.length > 0)
    .slice(-5),
  paths: { report: `${state}/report.json`, events: `${state}/events.jsonl` },
};
await writeFile(`${state}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (failure) {
  process.exitCode = 1;
}
