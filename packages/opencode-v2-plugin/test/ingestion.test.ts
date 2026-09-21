import { expect, it, vi } from "vitest";
import { canonicalizeNativeHistory } from "@reflection/opencode-v2-core/history";
import { planNativeSegments } from "@reflection/opencode-v2-core/segmentation";
import { Ingestion } from "../src/ingestion.js";
import { Operations } from "../src/operations.js";
import { Transport, AvailabilityError, type Config } from "../src/transport.js";
import {
  nativeSourceFingerprint,
  type NativeSessionSegmentsResponse,
} from "@reflection/shared/native";

const source = {
  id: "native",
  kind: "opencode-v2" as const,
  identity_scheme: "source-v1" as const,
};
const config: Config = {
  url: "http://reflection.invalid",
  apiKey: "secret",
  sourceId: "native",
  sources: { native: { kind: "opencode-v2", url: "http://native.invalid" } },
  contextProjection: { enabled: true },
};
const manifest = {
  source_id: "native",
  manifest_version: 2 as const,
  session_id: "s",
  segments: [],
  boundaries: [],
  targets: [],
};
const history = [
  { id: "msg_u", type: "user", text: "x".repeat(20001), time: { created: 1 } },
];
const segment = planNativeSegments({
  source,
  sessionId: "s",
  records: canonicalizeNativeHistory(history),
})[0]!;
const job = {
  id: 1,
  source_id: "native",
  segment_id: segment.id,
  source_boundary_version: 3,
  start_source_message_id: "msg_u",
  end_source_message_id: "msg_u",
  source_fingerprint: segment.fingerprint,
  projection_version: 3,
  status: "pending",
  attempts: 0,
  error: null,
  created_at: "now",
  started_at: null,
  finished_at: null,
  next_attempt_at: "now",
};

