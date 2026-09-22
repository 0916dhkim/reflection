import { createServer } from "node:http";
import { assertLoopbackUrl } from "./guards.mjs";

export const SOURCE = {
  id: "fixture-mac-v2",
  kind: "opencode-v2",
  identity_scheme: "source-v1",
};
export const MARKER = "COBALT-17";
export const SEED_TEXT = `The synthetic fixture marker is ${MARKER}.`;
export const POLICY_SEED_TEXT = `${SEED_TEXT} PREFIX{}SUFFIX ${JSON.stringify({ $ref: "#/fixture", nested: JSON.stringify({ text: 'escaped "quote" and \\slash' }) })}`;
export const PROMPT =
  "Search Reflection for the synthetic fixture marker, read the returned citation, and return only the marker from the exact source.";
export const TITLE = "macOS native Reflection fixture";

// Pinned 7673: session.log emits SessionEvent.Durable directly as SSE data;
// execution.ts:51-56 -> to-session-error.ts:64 preserves the thrown message.
// Unknown shapes/reasons are diagnostics only, never alternate refusal proofs.
export function policyRefusalEvidence(
  text,
  sessionID,
  expected,
  nativeOutput = "",
) {
  const result = {
    matched: false,
    overflow: Buffer.byteLength(text) > 256 * 1024,
    malformed: 0,
    streamFailure: false,
    eventCount: 0,
    terminalCount: 0,
    matchingFailures: 0,
    nativeOutputExpectedReason: nativeOutput.includes(expected),
    events: [],
  };
  if (result.overflow) return result;
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const lines = frame.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    if (++result.eventCount > 128) {
      result.overflow = true;
      break;
    }
    if (lines.some((line) => line === "event: effect/httpapi/stream/failure"))
      result.streamFailure = true;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      result.malformed++;
      continue;
    }
    const kind = [
      "session.execution.started",
      "session.execution.failed",
      "session.execution.succeeded",
      "session.execution.interrupted",
      "log.synced",
    ].includes(event?.type)
      ? event.type
      : "other";
    const error = event?.data?.error;
    const message = typeof error?.message === "string" ? error.message : "";
    const sessionMatches = event?.data?.sessionID === sessionID;
    const durableMatches =
      event?.durable?.aggregateID === sessionID &&
      Number.isInteger(event.durable.seq) &&
      event.durable.seq >= 0 &&
      event.durable.version === 1;
    const expectedMessage = message.includes(expected);
    if (
      [
        "session.execution.failed",
        "session.execution.succeeded",
        "session.execution.interrupted",
      ].includes(kind)
    )
      result.terminalCount++;
    if (
      kind === "session.execution.failed" &&
      sessionMatches &&
      durableMatches &&
      error?.type === "unknown" &&
      expected.length > 0 &&
      expectedMessage
    )
      result.matchingFailures++;
    // Fixed labels/booleans only: never copy error text, IDs, arbitrary keys or values.
    result.events.push({
      kind,
      sessionMatches,
      durableMatches,
      dataObject: event?.data != null && typeof event.data === "object",
      nestedEventType: typeof event?.data?.type === "string",
      errorObject: error != null && typeof error === "object",
      errorType: [
        "unknown",
        "aborted",
        "provider.no-route",
        "provider.auth",
        "provider.transport",
        "provider.internal",
        "provider.invalid-request",
      ].includes(error?.type)
        ? error.type
        : error?.type == null
          ? "absent"
          : "other",
      status:
        Number.isInteger(error?.status) &&
        error.status >= 100 &&
        error.status <= 599
          ? error.status
          : null,
      hasMessage: message.length > 0,
      expectedMessage,
      reflectionMessage: message.startsWith("Reflection:"),
      genericValidationMessage:
        message ===
        "Reflection: operation failed validation or is unavailable; no native fallback",
    });
    if (result.events.length > 8) result.events.shift();
  }
  result.matched =
    result.matchingFailures === 1 &&
    result.terminalCount === 1 &&
    !result.overflow &&
    !result.malformed &&
    !result.streamFailure;
  return result;
}

