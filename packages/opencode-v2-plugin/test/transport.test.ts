import { describe, expect, it } from "vitest";
import { canonicalizeNativeHistory } from "@reflection/opencode-v2-core/history";
import {
  AvailabilityError,
  HISTORY_CACHE_SESSIONS,
  RequestRejectedError,
  Transport,
  automaticCompaction,
  configSchema,
  legacyHistory,
  nativeCursorAfter,
  type Config,
} from "../src/transport.js";

export const config: Config = {
  url: "http://reflection.invalid",
  apiKey: "reflection-secret",
  sourceId: "native",
  sources: {
    native: {
      kind: "opencode-v2",
      url: "http://native.invalid",
      username: "reader",
      password: "reader-secret",
    },
    legacy: {
      kind: "opencode-v1",
      url: "http://legacy.invalid",
      directory: "/legacy",
    },
  },
  contextProjection: { enabled: true },
};
const signal = () => AbortSignal.timeout(1000);
const registry = {
  id: "native",
  kind: "opencode-v2" as const,
  identity_scheme: "source-v1" as const,
};
const entry = (info: unknown) => ({ type: "document", info });

describe("explicit configuration and compaction", () => {
  it("rejects disabled mandatory projection and credentials embedded in every endpoint", () => {
    expect(
      configSchema.safeParse({
        ...config,
        contextProjection: { enabled: false },
      }).success,
    ).toBe(false);
    expect(
      configSchema.safeParse({
        ...config,
        sources: {
          ...config.sources,
          legacy: { kind: "opencode-v1", url: "https://user:pass@host" },
        },
      }).success,
    ).toBe(false);
    expect(configSchema.safeParse(config).success).toBe(true);
  });
  it("derives ordered normalized-entry precedence with native default true", () => {
    expect(automaticCompaction([])).toBe(true);
    expect(
      automaticCompaction([
        entry({ compaction: { auto: false } }),
        entry({ compaction: {} }),
      ]),
    ).toBe(false);
    expect(
      automaticCompaction([
        entry({ compaction: { auto: false } }),
        entry({ compaction: { auto: true } }),
      ]),
    ).toBe(true);
    expect(() =>
      automaticCompaction({ compaction: { auto: false } }),
    ).toThrow();
  });
  it("skips flat directory entries and rejects unknown entry types", () => {
    expect(
      automaticCompaction([
        { type: "directory", path: "/work" },
        {
          type: "document",
          path: "/work/opencode.json",
          info: { compaction: { auto: false } },
        },
        { type: "directory", path: "/work/.opencode" },
        { type: "document", info: {} },
      ]),
    ).toBe(false);
    expect(automaticCompaction([{ type: "directory", path: "/work" }])).toBe(
      true,
    );
    expect(() => automaticCompaction([{ type: "unknown", info: {} }])).toThrow(
      "unknown config entry type",
    );
    expect(() => automaticCompaction([{ type: "document" }])).toThrow();
  });
});
describe("source-owned transport", () => {
  it("isolates Reflection X-API-Key from Basic-auth readers and encodes source query", async () => {
    const seen: Array<{
      url: string;
      headers: Headers;
      redirect: RequestRedirect | undefined;
    }> = [];
    const http = new Transport(config, async (url, init) => {
      seen.push({
        url: String(url),
        headers: new Headers(init?.headers),
        redirect: init?.redirect,
      });
      return Response.json(
        String(url).includes("/v1/sources/")
          ? registry
          : { data: [], cursor: {} },
      );
    });
    await http.source("native", signal());
    await http.history(registry, "session /?", signal());
    expect(seen[0]?.headers.get("X-API-Key")).toBe("reflection-secret");
    expect(seen[0]?.headers.get("Authorization")).toBeNull();
    expect(seen[1]?.headers.get("X-API-Key")).toBeNull();
    expect(seen[1]?.headers.get("Authorization")).toMatch(/^Basic /);
    expect(seen[1]?.url).toContain("session%20%2F%3F/message");
    expect(seen.every((request) => request.redirect === "error")).toBe(true);
  });
  it("does not cache registry failures or accept wrong registry kind/id", async () => {
    let attempts = 0;
    const http = new Transport(config, async () =>
      Response.json(++attempts === 1 ? { ...registry, id: "other" } : registry),
    );
    await expect(http.source("native", signal())).rejects.toThrow("mismatch");
    await expect(http.source("native", signal())).resolves.toEqual(registry);
    await http.source("native", signal());
    expect(attempts).toBe(2);
    await expect(http.source("missing", signal())).rejects.toThrow(
      "not configured",
    );
  });
  it("sanitizes server and transport errors", async () => {
    const http = new Transport(config, async () => {
      throw new Error("http://reader:secret@host reflection-secret");
    });
    await expect(http.source("native", signal())).rejects.toThrow(
      "source registry missing",
    );
  });
  it("uses v2 cursor order and rejects duplicate IDs", async () => {
    const calls: string[] = [];
    const http = new Transport(config, async (url) => {
      calls.push(String(url));
      return Response.json(
        calls.length === 1
          ? { data: [{ id: "later-time" }], cursor: { next: "next /" } }
          : { data: [{ id: "earlier-time" }], cursor: { next: null } },
      );
    });
    expect(await http.history(registry, "s", signal())).toEqual([
      { id: "later-time" },
      { id: "earlier-time" },
    ]);
    expect(new URL(calls[1]!).searchParams.get("cursor")).toBe("next /");
    const duplicates = new Transport(config, async () =>
      Response.json({ data: [{ id: "x" }, { id: "x" }], cursor: {} }),
    );
    await expect(duplicates.history(registry, "s", signal())).rejects.toThrow(
      "duplicate",
    );
  });
  it("checks session revision and activity before and after paging, allowing busy context", async () => {
    let revision = 1;
    let changing = false;
    const http = new Transport(config, async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/active"))
        return Response.json({ data: { s: { type: "busy" } } });
      if (path.endsWith("/message")) {
        if (changing) revision++;
        return Response.json({ data: [], cursor: {} });
      }
      return Response.json({
        data: {
          id: "s",
          time: { updated: revision },
          location: { directory: "/work" },
        },
      });
    });
    await expect(
      http.snapshot(registry, "s", signal(), false),
    ).resolves.toHaveProperty("records", []);
    await expect(http.snapshot(registry, "s", signal(), true)).rejects.toThrow(
      "active",
    );
    changing = true;
    await expect(http.snapshot(registry, "s", signal(), false)).rejects.toThrow(
      "revision/status changed",
    );
  });
  it("retries a transient revision change while paging, then succeeds", async () => {
    let revision = 1;
    let pages = 0;
    const http = new Transport(config, async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/active"))
        return Response.json({ data: { s: { type: "busy" } } });
      if (path.endsWith("/message")) {
        // Only the first page read races with a concurrent write.
        if (++pages === 1) revision++;
        return Response.json({ data: [], cursor: {} });
      }
      return Response.json({
        data: {
          id: "s",
          time: { updated: revision },
          location: { directory: "/work" },
        },
      });
    });
    const snapshot = await http.snapshot(registry, "s", signal(), false);
    expect(snapshot.info).toHaveProperty("time.updated", 2);
    expect(pages).toBe(2);
  });
  it("stops retrying a racing snapshot when the caller aborts", async () => {
    const controller = new AbortController();
    let revision = 1;
    const http = new Transport(config, async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/active"))
        return Response.json({ data: { s: { type: "busy" } } });
      if (path.endsWith("/message")) {
        revision++;
        controller.abort(new Error("cancelled by caller"));
        return Response.json({ data: [], cursor: {} });
      }
      return Response.json({
        data: {
          id: "s",
          time: { updated: revision },
          location: { directory: "/work" },
        },
      });
    });
    await expect(
      http.snapshot(registry, "s", controller.signal, false),
    ).rejects.toThrow();
    expect(revision).toBe(2);
  });
  it("treats backend 4xx without the application envelope as availability, not rejection", async () => {
    const respond = (response: () => Response) =>
      new Transport(config, async () => response());
    const failure = (response: () => Response) =>
      respond(response)
        .request("/v1/sessions/s/segments", signal())
        .then(
          () => undefined,
          (error: unknown) => error,
        );
    const gateway = await failure(
      () =>
        new Response("404 page not found", {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    );
    expect(gateway).toBeInstanceOf(AvailabilityError);
    expect(gateway).toHaveProperty("status", 404);
    expect(gateway).toHaveProperty(
      "message",
      "Reflection: endpoint temporarily unavailable (HTTP 404)",
    );
    for (const response of [
      () =>
        new Response("<html>blocked</html>", {
          status: 403,
          headers: { "content-type": "text/html" },
        }),
      () => Response.json({ error: "no envelope" }, { status: 400 }),
      () => Response.json(["detail"], { status: 400 }),
      () =>
        new Response("{broken", {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      () => Response.json({ detail: "x".repeat(70 * 1024) }, { status: 400 }),
    ])
      expect(await failure(response)).toBeInstanceOf(AvailabilityError);
    for (const response of [
      () => Response.json({ detail: "Not Found" }, { status: 404 }),
      () => Response.json({ detail: "invalid API key" }, { status: 401 }),
      () =>
        Response.json(
          { detail: [{ type: "value_error", loc: ["body"], msg: "bad" }] },
          { status: 422 },
        ),
    ]) {
      const rejected = await failure(response);
      expect(rejected).toBeInstanceOf(RequestRejectedError);
      expect(String((rejected as Error).message)).toMatch(
        /^Reflection: endpoint rejected request \(HTTP 4\d\d\)$/,
      );
    }
  });
  it("keeps history-source 4xx as rejections and never echoes response bodies", async () => {
    const http = new Transport(
      config,
      async () =>
        new Response("secret body reader-secret", {
          status: 400,
          headers: { "content-type": "text/plain" },
        }),
    );
    const error = await http
      .request("/api/session/s", signal(), config.sources.native)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(error).toBeInstanceOf(RequestRejectedError);
    expect(String((error as Error).message)).not.toContain("secret");
  });
  it("prepends v1 before pages and validates chronological boundaries", async () => {
    let call = 0;
    const message = (id: string, created: number) => ({
      info: { id, role: "user", time: { created } },
      parts: [{ type: "text", text: id }],
    });
    const http = new Transport(config, async (url) => {
      expect(new URL(String(url)).searchParams.get("directory")).toBe(
        "/legacy",
      );
      return ++call === 1
        ? Response.json([message("new", 2)], {
            headers: { "X-Next-Cursor": "old" },
          })
        : Response.json([message("old", 1)]);
    });
    const history = await http.history(
      { id: "legacy", kind: "opencode-v1", identity_scheme: "legacy" },
      "s",
      signal(),
    );
    expect(legacyHistory(history).map((item) => item.info.id)).toEqual([
      "old",
      "new",
    ]);
    expect(() => legacyHistory([...history].reverse())).toThrow("out of order");
  });
});

// Emulates the 2.0.8 message store: rows ordered by an append sequence,
// updates keep the sequence, a revert deletes a suffix, and a cursor anchors
// after an existing message or returns [] when the anchor is gone.
function nativeServer() {
  const sessions = new Map<string, Array<Record<string, unknown>>>();
  const reads: Array<{ session: string; after?: string }> = [];
  const control = { rejectNextCursor: false, racing: false, revision: 1 };
  const rows = (session: string) => {
    if (!sessions.has(session)) sessions.set(session, []);
    return sessions.get(session)!;
  };
  let created = 0;
  const user = (id: string) => ({
    id,
    type: "user",
    text: id,
    time: { created: ++created },
  });
  const assistant = (id: string, text = id) => ({
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "p", id: "m" },
    content: [{ type: "text", text }],
    time: { created: ++created, completed: created },
  });
  const shell = (id: string, status: string) => ({
    id,
    type: "shell",
    shellID: id,
    command: "sleep",
    status,
    time: { created: ++created },
  });
  const http = new Transport(config, async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/session/active")
      return Response.json({ data: {} });
    const match = url.pathname.match(/^\/api\/session\/([^/]+)(\/message)?$/);
    if (!match) throw new Error(`unexpected ${url.pathname}`);
    const session = decodeURIComponent(match[1]!);
    if (!match[2])
      return Response.json({
        data: {
          id: session,
          time: { updated: control.revision },
          location: { directory: "/work" },
        },
      });
    if (control.racing) control.revision++;
    const cursor = url.searchParams.get("cursor");
    if (cursor && control.rejectNextCursor) {
      control.rejectNextCursor = false;
      return Response.json(
        { _tag: "InvalidCursorError", message: "Invalid cursor" },
        { status: 400 },
      );
    }
    const after = cursor
      ? (
          JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
            id: string;
          }
        ).id
      : undefined;
    reads.push({ session, ...(after === undefined ? {} : { after }) });
    const all = rows(session);
    let start = 0;
    if (after !== undefined) {
      start = all.findLastIndex((message) => message.id === after) + 1;
      if (start === 0)
        return Response.json({
          data: [],
          cursor: { previous: null, next: null },
        });
    }
    const page = structuredClone(
      all.slice(start, start + Number(url.searchParams.get("limit"))),
    );
    const last = page.at(-1);
    return Response.json({
      data: page,
      cursor: {
        previous: null,
        next: last ? nativeCursorAfter(String(last.id)) : null,
      },
    });
  });
  return {
    http,
    reads,
    control,
    rows,
    user,
    assistant,
    shell,
    snapshot: (session = "s", incremental = true) =>
      http.snapshot(registry, session, signal(), false, incremental),
    expected: (session = "s") =>
      canonicalizeNativeHistory(structuredClone(rows(session))),
    revert: (session: string, id: string) => {
      const all = rows(session);
      all.splice(all.findIndex((message) => message.id === id));
    },
  };
}