it.each(["source_fingerprint", "segment_id"])(
  "rejects owned job with mismatched %s",
  async (field) => {
    const http = new Transport(config, async () =>
      Response.json({
        ...job,
        [field]:
          field === "segment_id"
            ? "11111111-1111-4111-8111-111111111111"
            : "wrong",
      }),
    );
    await expect(
      new Ingestion(http, new Operations(), "/work").submit(
        [segment],
        manifest,
        AbortSignal.timeout(1000),
        50,
      ),
    ).rejects.toThrow("mismatch");
  },
);
it("retries a failed segment+hash only once with explicit source body", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const http = new Transport(config, async (url, init) => {
    requests.push({
      path: new URL(String(url)).pathname,
      body: JSON.parse(String(init?.body)) as unknown,
    });
    return Response.json({
      ...job,
      status: "failed",
      started_at: String(url).endsWith("/retry") ? "new-attempt" : null,
    });
  });
  const ingestion = new Ingestion(http, new Operations(), "/work");
  await expect(
    ingestion.submit([segment], manifest, AbortSignal.timeout(1000), 50),
  ).rejects.toThrow("after one retry");
  await expect(
    ingestion.submit([segment], manifest, AbortSignal.timeout(1000), 50),
  ).rejects.toThrow("after one retry");
  expect(requests.filter((request) => request.path.includes("/retry"))).toEqual(
    [{ path: "/v1/jobs/1/retry", body: { source_id: "native" } }],
  );
});
it("deduplicates exact successful submissions and promotes closed ranges to priority 50", async () => {
  const priorities: unknown[] = [];
  const http = new Transport(config, async (_url, init) => {
    priorities.push(
      (JSON.parse(String(init?.body)) as Record<string, unknown>)
        .processing_priority,
    );
    return Response.json(job);
  });
  const ingestion = new Ingestion(http, new Operations(), "/work");
  await ingestion.submit(
    [{ ...segment, closed: false }],
    manifest,
    AbortSignal.timeout(1000),
    50,
  );
  const confirmed = {
    ...manifest,
    targets: [
      {
        id: segment.id,
        source_boundary_version: 3 as const,
        start_source_message_id: "msg_u",
        end_source_message_id: "msg_u",
        projection_version: 3,
        source_fingerprint: segment.fingerprint,
        status: "pending" as const,
      },
    ],
  };
  await ingestion.submit([segment], confirmed, AbortSignal.timeout(1000), 50);
  await ingestion.submit([segment], confirmed, AbortSignal.timeout(1000), 100);
  await ingestion.submit([segment], confirmed, AbortSignal.timeout(1000), 50);
  await ingestion.submit([segment], confirmed, AbortSignal.timeout(1000), 100);
  expect(priorities).toEqual([0, 50, 100]);
});
it("503 retry delivery is not consumed when the owned job remains authoritatively unchanged", async () => {
  let retryPosts = 0;
  let businessRetries = 0;
  let recover = false;
  const http = new Transport(config, async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/retry")) {
      retryPosts++;
      if (!recover) return new Response("unavailable", { status: 503 });
      businessRetries++;
      return Response.json(job);
    }
    if (url.pathname === "/v1/jobs/1") {
      expect(url.searchParams.get("source_id")).toBe("native");
      expect(new Headers(init?.headers).get("X-API-Key")).toBe("secret");
    }
    return Response.json({ ...job, status: "failed" });
  });
  const ingestion = new Ingestion(http, new Operations(), "/work");
  await expect(
    ingestion.submit([segment], manifest, AbortSignal.timeout(1000), 100),
  ).rejects.toBeInstanceOf(AvailabilityError);
  recover = true;
  await ingestion.submit([segment], manifest, AbortSignal.timeout(1000), 100);
  expect(retryPosts).toBe(2);
  expect(businessRetries).toBe(1);
});
it.each([false, true])(
  "timeout after accepted retry reconciles pending without another POST (delayed read: %s)",
  async (delayed) => {
    let posts = 0;
    let reads = 0;
    let readAvailable = !delayed;
    const http = new Transport(config, async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/retry")) {
        posts++;
        throw new DOMException("lost response", "TimeoutError");
      }
      if (url.pathname === "/v1/jobs/1") {
        reads++;
        expect(url.searchParams.get("source_id")).toBe("native");
        if (!readAvailable) return new Response("unavailable", { status: 503 });
        return Response.json(job);
      }
      return Response.json({ ...job, status: "failed" });
    });
    const ingestion = new Ingestion(http, new Operations(), "/work");
    if (delayed) {
      await expect(
        ingestion.submit([segment], manifest, AbortSignal.timeout(1000), 50),
      ).rejects.toBeInstanceOf(AvailabilityError);
      readAvailable = true;
    }
    await ingestion.submit([segment], manifest, AbortSignal.timeout(1000), 50);
    expect(posts).toBe(1);
    expect(reads).toBe(delayed ? 2 : 1);
    await expect(
      ingestion.submit([segment], manifest, AbortSignal.timeout(1000), 50),
    ).rejects.toThrow("after one retry");
    expect(posts).toBe(1);
  },
);
it("an unchanged failed job after ambiguous timeout stays reconcilable, not exhausted or redelivered", async () => {
  let posts = 0;
  let changed = false;
  const http = new Transport(config, async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/retry")) {
      posts++;
      throw new DOMException("lost response", "TimeoutError");
    }
    return Response.json({
      ...job,
      status: "failed",
      started_at: path === "/v1/jobs/1" && changed ? "second-attempt" : null,
    });
  });
  const ingestion = new Ingestion(http, new Operations(), "/work");
  for (let i = 0; i < 2; i++)
    await expect(
      ingestion.submit([segment], manifest, AbortSignal.timeout(1000), 50),
    ).rejects.toBeInstanceOf(AvailabilityError);
  expect(posts).toBe(1);
  changed = true;
  await expect(
    ingestion.submit([segment], manifest, AbortSignal.timeout(1000), 50),
  ).rejects.toThrow("after one retry");
  expect(posts).toBe(1);
});
it("503 followed by unavailable reconciliation preserves later retry delivery when unchanged", async () => {
  let posts = 0;
  let recovered = false;
  const http = new Transport(config, async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/retry")) {
      posts++;
      return recovered
        ? Response.json(job)
        : new Response("unavailable", { status: 503 });
    }
    if (path === "/v1/jobs/1" && !recovered)
      return new Response("unavailable", { status: 503 });
    return Response.json({ ...job, status: "failed" });
  });
  const ingestion = new Ingestion(http, new Operations(), "/work");
  await expect(
    ingestion.submit([segment], manifest, AbortSignal.timeout(1000), 50),
  ).rejects.toBeInstanceOf(AvailabilityError);
  recovered = true;
  await ingestion.submit([segment], manifest, AbortSignal.timeout(1000), 50);
  expect(posts).toBe(2);
});
it("concurrent retry requests cannot issue duplicate business retry POSTs", async () => {
  let posts = 0;
  let release!: () => void;
  const http = new Transport(config, async (input) => {
    if (new URL(String(input)).pathname.endsWith("/retry")) {
      posts++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return Response.json(job);
    }
    return Response.json({ ...job, status: "failed" });
  });
  const ingestion = new Ingestion(http, new Operations(), "/work");
  const first = ingestion.submit(
    [segment],
    manifest,
    AbortSignal.timeout(1000),
    50,
  );
  await vi.waitFor(() => expect(posts).toBe(1));
  await expect(
    ingestion.submit([segment], manifest, AbortSignal.timeout(1000), 50),
  ).rejects.toBeInstanceOf(AvailabilityError);
  release();
  await first;
  expect(posts).toBe(1);
});
it("quick retry failure with a changed start time consumes the confirmed allowance after timeout", async () => {
  let posts = 0;
  const http = new Transport(config, async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/retry")) {
      posts++;
      throw new DOMException("lost response", "TimeoutError");
    }
    return Response.json({
      ...job,
      status: "failed",
      started_at: path === "/v1/jobs/1" ? "new-start" : "old-start",
    });
  });
  const ingestion = new Ingestion(http, new Operations(), "/work");
  for (let i = 0; i < 2; i++)
    await expect(
      ingestion.submit([segment], manifest, AbortSignal.timeout(1000), 50),
    ).rejects.toThrow("after one retry");
  expect(posts).toBe(1);
});
it.each(["id", "source_id", "source_fingerprint"])(
  "reconciliation rejects mismatched %s and never reissues an ambiguous retry",
  async (field) => {
    let posts = 0;
    const http = new Transport(config, async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/retry")) {
        posts++;
        throw new DOMException("lost response", "TimeoutError");
      }
      if (path === "/v1/jobs/1")
        return Response.json({ ...job, [field]: field === "id" ? 2 : "wrong" });
      return Response.json({ ...job, status: "failed" });
    });
    const ingestion = new Ingestion(http, new Operations(), "/work");
    for (let i = 0; i < 2; i++)
      await expect(
        ingestion.submit([segment], manifest, AbortSignal.timeout(1000), 50),
      ).rejects.toThrow();
    expect(posts).toBe(1);
  },
);
it.each([false, true])(
  "current target supersedes stale ineligible boundary, including advanced end: %s",
  async (advanced) => {
    const request = advanced
      ? {
          ...segment.request,
          end_source_message_id: "msg_v",
          messages: [
            ...segment.request.messages,
            { id: "msg_v", type: "user" as const, text: "next" },
          ],
        }
      : segment.request;
    const current = {
      ...segment,
      request,
      fingerprint: nativeSourceFingerprint(request),
    };
    const target = {
      id: current.id,
      source_boundary_version: 3 as const,
      start_source_message_id: "msg_u",
      end_source_message_id: request.end_source_message_id,
      projection_version: 3,
      source_fingerprint: current.fingerprint,
      status: "pending" as const,
    };
    const owned: NativeSessionSegmentsResponse = {
      ...manifest,
      targets: [target],
      boundaries: [
        {
          ...target,
          end_source_message_id: "msg_u",
          source_fingerprint: "stale",
          source_eligible: false,
        },
      ].map(({ status: _status, ...boundary }) => boundary),
    };
    const priorities: unknown[] = [];
    let retries = 0;
    let failed = false;
    const http = new Transport(config, async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/retry")) {
        retries++;
        failed = false;
      } else
        priorities.push(
          (JSON.parse(String(init?.body)) as Record<string, unknown>)
            .processing_priority,
        );
      return Response.json({
        ...job,
        end_source_message_id: request.end_source_message_id,
        source_fingerprint: current.fingerprint,
        status: failed ? "failed" : "pending",
      });
    });
    const ingestion = new Ingestion(http, new Operations(), "/work");
    for (let i = 0; i < 3; i++)
      await ingestion.submit([current], owned, AbortSignal.timeout(1000), 50);
    expect(priorities).toEqual([50]);
    for (let i = 0; i < 2; i++)
      await ingestion.submit([current], owned, AbortSignal.timeout(1000), 100);
    expect(priorities).toEqual([50, 100]);
    failed = true;
    await ingestion.submit(
      [current],
      { ...owned, targets: [{ ...target, status: "failed" }] },
      AbortSignal.timeout(1000),
      100,
    );
    expect(retries).toBe(1);
    await ingestion.submit(
      [current],
      { ...owned, targets: [{ ...target, source_fingerprint: "changed" }] },
      AbortSignal.timeout(1000),
      100,
    );
    expect(priorities).toEqual([50, 100, 100, 100]);
  },
);
it("coalesces duplicate idle notifications with one dirty rerun", async () => {
  const ingestion = new Ingestion(
    new Transport(config),
    new Operations(),
    "/work",
  );
  let release!: () => void;
  const update = vi
    .spyOn(ingestion, "update")
    .mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    )
    .mockResolvedValue(undefined);
  vi.spyOn(ingestion, "sweep").mockResolvedValue(undefined);
  const first = ingestion.schedule("s");
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  const second = ingestion.schedule("s");
  ingestion.schedule("s");
  expect(first).toBe(second);
  release();
  await first;
  expect(update).toHaveBeenCalledTimes(2);
});
it.each(["open", "closed"])(
  "sweeps an inactive 10-minute %s snapshot at priority zero, with location isolation",
  async (mode) => {
    const posts: unknown[] = [];
    const own = {
      id: "s",
      time: { updated: Date.now() - 600001 },
      location: { directory: "/work" },
    };
    const http = new Transport(config, async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v1/sources/native") return Response.json(source);
      if (path === "/api/session")
        return Response.json({
          data: [
            { ...own, id: "other", location: { directory: "/elsewhere" } },
            own,
          ],
          cursor: {},
        });
      if (path === "/api/session/active") return Response.json({ data: {} });
      if (path === "/api/session/s") return Response.json({ data: own });
      if (path === "/api/session/s/message")
        return Response.json({
          data: [
            {
              ...history[0],
              text: mode === "open" ? "small" : "x".repeat(20001),
            },
          ],
          cursor: {},
        });
      if (path.includes("/segments") && init?.method === "GET")
        return Response.json(manifest);
      posts.push(JSON.parse(String(init?.body)) as unknown);
      const open = planNativeSegments({
        source,
        sessionId: "s",
        records: canonicalizeNativeHistory([
          {
            ...history[0],
            text: mode === "open" ? "small" : "x".repeat(20001),
          },
        ]),
        allowOpenSnapshot: true,
      })[0]!;
      return Response.json({ ...job, source_fingerprint: open.fingerprint });
    });
    const ingestion = new Ingestion(http, new Operations(), "/work");
    await ingestion.sweep();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toHaveProperty("processing_priority", 0);
  },
);

