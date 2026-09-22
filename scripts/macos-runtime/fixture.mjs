import { createServer } from "node:http";

export const SOURCE = {
  id: "fixture-mac-v2",
  kind: "opencode-v2",
  identity_scheme: "source-v1",
};
export const MARKER = "COBALT-17";
export const SEED_TEXT = `The synthetic fixture marker is ${MARKER}.`;
export const PROMPT =
  "Search Reflection for the synthetic fixture marker, read the returned citation, and return only the marker from the exact source.";
export const TITLE = "macOS native Reflection fixture";

function toolResult(message) {
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          ?.filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
  return JSON.parse(content);
}

// Each request completes exactly one assistant turn. Tool arguments come from
// the actual prior tool response, never from out-of-band fixture constants.
export function completionTurn(body) {
  if (body.model !== "fixture-model" || body.stream !== true)
    throw Error("Invalid provider request");
  const names = body.tools?.map((tool) => tool.function?.name).sort();
  if (
    JSON.stringify(names) !==
    JSON.stringify(["memory_read_segment", "memory_search"])
  )
    throw Error("Unexpected tool registry");
  const tools = body.messages.filter((message) => message.role === "tool");
  if (tools.length === 0)
    return {
      name: "memory_search",
      arguments: { query: "synthetic fixture marker" },
    };
  if (tools.length === 1) {
    const citation = toolResult(tools[0]).claims?.[0]?.segments?.[0];
    if (!citation?.source_id || !citation?.segment_id)
      throw Error("Missing actual search citation");
    return { name: "memory_read_segment", arguments: citation };
  }
  if (tools.length !== 2) throw Error("Unexpected provider step count");
  const read = toolResult(tools[1]);
  if (
    read.source_id !== SOURCE.id ||
    read.messages?.length !== 1 ||
    read.messages[0].text !== SEED_TEXT ||
    !read.verification?.includes("deterministic segment ID")
  )
    throw Error("Exact native read not verified");
  return { text: read.messages[0].text.match(/is ([A-Z]+-\d+)\./)[1] };
}

export function completionChunks(turn, index) {
  const base = {
    id: `chatcmpl-fixture-${index}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture-model",
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

export function createReflectionFixture() {
  const requests = [];
  const provider = [];
  const errors = [];
  const sourceRPC = [];
  let native;
  let segment;
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
        if (provider.length >= 3) throw Error("Provider budget exceeded");
        const turn = completionTurn(body);
        provider.push({
          turn: turn.name ?? "final",
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
        for (const chunk of completionChunks(turn, provider.length))
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
    setNative(origin, password) {
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