describe("incremental native snapshots", () => {
  it("encodes the 2.0.8 message cursor", () => {
    expect(
      JSON.parse(
        Buffer.from(nativeCursorAfter("msg_1"), "base64url").toString(),
      ),
    ).toEqual({ id: "msg_1", order: "asc", direction: "next" });
  });
  it("reads only the tail after the settled prefix and matches a full read", async () => {
    const native = nativeServer();
    const { user, assistant } = native;
    native
      .rows("s")
      .push(
        user("u1"),
        assistant("a1"),
        user("u2"),
        assistant("a2"),
        user("u3"),
      );
    expect((await native.snapshot()).records).toEqual(native.expected());
    expect(native.reads).toEqual([
      { session: "s" },
      { session: "s", after: "u3" },
    ]);

    native.rows("s").push(assistant("a3"), user("u4"));
    native.reads.length = 0;
    // The latest assistant a2 was not cached, so the settled prefix is u1..u2
    // and the overlap re-reads u2 after anchor a1.
    expect((await native.snapshot()).records).toEqual(native.expected());
    expect(native.reads).toEqual([
      { session: "s", after: "a1" },
      { session: "s", after: "u4" },
    ]);

    native.reads.length = 0;
    expect((await native.snapshot()).records).toEqual(native.expected());
    expect(native.reads[0]).toEqual({ session: "s", after: "a2" });
  });
  it("never caches the latest assistant or anything from the first incomplete record", async () => {
    const native = nativeServer();
    const { user, assistant, shell } = native;
    native
      .rows("s")
      .push(
        user("u1"),
        assistant("a1"),
        user("u2"),
        shell("sh", "running"),
        user("u3"),
        assistant("a2"),
        user("u4"),
      );
    await native.snapshot();
    // A background shell finishes and a step retry revives the latest assistant.
    const all = native.rows("s");
    all[3] = { ...all[3], status: "exited", output: "done" };
    all[5] = assistant("a2", "retried");
    native.reads.length = 0;
    expect((await native.snapshot()).records).toEqual(native.expected());
    expect(native.reads[0]).toEqual({ session: "s", after: "a1" });
  });
  it("re-reads a retried latest assistant even when every record is complete", async () => {
    const native = nativeServer();
    const { user, assistant } = native;
    native
      .rows("s")
      .push(
        user("u1"),
        assistant("a1"),
        user("u2"),
        assistant("a2"),
        user("u3"),
      );
    await native.snapshot();
    native.rows("s")[3] = assistant("a2", "retried");
    native.reads.length = 0;
    expect((await native.snapshot()).records).toEqual(native.expected());
    expect(native.reads[0]).toEqual({ session: "s", after: "a1" });
  });
  it.each([
    ["inside the cached prefix", "u2"],
    ["at the last cached message", "u3"],
  ])("falls back to a full read after a revert %s", async (_, boundary) => {
    const native = nativeServer();
    const { user, assistant } = native;
    native
      .rows("s")
      .push(
        user("u1"),
        assistant("a1"),
        user("u2"),
        assistant("a2"),
        user("u3"),
        assistant("a3"),
        user("u4"),
      );
    await native.snapshot();
    native.revert("s", boundary);
    native.rows("s").push(user("u5"), assistant("a4"), user("u6"));
    native.reads.length = 0;
    expect((await native.snapshot()).records).toEqual(native.expected());
    expect(native.reads.at(-2)).toEqual({ session: "s" });
  });
  it("falls back to a full read when the last cached message changed", async () => {
    const native = nativeServer();
    const { user, assistant } = native;
    native
      .rows("s")
      .push(
        user("u1"),
        assistant("a1"),
        user("u2"),
        assistant("a2"),
        user("u3"),
      );
    await native.snapshot();
    native.rows("s")[2] = { ...native.rows("s")[2], text: "edited" };
    native.reads.length = 0;
    expect((await native.snapshot()).records).toEqual(native.expected());
    expect(native.reads.map((read) => read.after)).toEqual([
      "a1",
      "u3",
      undefined,
      "u3",
    ]);
  });
  it("never returns a tail that repeats a cached message ID", async () => {
    const native = nativeServer();
    const { user, assistant } = native;
    native
      .rows("s")
      .push(
        user("u1"),
        assistant("a1"),
        user("u2"),
        assistant("a2"),
        user("u3"),
      );
    await native.snapshot();
    native.rows("s").push(user("u1"));
    native.reads.length = 0;
    // The tail is discarded and the full read rejects the duplicate itself.
    await expect(native.snapshot()).rejects.toThrow("duplicate");
    expect(native.reads[0]).toEqual({ session: "s", after: "a1" });
    expect(native.reads.slice(1)).toContainEqual({ session: "s" });
  });
  it("caches only a stable snapshot", async () => {
    const native = nativeServer();
    const { user, assistant } = native;
    native
      .rows("s")
      .push(
        user("u1"),
        assistant("a1"),
        user("u2"),
        assistant("a2"),
        user("u3"),
      );
    native.control.racing = true;
    await expect(native.snapshot()).rejects.toThrow("revision/status changed");
    expect(native.http.histories.size).toBe(0);
    native.control.racing = false;
    await native.snapshot();
    expect(native.http.histories.size).toBe(1);
  });
  it("falls back to a full read when the host rejects the cursor", async () => {
    const native = nativeServer();
    const { user, assistant } = native;
    native
      .rows("s")
      .push(
        user("u1"),
        assistant("a1"),
        user("u2"),
        assistant("a2"),
        user("u3"),
      );
    await native.snapshot();
    native.rows("s").push(assistant("a3"));
    native.control.rejectNextCursor = true;
    native.reads.length = 0;
    expect((await native.snapshot()).records).toEqual(native.expected());
    expect(native.reads[0]).toEqual({ session: "s" });
  });
  it("keeps non-incremental snapshots uncached and bounds cached sessions", async () => {
    const native = nativeServer();
    const { user, assistant } = native;
    const fill = (session: string) =>
      native
        .rows(session)
        .push(
          user(`${session}u1`),
          user(`${session}u2`),
          assistant(`${session}a1`),
        );
    fill("idle");
    await native.snapshot("idle", false);
    await native.snapshot("idle", false);
    expect(native.http.histories.size).toBe(0);
    expect(
      native.reads.every(
        (read) => read.after === undefined || read.after === "idlea1",
      ),
    ).toBe(true);

    for (let index = 0; index <= HISTORY_CACHE_SESSIONS; index++) {
      fill(`s${index}`);
      await native.snapshot(`s${index}`);
    }
    expect(native.http.histories.size).toBe(HISTORY_CACHE_SESSIONS);
    expect([...native.http.histories.keys()][0]).toBe(
      JSON.stringify(["native", "s1"]),
    );

    native.http.forget("native", "s1");
    native.reads.length = 0;
    await native.snapshot("s1");
    expect(native.reads[0]).toEqual({ session: "s1" });
  });
});
