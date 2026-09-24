import { describe, expect, it } from "vitest";
import {
  AvailabilityError,
  RequestRejectedError,
  Transport,
  automaticCompaction,
  configSchema,
  legacyHistory,
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