it.each([
  {
    name: "recent idle with old admission",
    updatedAge: 1200000,
    idleAge: 1000,
    activeAt: 0,
    posts: 0,
  },
  {
    name: "old idle and old admission",
    updatedAge: 1200000,
    idleAge: 700000,
    activeAt: 0,
    posts: 1,
  },
  {
    name: "recent admission with old idle",
    updatedAge: 1000,
    idleAge: 1200000,
    activeAt: 0,
    posts: 0,
  },
  {
    name: "imported history without idle",
    updatedAge: 1200000,
    idleAge: undefined,
    activeAt: 0,
    posts: 1,
  },
  {
    name: "active before snapshot",
    updatedAge: 1200000,
    idleAge: 700000,
    activeAt: 1,
    posts: 0,
  },
  {
    name: "active after snapshot",
    updatedAge: 1200000,
    idleAge: 700000,
    activeAt: 2,
    posts: 0,
  },
  {
    name: "active before submission",
    updatedAge: 1200000,
    idleAge: 700000,
    activeAt: 3,
    posts: 0,
  },
])("open snapshot inactivity policy: $name", async (scenario) => {
  const now = Date.now();
  const info = {
    id: "s",
    location: { directory: "/work" },
    time: {
      updated: now - scenario.updatedAge,
      ...(scenario.idleAge === undefined
        ? {}
        : { idle: now - scenario.idleAge }),
    },
  };
  const raw = [{ ...history[0], text: "small" }];
  const open = planNativeSegments({
    source,
    sessionId: "s",
    records: canonicalizeNativeHistory(raw),
    allowOpenSnapshot: true,
  })[0]!;
  let activityReads = 0;
  const posts: unknown[] = [];
  const http = new Transport(config, async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/sources/native") return Response.json(source);
    if (path === "/api/session/s") return Response.json({ data: info });
    if (path === "/api/session/active") {
      activityReads++;
      return Response.json({
        data:
          scenario.activeAt > 0 && activityReads >= scenario.activeAt
            ? { s: { type: "busy" } }
            : {},
      });
    }
    if (path === "/api/session/s/message")
      return Response.json({ data: raw, cursor: {} });
    if (path === "/v1/sessions/s/segments") return Response.json(manifest);
    expect(path).toBe("/v1/segments");
    posts.push(JSON.parse(String(init?.body)) as unknown);
    return Response.json({ ...job, source_fingerprint: open.fingerprint });
  });
  const ingestion = new Ingestion(http, new Operations(), "/work");
  const update = ingestion.update("s", true, AbortSignal.timeout(1000));
  if (scenario.activeAt > 0) await expect(update).rejects.toThrow();
  else await update;
  expect(posts).toHaveLength(scenario.posts);
  if (scenario.posts > 0)
    expect(posts[0]).toHaveProperty("processing_priority", 0);
});

