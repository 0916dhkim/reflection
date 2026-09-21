import { describe, expect, it, vi } from "vitest";

import {
  readHistory,
  readNativeV2History,
  assertReadableBoundary,
} from "../src/history-reader.js";

const v1 = {
  id: "v1",
  kind: "opencode-v1" as const,
  identity_scheme: "legacy" as const,
};
const v2 = {
  id: "v2",
  kind: "opencode-v2" as const,
  identity_scheme: "source-v1" as const,
};
const sources = {
  v1: { kind: "opencode-v1" as const, url: "http://v1.example" },
  otherV1: { kind: "opencode-v1" as const, url: "http://other.example" },
  v2: { kind: "opencode-v2" as const, url: "http://v2.example" },
};

function message(id: string) {
  return { info: { id, role: "user" }, parts: [] };
}

// Encoded flat SessionMessage.Info records from the pinned v2.0.8 schema.
const model = { providerID: "probe", id: "mock" };
const nativeRecords = [
  {
    id: "msg_01",
    type: "user",
    text: "Run the tests",
    time: { created: 1 },
    files: [],
    metadata: { client: "fixture" },
  },
  {
    id: "msg_02",
    type: "assistant",
    agent: "build",
    model,
    time: { created: 2, streamed: 3, completed: 4 },
    finish: "tool-calls",
    content: [
      {
        type: "reasoning",
        text: "Check the test suite",
        state: { signature: "opaque" },
      },
      { type: "text", text: "Running the tests in the background." },
      {
        type: "tool",
        id: "call_tests",
        name: "shell",
        time: { created: 2, ran: 3, completed: 4 },
        state: {
          status: "completed",
          input: { command: "pnpm test" },
          content: [
            { type: "text", text: "Started background job" },
            { type: "file", uri: "file:///tmp/tests.log", mime: "text/plain" },
          ],
          metadata: { background: true },
        },
        providerState: { signature: "tool-proof" },
      },
    ],
  },
  {
    id: "msg_03",
    type: "synthetic",
    text: "Background tests passed",
    description: "Shell completion",
    time: { created: 5 },
    futureField: { preserve: true },
  },
  { id: "msg_04", type: "idle", outcome: "succeeded", time: { created: 6 } },
  {
    id: "msg_05",
    type: "agent-switched",
    agent: "plan",
    previous: "build",
    time: { created: 7 },
  },
  {
    id: "msg_06",
    type: "model-switched",
    model: { ...model, variant: "high" },
    previous: model,
    time: { created: 8 },
  },
  {
    id: "msg_07",
    type: "location-switched",
    location: { directory: "/workspace" },
    previous: { location: { directory: "/previous" } },
    time: { created: 9 },
  },
  {
    id: "msg_08",
    type: "shell",
    shellID: "sh_01",
    command: "pwd",
    status: "exited",
    exit: 0,
    output: { output: "/workspace", cursor: 10, size: 10, truncated: false },
    time: { created: 10, completed: 11 },
  },
  {
    id: "msg_09",
    type: "skill",
    skill: "skill_tests",
    name: "tests",
    text: "Testing instructions",
    time: { created: 12 },
  },
  {
    id: "msg_10",
    type: "system",
    text: "System update",
    time: { created: 13 },
  },
  {
    id: "msg_11",
    type: "compaction",
    status: "completed",
    reason: "manual",
    summary: "Summary",
    recent: "Recent messages",
    model,
    time: { created: 14 },
  },
];