export function toolContent(message) {
  return typeof message.content === "string"
    ? message.content
    : message.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
}

export function toolResult(message, policyEnabled = false, original) {
  const content = toolContent(message);
  const raw = policyEnabled ? JSON.parse(content) : content;
  if (
    typeof raw !== "string" ||
    (policyEnabled && content !== JSON.stringify(raw))
  )
    throw Error("Expected exactly one tool text encoding layer");
  if (original !== undefined && raw !== original)
    throw Error("Tool text differs from original stored result");
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Expected raw tool JSON object");
  return value;
}

// Each request completes exactly one assistant turn. Tool arguments come from
// the actual prior tool response, never from out-of-band fixture constants.
export function completionTurn(
  body,
  { policyEnabled = false, originals } = {},
) {
  if (
    body.model !== (policyEnabled ? "google/fixture-model" : "fixture-model") ||
    body.stream !== true
  )
    throw Error("Invalid provider request");
  const names = body.tools?.map((tool) => tool.function?.name).sort();
  if (
    JSON.stringify(names) !==
    JSON.stringify(["memory_read_segment", "memory_search"])
  )
    throw Error("Unexpected tool registry");
  const tools = body.messages.filter((message) => message.role === "tool");
  const results = tools.map((message, index) =>
    toolResult(message, policyEnabled, originals?.[index]),
  );
  if (tools.length === 0)
    return {
      name: "memory_search",
      arguments: { query: "synthetic fixture marker" },
    };
  if (tools.length === 1) {
    const citation = results[0].claims?.[0]?.segments?.[0];
    if (!citation?.source_id || !citation?.segment_id)
      throw Error("Missing actual search citation");
    return { name: "memory_read_segment", arguments: citation };
  }
  if (tools.length !== 2) throw Error("Unexpected provider step count");
  const read = results[1];
  if (
    read.source_id !== SOURCE.id ||
    read.messages?.length !== 1 ||
    read.messages[0].text !== (policyEnabled ? POLICY_SEED_TEXT : SEED_TEXT) ||
    !read.verification?.includes("deterministic segment ID")
  )
    throw Error("Exact native read not verified");
  return { text: read.messages[0].text.match(/is ([A-Z]+-\d+)\./)[1] };
}