it.each([
  "changed-target",
  "empty",
  "failed",
  "superseded",
  "range",
  "projection",
])("does not let cached submissions hide authoritative %s", async (reason) => {
  const target = {
    id: segment.id,
    source_boundary_version: 3 as const,
    start_source_message_id: "msg_u",
    end_source_message_id: "msg_u",
    projection_version: 3,
    source_fingerprint: segment.fingerprint,
    status: "pending" as const,
  };
  const confirmed: NativeSessionSegmentsResponse = {
    ...manifest,
    targets: [target],
  };
  const fetch = vi.fn(async () => Response.json(job));
  const ingestion = new Ingestion(
    new Transport(config, fetch),
    new Operations(),
    "/work",
  );
  await ingestion.submit([segment], confirmed, AbortSignal.timeout(1000), 50);
  await ingestion.submit([segment], confirmed, AbortSignal.timeout(1000), 50);
  expect(fetch).toHaveBeenCalledTimes(1);
  const changed: NativeSessionSegmentsResponse = {
    ...confirmed,
    targets: [{ ...target }],
  };
  if (reason === "empty") changed.targets = [];
  if (reason === "changed-target")
    changed.targets[0]!.source_fingerprint = "other";
  if (reason === "failed" || reason === "superseded")
    changed.targets[0]!.status = reason;
  if (reason === "range")
    changed.targets[0]!.end_source_message_id = "different";
  if (reason === "projection") changed.targets[0]!.projection_version = 2;
  await ingestion.submit([segment], changed, AbortSignal.timeout(1000), 50);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("rejects a non-native manifest boundary instead of trusting the cache", async () => {
  const ingestion = new Ingestion(
    new Transport(config, async () => Response.json(job)),
    new Operations(),
    "/work",
  );
  await ingestion.submit([segment], manifest, AbortSignal.timeout(1000), 50);
  const invalid = {
    ...manifest,
    targets: [
      {
        id: segment.id,
        source_boundary_version: 2,
        start_source_message_id: "msg_u",
        end_source_message_id: "msg_u",
        projection_version: 3,
        source_fingerprint: segment.fingerprint,
        status: "pending",
      },
    ],
  };
  await expect(
    ingestion.submit(
      [segment],
      invalid as NativeSessionSegmentsResponse,
      AbortSignal.timeout(1000),
      50,
    ),
  ).rejects.toThrow();
});
it("idle completion triggers a sweep, failed idle ingestion does not", async () => {
  const ingestion = new Ingestion(
    new Transport(config),
    new Operations(),
    "/work",
  );
  const sweep = vi.spyOn(ingestion, "sweep").mockResolvedValue(undefined);
  vi.spyOn(ingestion, "update")
    .mockResolvedValueOnce(true)
    .mockRejectedValueOnce(new Error("unavailable"));
  await ingestion.schedule("s");
  await ingestion.schedule("s");
  expect(sweep).toHaveBeenCalledTimes(1);
});
it("paired idle does not abort or duplicate an in-progress owned POST", async () => {
  const operations = new Operations();
  let release!: () => void;
  let owned = false;
  let posts = 0;
  let aborted = false;
  const info = {
    id: "s",
    time: { updated: Date.now() },
    location: { directory: "/work" },
  };
  const target = {
    id: segment.id,
    source_boundary_version: 3 as const,
    start_source_message_id: "msg_u",
    end_source_message_id: "msg_u",
    projection_version: 3,
    source_fingerprint: segment.fingerprint,
    status: "pending" as const,
  };
  const http = new Transport(config, async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/sources/native") return Response.json(source);
    if (path === "/api/session/active") return Response.json({ data: {} });
    if (path === "/api/session/s") return Response.json({ data: info });
    if (path === "/api/session") return Response.json({ data: [], cursor: {} });
    if (path.endsWith("/message"))
      return Response.json({ data: history, cursor: {} });
    if (init?.method === "GET")
      return Response.json({ ...manifest, targets: owned ? [target] : [] });
    posts++;
    init?.signal?.addEventListener(
      "abort",
      () => {
        aborted = true;
      },
      { once: true },
    );
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    owned = true;
    return Response.json(job);
  });
  const ingestion = new Ingestion(http, operations, "/work");
  const first = ingestion.schedule("s");
  await vi.waitFor(() => expect(posts).toBe(1));
  operations.abort("s", true);
  const paired = ingestion.schedule("s");
  expect(paired).toBe(first);
  release();
  await first;
  expect(posts).toBe(1);
  expect(aborted).toBe(false);
  await operations.dispose();
});
it("coalesces sweep triggers into a latest rerun and visits at most 20 rotating candidate slots", async () => {
  const operations = new Operations();
  const queries: URL[] = [];
  let release!: () => void;
  const http = new Transport(config, async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/sources/native") return Response.json(source);
    queries.push(url);
    if (queries.length > 1) return Response.json({ data: [], cursor: {} });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return Response.json({
      data: Array.from({ length: 25 }, (_, index) => ({
        id: `s${index}`,
        location: { directory: "/work" },
        time: { updated: 1 },
      })),
      cursor: { next: "page2" },
    });
  });
  const ingestion = new Ingestion(http, operations, "/work");
  const update = vi.spyOn(ingestion, "update").mockResolvedValue(true);
  const first = ingestion.sweep();
  await vi.waitFor(() => expect(queries).toHaveLength(1));
  expect(ingestion.sweep()).toBe(first);
  expect(ingestion.sweep()).toBe(first);
  release();
  await first;
  await vi.waitFor(() => expect(queries).toHaveLength(2));
  expect(update).toHaveBeenCalledTimes(20);
  expect(queries[0]!.searchParams.get("limit")).toBe("20");
  expect(queries[1]!.searchParams.get("cursor")).toBe("page2");
  await operations.dispose();
});