describe("readHistory", () => {
  it("uses only remote reader credentials, refuses redirects, and never falls back to the own SDK", async () => {
    const readOwnV1 = vi.fn();
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("X-Api-Key")).toBeNull();
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Basic ${Buffer.from("reader:secret").toString("base64")}`,
        );
        throw new Error(
          "https://reader:secret@remote refused Basic cmVhZGVyOnNlY3JldA==",
        );
      },
    );
    await expect(
      readHistory(
        { ...v1, id: "otherV1" },
        "session",
        {
          sources: {
            ...sources,
            otherV1: {
              ...sources.otherV1,
              username: "reader",
              password: "secret",
            },
          },
          fetchImpl,
          readOwnV1,
        },
        new AbortController().signal,
        "v1",
      ),
    ).rejects.toThrow("history source unavailable");
    expect(readOwnV1).not.toHaveBeenCalled();
  });

  it("loads v1 before pages in chronological order", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const before = new URL(String(url)).searchParams.get("before");
      return new Response(
        JSON.stringify(before ? [message("old")] : [message("new")]),
        { headers: before ? {} : { "X-Next-Cursor": "older" } },
      );
    });
    await expect(
      readHistory(
        v1,
        "session",
        { sources, fetchImpl },
        new AbortController().signal,
      ),
    ).resolves.toEqual([message("old"), message("new")]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(["overlap", "cursor"])("rejects v1 page %s", async (failure) => {
    let page = 0;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            message(failure === "overlap" ? "same" : String(page++)),
          ]),
          { headers: { "X-Next-Cursor": "same-cursor" } },
        ),
    );
    await expect(
      readHistory(
        v1,
        "session",
        { sources, fetchImpl },
        new AbortController().signal,
      ),
    ).rejects.toThrow(failure === "overlap" ? "duplicate" : "repeated");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("bounds the entire page sequence with one deadline", async () => {
    vi.useFakeTimers();
    try {
      let page = 0;
      const fetchImpl = vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 60);
            init?.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(init.signal?.reason);
              },
              { once: true },
            );
          });
          return new Response(JSON.stringify([message(String(page++))]), {
            headers: { "X-Next-Cursor": String(page) },
          });
        },
      );
      const pending = readHistory(
        v1,
        "session",
        { sources, fetchImpl, timeoutMs: 100 },
        new AbortController().signal,
      );
      const rejected = expect(pending).rejects.toThrow("timed out after 100ms");
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves native origin and never fabricates v1 parentage", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: nativeRecords, cursor: { next: null } }),
        ),
    );
    const result = await readNativeV2History(
      v2,
      "session",
      { sources, fetchImpl },
      new AbortController().signal,
    );
    expect(result).toEqual(nativeRecords);
    expect(result.filter((record) => record.type === "user")).toHaveLength(1);
    expect(result.filter((record) => record.type === "synthetic")).toHaveLength(
      1,
    );
    expect(
      result.every(
        (record) =>
          !("parentID" in record) &&
          !("info" in record) &&
          !("parts" in record),
      ),
    ).toBe(true);
  });

  it("preserves native cursor order rather than inferring delivery from creation time", async () => {
    let page = 0;
    const fetchImpl = vi.fn(async () => {
      page += 1;
      return new Response(
        JSON.stringify({
          data: [
            {
              id: `msg_${page}`,
              type: "user",
              text: "request",
              time: { created: 3 - page },
            },
          ],
          cursor: { next: page === 1 ? "next" : null },
        }),
      );
    });
    await expect(
      readNativeV2History(
        v2,
        "session",
        { sources, fetchImpl },
        new AbortController().signal,
      ),
    ).resolves.toEqual([
      { id: "msg_1", type: "user", text: "request", time: { created: 2 } },
      { id: "msg_2", type: "user", text: "request", time: { created: 1 } },
    ]);
  });

  it.each([1, 2] as const)(
    "rejects legacy boundary %s for native v2",
    (source_boundary_version) => {
      expect(() =>
        assertReadableBoundary(v2, { source_boundary_version } as Parameters<
          typeof assertReadableBoundary
        >[1]),
      ).toThrow("legacy turn boundaries");
    },
  );

  it("routes two configured v1 sources independently", async () => {
    const fetchImpl = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(url).includes("other.example")
              ? [message("other")]
              : [message("local")],
          ),
        ),
    );

    await expect(
      readHistory(
        v1,
        "session",
        { sources, fetchImpl },
        new AbortController().signal,
      ),
    ).resolves.toEqual([message("local")]);
    await expect(
      readHistory(
        { ...v1, id: "otherV1" },
        "session",
        { sources, fetchImpl },
        new AbortController().signal,
      ),
    ).resolves.toEqual([message("other")]);
  });

  it("follows v2 cursor pages without duplicate messages", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const current = new URL(String(url));
      expect(current.searchParams.get("order")).toBe(
        current.searchParams.has("cursor") ? null : "asc",
      );
      return new Response(
        JSON.stringify(
          current.searchParams.has("cursor")
            ? { data: nativeRecords.slice(2), cursor: { next: null } }
            : {
                data: nativeRecords.slice(0, 2),
                cursor: { next: "next-page" },
              },
        ),
      );
    });

    await expect(
      readNativeV2History(
        v2,
        "session",
        { sources, fetchImpl },
        new AbortController().signal,
      ),
    ).resolves.toEqual(nativeRecords);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(["duplicate", "repeated"])(
    "rejects native page %s",
    async (failure) => {
      let page = 0;
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [nativeRecords[failure === "duplicate" ? 0 : page++]],
              cursor: { next: "same" },
            }),
          ),
      );
      await expect(
        readNativeV2History(
          v2,
          "session",
          { sources, fetchImpl },
          new AbortController().signal,
        ),
      ).rejects.toThrow(failure);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it("fails rather than returning partial native history after a later page error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: nativeRecords.slice(0, 2),
            cursor: { next: "next" },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response("private endpoint details", { status: 503 }),
      );
    await expect(
      readNativeV2History(
        v2,
        "session",
        { sources, fetchImpl },
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      "history source unavailable or returned an invalid response",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: "running", summary: "", recent: "" },
    {
      status: "failed",
      error: { type: "provider", message: "Provider unavailable" },
    },
  ])("preserves native compaction state: %j", async (state) => {
    const record = {
      id: "msg_compaction",
      type: "compaction",
      time: { created: 1 },
      reason: "manual",
      ...state,
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [record], cursor: { next: null } }),
        ),
    );
    await expect(
      readNativeV2History(
        v2,
        "session",
        { sources, fetchImpl },
        new AbortController().signal,
      ),
    ).resolves.toEqual([record]);
  });

  it.each([
    { info: { id: "msg_fake", type: "user" }, parts: [] },
    { ...nativeRecords[0], id: undefined },
    { ...nativeRecords[0], type: "future-unknown" },
    { ...nativeRecords[0], text: undefined },
    { ...nativeRecords[2], text: 42 },
    { ...nativeRecords[1], content: undefined },
    { ...nativeRecords[1], content: [{ type: "text", text: 42 }] },
    {
      ...nativeRecords[1],
      content: [{ type: "file", uri: "file:///tmp/file" }],
    },
    {
      ...nativeRecords[1],
      content: [
        {
          type: "tool",
          id: "call",
          name: "shell",
          time: { created: 2 },
          state: { status: "completed", input: {}, content: [] },
        },
      ],
    },
    { ...nativeRecords[3], outcome: "unknown" },
    { ...nativeRecords[4], agent: undefined },
    { ...nativeRecords[5], model: { providerID: "probe" } },
    { ...nativeRecords[6], location: {} },
    { ...nativeRecords[7], command: undefined },
    { ...nativeRecords[8], skill: undefined },
    { ...nativeRecords[10], summary: undefined },
    { ...nativeRecords[0], time: { created: "yesterday" } },
  ])("rejects malformed or unknown native records: %j", async (record) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [record], cursor: { next: null } }),
        ),
    );
    await expect(
      readNativeV2History(
        v2,
        "session",
        { sources, fetchImpl },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/v2 message/);
  });

  it.each([
    { status: "streaming", input: '{"command":' },
    { status: "running", input: { command: "pwd" }, metadata: {} },
    {
      status: "error",
      input: {},
      error: { type: "unknown", message: "Tool failed" },
    },
  ])(
    "preserves incomplete and failed native tool states: %j",
    async (state) => {
      const record = {
        ...nativeRecords[1],
        time: { created: 2 },
        content: [
          {
            type: "tool",
            id: "call_partial",
            name: "shell",
            state,
            time: { created: 2 },
          },
        ],
      };
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: [record], cursor: { next: null } }),
          ),
      );
      await expect(
        readNativeV2History(
          v2,
          "session",
          { sources, fetchImpl },
          new AbortController().signal,
        ),
      ).resolves.toEqual([record]);
    },
  );

  it("accepts native boundaries only for v2 source-v1 registry entries", () => {
    const segment = {
      source_id: "v2",
      id: "segment",
      session_id: "session",
      source_boundary_version: 3 as const,
      start_source_message_id: "msg_start",
      end_source_message_id: "msg_end",
      summary: "summary",
      claims: [],
      created_at: "now",
      updated_at: "now",
    };
    expect(() => assertReadableBoundary(v2, segment)).not.toThrow();
    expect(() => assertReadableBoundary(v1, segment)).toThrow(
      "native hydration requires",
    );
    expect(() =>
      assertReadableBoundary({ ...v2, identity_scheme: "legacy" }, segment),
    ).toThrow("native hydration requires");
  });

  it("rejects an unavailable or mismatched source without fallback", async () => {
    await expect(
      readHistory(
        { ...v1, id: "missing" },
        "session",
        { sources, fetchImpl: vi.fn() },
        new AbortController().signal,
      ),
    ).rejects.toThrow("not configured");
    await expect(
      readNativeV2History(
        { ...v1, kind: "opencode-v2" },
        "session",
        { sources, fetchImpl: vi.fn() },
        new AbortController().signal,
      ),
    ).rejects.toThrow("does not match");
  });
});