export function completionChunks(turn, index, model = "fixture-model") {
  const base = {
    id: `chatcmpl-fixture-${index}`,
    object: "chat.completion.chunk",
    created: 1,
    model,
  };
  const delta = turn.name
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call_fixture_${index}`,
            type: "function",
            function: {
              name: turn.name,
              arguments: JSON.stringify(turn.arguments),
            },
          },
        ],
      }
    : { role: "assistant", content: turn.text };
  return [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: turn.name ? "tool_calls" : "stop",
        },
      ],
    },
  ];
}

export function createReflectionFixture({
  policyEnabled = false,
  readOriginals,
} = {}) {
  const requests = [];
  const provider = [];
  const errors = [];
  const sourceRPC = [];
  let native;
  let segment;
  let caseStart = 0;
  let originalStart = 0;
  const server = createServer(async (request, response) => {
    const send = (status, value) =>
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(value));
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 512 * 1024) throw Error("Fixture request too large");
        chunks.push(chunk);
      }
      const url = new URL(request.url, "http://fixture");
      requests.push({ method: request.method, path: url.pathname });
      if (url.pathname.startsWith("/api/")) {
        if (
          !native ||
          request.method !== "GET" ||
          request.headers.authorization !== native.authorization ||
          !/^\/api\/(config|session(?:\/[^/]+(?:\/message)?)?)$/.test(
            url.pathname,
          )
        )
          throw Error("Source RPC refused");
        const upstream = await fetch(
          new URL(url.pathname + url.search, native.origin),
          {
            headers: { authorization: native.authorization },
            redirect: "error",
            signal: AbortSignal.timeout(4000),
          },
        );
        const value = await upstream.json();
        sourceRPC.push({
          path: url.pathname,
          status: upstream.status,
          rawNativeHistory:
            url.pathname.endsWith("/message") &&
            Array.isArray(value.data) &&
            value.data.every(
              (item) =>
                typeof item.id === "string" &&
                typeof item.type === "string" &&
                item.info === undefined,
            ),
          exactSeedText:
            url.pathname.endsWith("/message") &&
            value.data?.some(
              (item) =>
                item.type === "user" &&
                item.text === (policyEnabled ? POLICY_SEED_TEXT : SEED_TEXT),
            ),
        });
        return send(upstream.status, value);
      }
      if (
        url.pathname === "/v1/chat/completions" &&
        request.method === "POST"
      ) {
        if (request.headers.authorization !== "Bearer fixture-only")
          return send(403, {});
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (
          provider.length >= (policyEnabled ? 9 : 3) ||
          provider.length - caseStart >= 3
        )
          throw Error("Provider budget exceeded");
        const originals = readOriginals
          ? (await readOriginals()).slice(originalStart)
          : undefined;
        const toolCount = body.messages.filter(
          (message) => message.role === "tool",
        ).length;
        if (
          toolCount !== provider.length - caseStart ||
          (originals && originals.length !== toolCount)
        )
          throw Error("Provider/tool observation step mismatch");
        const turn = completionTurn(body, { policyEnabled, originals });
        provider.push({
          turn: turn.name ?? "final",
          policyEnabled,
          model: body.model,
          toolContents: body.messages
            .filter((message) => message.role === "tool")
            .map(toolContent),
          instructions: JSON.stringify(
            body.messages.filter(
              (message) =>
                message.role === "system" || message.role === "developer",
            ),
          ),
        });
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        for (const chunk of completionChunks(turn, provider.length, body.model))
          response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        return response.end("data: [DONE]\n\n");
      }
      if (request.headers["x-api-key"] !== "fixture-only") return send(403, {});
      if (
        request.method === "GET" &&
        url.pathname === `/v1/sources/${SOURCE.id}`
      )
        return send(200, SOURCE);
      if (
        request.method === "POST" &&
        url.pathname === "/v1/search" &&
        segment
      ) {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (typeof body.query !== "string" || !body.query.trim())
          throw Error("Invalid search body");
        return send(200, {
          claims: [
            {
              subject: "Synthetic fixture marker",
              subject_entity_id: null,
              predicate: "is",
              confidence: 1,
              object_entity: null,
              object_entity_id: null,
              object_value: MARKER,
              segments: [{ source_id: SOURCE.id, segment_id: segment.id }],
              support_count: 1,
              session_count: 1,
              score: 1,
            },
          ],
        });
      }
      if (
        request.method === "GET" &&
        url.pathname === `/v1/segments/${segment?.id}` &&
        url.searchParams.get("source_id") === SOURCE.id
      )
        return send(200, segment);
      if (
        request.method === "GET" &&
        /^\/v1\/sessions\/[^/]+\/segments$/.test(url.pathname) &&
        url.searchParams.get("source_id") === SOURCE.id
      )
        return send(200, {
          source_id: SOURCE.id,
          session_id: decodeURIComponent(url.pathname.split("/")[3]),
          manifest_version: 3,
          segments: [],
          boundaries: [],
          targets: [],
        });
      errors.push(
        `Unexpected fixture route: ${request.method} ${url.pathname}`,
      );
      return send(404, {});
    } catch (error) {
      errors.push(error.message);
      if (!response.headersSent) send(500, {});
      else response.end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return {
    requests,
    provider,
    errors,
    sourceRPC,
    beginCase() {
      caseStart = provider.length;
      originalStart = (provider.length / 3) * 2;
      if (!Number.isInteger(originalStart))
        throw Error("Incomplete prior fixture case");
    },
    setNative(origin, password) {
      assertLoopbackUrl(origin);
      native = {
        origin,
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      };
    },
    setSegment(value) {
      segment = value;
    },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      server.closeAllConnections();
      if (server.listening)
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    },
  };
}
