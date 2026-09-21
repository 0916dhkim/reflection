import { describe, expect, it } from "vitest";
import type { NativeSessionSegmentsResponse } from "@reflection/shared/native";

import {
  canonicalizeNativeHistory,
  type NativeCanonicalRecord,
} from "../src/history.js";
import {
  hydrateNativeRange,
  planNativeSegments,
  validateNativeSegmentRequest,
} from "../src/segmentation.js";

const source = {
  id: "source-a",
  kind: "opencode-v2",
  identity_scheme: "source-v1",
} as const;

function user(id: string, text: string, created = 0): unknown {
  return { id, type: "user", time: { created }, text };
}

function assistant(
  id: string,
  text: string,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    id,
    type: "assistant",
    time: { created: 0, completed: 1 },
    agent: "build",
    model: { providerID: "openai", id: "gpt" },
    content: [{ type: "text", text }],
    ...overrides,
  };
}

function records(...history: unknown[]): NativeCanonicalRecord[] {
  return canonicalizeNativeHistory(history);
}

describe("canonicalizeNativeHistory", () => {
  it("hydrates shell commands and visible output without metadata or trimming", () => {
    const raw = {
      id: "shell",
      type: "shell",
      time: { created: 9 },
      shellID: "sh_1",
      command: "  printf 'hello'\n",
      status: "exited",
      exit: 2,
      output: {
        output: "hello\n  exact output  ",
        cursor: 10,
        size: 20,
        truncated: false,
      },
      error: { type: "ExitError", message: "command failed" },
      metadata: { secret: "host-only" },
    };
    const snapshot = records(raw);
    const [hydrated] = hydrateNativeRange(snapshot, {
      start_source_message_id: "shell",
      end_source_message_id: "shell",
    });
    expect(snapshot[0]?.raw).toBe(raw);
    expect(snapshot[0]?.complete).toBe(true);
    expect(hydrated?.type).toBe("shell");
    expect(hydrated?.text).toContain(raw.command);
    expect(hydrated?.text).toContain(raw.output.output);
    expect(hydrated?.text).toContain("exit: 2");
    expect(hydrated?.text).toContain("ExitError: command failed");
    expect(hydrated?.text).not.toContain("host-only");
    expect(() => records({ ...raw, command: "x".repeat(1_000_001) })).toThrow(
      "exceeds the message text limit",
    );
    const [truncated] = records({
      ...raw,
      output: { ...raw.output, truncated: true },
    });
    expect(truncated?.omissions).toEqual(["truncated-shell"]);
  });

  it("renders attachment-only users as bounded descriptors and charges media pressure", () => {
    const raw = {
      id: "image",
      type: "user",
      time: { created: 1 },
      text: "",
      files: [
        {
          mime: "image/png",
          data: "BASE64SECRET".repeat(100_000),
          name: "photo.png",
          description: "Screenshot of the settings",
          source: {
            type: "uri",
            uri: "https://alice:password@example.com/photo.png?token=SECRET",
          },
        },
      ],
    };
    const [image] = records(raw);
    expect(image?.raw).toBe(raw);
    expect(image?.source.type).toBe("user");
    expect(image?.source.text).toContain("Attachment");
    expect(image?.source.text).toContain("photo.png");
    expect(image?.source.text).toContain("Screenshot of the settings");
    expect(image?.source.text).toContain("image/png");
    expect(image?.source.text).toContain("https://example.com/photo.png");
    expect(image?.source.text).not.toMatch(
      /BASE64SECRET|password|token=|alice/,
    );
    expect(image?.weightedChars).toBeGreaterThanOrEqual(32_000);
    expect(image?.weightedChars).toBeLessThan(33_000);
    expect(image?.omissions).toContain("media");
    const plan = planNativeSegments({
      source,
      sessionId: "session",
      records: records(raw, user("next", "next")),
      allowOpenSnapshot: true,
    });
    expect(plan[0]?.sourceMessageIds).toEqual(["image"]);
    expect(plan[0]?.closed).toBe(true);
    const [withText] = records({ ...raw, text: "  exact user text\n" });
    expect(withText?.source.text.startsWith("  exact user text\n")).toBe(true);
    const [inline] = records({
      ...raw,
      files: [
        {
          mime: "image/png",
          data: "AAAA",
          name: "paste.png",
          description: "Pasted image",
          source: { type: "inline" },
        },
      ],
    });
    expect(inline?.source.text).not.toContain("AAAA");
    expect(inline?.source.text).toContain('"source":"inline"');
    expect(inline?.source.text).toContain("paste.png");
    expect(inline?.source.text).toContain("Pasted image");
    expect(inline?.weightedChars).toBeGreaterThanOrEqual(32_000);
    const [bounded] = records({
      ...raw,
      files: [
        {
          mime: "image/png",
          data: "AAAA",
          name: "x".repeat(10_000),
          source: { type: "inline" },
        },
      ],
    });
    expect(bounded?.source.text.length).toBeLessThan(700);
    expect(bounded?.source.text).toContain("descriptor truncated");
  });

  it("preserves valid mention and extra fields in raw but never serializes attachment bytes", () => {
    const file = {
      mime: "image/png",
      data: "A".repeat(5_000_000),
      name: "inline.png",
      description: "data:image/png;base64,SECRET",
      source: { type: "inline" },
      mention: { start: 0, end: 4, text: "file" },
      extra: "raw-only",
    };
    const raw = {
      id: "inline",
      type: "user",
      time: { created: 0 },
      text: "file",
      files: [file],
    };
    const [item] = records(raw);
    expect(item?.raw).toBe(raw);
    expect(item?.raw.files).toBe(raw.files);
    expect(item?.source.text).not.toMatch(/AAAA|SECRET|raw-only/);
    expect(item?.source.text).toContain("data URL omitted");
    expect(item?.source.text.length).toBeLessThan(500);
    expect(item?.weightedChars).toBeLessThan(33_000);
    for (const mention of [
      null,
      {},
      { start: Infinity, end: 1, text: "x" },
      { start: 0, end: NaN, text: "x" },
      { start: 0, end: 1, text: 1 },
    ]) {
      expect(() => records({ ...raw, files: [{ ...file, mention }] })).toThrow(
        "file mention",
      );
    }
    // Pinned Prompt.Mention constrains finiteness, not range ordering. These
    // offsets are provenance only; do not reject schema-valid source history.
    for (const mention of [
      { start: -1, end: 0, text: "x" },
      { start: 2, end: 1, text: "x" },
    ]) {
      expect(() =>
        records({ ...raw, files: [{ ...file, mention }] }),
      ).not.toThrow();
    }
    for (const source of [
      undefined,
      null,
      "file:///tmp/a.png",
      {},
      { type: "other" },
      { path: "/tmp/a.png" },
      { type: "uri" },
      { type: "uri", uri: 1 },
    ]) {
      expect(() => records({ ...raw, files: [{ ...file, source }] })).toThrow(
        "file source",
      );
    }
    for (const override of [
      { name: 1 },
      { description: false },
      { data: null },
    ]) {
      expect(() =>
        records({ ...raw, files: [{ ...file, ...override }] }),
      ).toThrow("file body");
    }
  });

  it("fails closed for unknown files and rejects oversized ordinary text", () => {
    for (const files of [
      null,
      {},
      [null],
      [{ mime: "image/png" }],
      [{ mime: "image/png", data: 1 }],
      [{ mime: "image/png", data: "AAAA", source: { mystery: true } }],
    ]) {
      expect(() =>
        records({
          id: "file",
          type: "user",
          time: { created: 0 },
          text: "",
          files,
        }),
      ).toThrow("file");
    }
    expect(() => records(user("huge", "x".repeat(1_000_001)))).toThrow(
      "exceeds the message text limit",
    );
    expect(
      records(user("exact", "x".repeat(30_000)))[0]?.source.text,
    ).toHaveLength(30_000);
  });

  it("does not attribute injected skill context to the user", () => {
    const raw = {
      id: "skills",
      type: "user",
      time: { created: 0 },
      text: "  request\n",
      skills: [{ text: "Machine-injected instructions" }],
    };
    const [item] = records(raw);
    expect(item?.raw).toBe(raw);
    expect(item?.source.text).toBe(raw.text);
    expect(item?.omissions).toContain("tool-context");
  });

  it("preserves meaningful controls and fingerprints directory changes", () => {
    const location = (directory: string) => ({
      id: "location",
      type: "location-switched",
      time: { created: 0 },
      location: { directory },
    });
    const history = [
      location("/workspace"),
      {
        id: "model",
        type: "model-switched",
        time: { created: 0 },
        model: {
          providerID: "openai",
          id: "gpt",
          variant: "high",
          apiKey: "SECRET",
        },
      },
      {
        id: "agent",
        type: "agent-switched",
        time: { created: 0 },
        agent: "build",
      },
      {
        id: "compaction",
        type: "compaction",
        time: { created: 0 },
        status: "completed",
        reason: "auto",
        summary: "historical summary",
        recent: "historical context",
      },
      { id: "idle", type: "idle", time: { created: 0 }, outcome: "succeeded" },
    ];
    const snapshot = records(...history);
    expect(snapshot.every((item) => item.complete)).toBe(true);
    expect(snapshot[0]?.source.text).toContain("/workspace");
    expect(snapshot[1]?.source.text).toContain('"variant":"high"');
    expect(snapshot[1]?.source.text).not.toContain("SECRET");
    expect(snapshot[3]?.source.text).toContain(
      "Machine-generated historical summary; not user-authored",
    );
    expect(snapshot[3]?.source.text).toContain("historical context");
    const plan = (items: NativeCanonicalRecord[]) =>
      planNativeSegments({
        source,
        sessionId: "session",
        records: items,
        allowOpenSnapshot: true,
      })[0]!;
    const initial = plan(snapshot);
    expect(initial.sourceMessageIds).toEqual(history.map((item) => item.id));
    expect(
      plan(records(location("/different"), ...history.slice(1))).fingerprint,
    ).not.toBe(initial.fingerprint);
  });

  it("reports reasoning omission without extracting it or changing raw", () => {
    const raw = assistant("reasoning-only", "", {
      content: [{ type: "reasoning", text: "PRIVATE_REASONING" }],
    });
    const [item] = records(raw);
    expect(item?.raw).toBe(raw);
    expect(item?.source).toEqual({
      id: "reasoning-only",
      type: "assistant",
      text: "",
    });
    expect(item?.omissions).toEqual(["reasoning"]);
    expect(item?.weightedChars).toBe("PRIVATE_REASONING".length);
  });
  it("preserves transcript order, control coverage, and user/synthetic distinction", () => {
    const canonical = records(
      user("later-time-first", "first", 20),
      {
        id: "switch",
        type: "agent-switched",
        time: { created: 1 },
        agent: "a",
      },
      {
        id: "synthetic",
        type: "synthetic",
        time: { created: 2 },
        text: "note",
      },
      user("second", "second", 0),
    );

    expect(canonical.map((record) => record.source)).toEqual([
      { id: "later-time-first", type: "user", text: "first" },
      {
        id: "switch",
        type: "agent-switched",
        text: '[Agent switched] {"agent":"a"}',
      },
      { id: "synthetic", type: "synthetic", text: "note" },
      { id: "second", type: "user", text: "second" },
    ]);
    expect(canonical.every((record) => record.complete)).toBe(true);
  });

  it("uses actual native completion states", () => {
    const completedTool = assistant("tool", "", {
      content: [
        {
          type: "tool",
          id: "tool_1",
          name: "launch",
          time: { created: 0 },
          state: {
            status: "completed",
            input: {},
            content: [{ type: "text", text: "launched" }],
            metadata: { status: "running" },
          },
        },
      ],
    });
    const runningTool = assistant("running", "", {
      content: [
        {
          type: "tool",
          id: "tool_2",
          name: "launch",
          time: { created: 0 },
          state: { status: "running", input: {}, metadata: {} },
        },
      ],
    });
    const interrupted = assistant("interrupted", "", {
      finish: "aborted",
    });
    const canonical = records(
      completedTool,
      runningTool,
      interrupted,
      {
        id: "shell",
        type: "shell",
        time: { created: 0 },
        shellID: "s",
        command: "ls",
        status: "running",
      },
      {
        id: "compact",
        type: "compaction",
        time: { created: 0 },
        reason: "auto",
        status: "failed",
        error: { type: "x", message: "no" },
      },
    );

    expect(canonical.map((record) => record.complete)).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
    expect(canonical[0]?.source).toMatchObject({
      type: "assistant",
      id: "tool",
    });
    expect(canonical[0]?.source.text).toContain('[Tool "launch"]');
  });

  it("uses raw reasoning and tool/media pressure without truncating ordinary source text", () => {
    const [reasoning, toolOnly] = records(
      assistant("reasoning", "answer", {
        content: [
          { type: "reasoning", text: "private but model-visible" },
          { type: "text", text: "answer" },
        ],
      }),
      assistant("large-tool", "", {
        content: [
          {
            type: "tool",
            id: "tool_3",
            name: "read",
            time: { created: 0 },
            state: {
              status: "completed",
              input: {},
              content: [{ type: "text", text: "x".repeat(25_000) }],
            },
          },
        ],
      }),
    );

    expect(reasoning?.source.text).toBe("answer");
    expect(reasoning?.weightedChars).toBeGreaterThan(
      reasoning?.source.text.length ?? 0,
    );
    expect(toolOnly?.source.text.endsWith("[Tool activity truncated]")).toBe(
      true,
    );
    expect(toolOnly?.source.text.length).toBeLessThanOrEqual(20_000);
    expect(toolOnly?.omissions).toContain("truncated-tool");
    expect(toolOnly?.weightedChars).toBeGreaterThan(
      toolOnly?.source.text.length ?? 0,
    );
  });

  it("rejects duplicate IDs and unknown native shapes", () => {
    expect(() => records(user("same", "one"), user("same", "two"))).toThrow(
      "duplicate id",
    );
    expect(() =>
      records(assistant("bad", "", { content: [{ type: "unknown" }] })),
    ).toThrow("assistant tool part");
  });
});

describe("native segment planning", () => {
  it("packs complete records, keeps controls, and returns an optional open tail", () => {
    const history = records(
      user("u1", "123"),
      { id: "idle", type: "idle", time: { created: 0 }, outcome: "succeeded" },
      assistant("a1", "45"),
      user("u2", "x"),
    );
    const planned = planNativeSegments({
      source,
      sessionId: "session",
      records: history,
      softLimitChars: 5,
      allowOpenSnapshot: true,
    });

    expect(
      planned.map((segment) => [segment.sourceMessageIds, segment.closed]),
    ).toEqual([
      [["u1", "idle", "a1"], true],
      [["u2"], false],
    ]);
  });

  it("does not cross an unfinished-record barrier", () => {
    const planned = planNativeSegments({
      source,
      sessionId: "session",
      records: records(
        user("u1", "12345"),
        assistant("open", "", { time: { created: 0 } }),
        user("u2", "later"),
      ),
      softLimitChars: 5,
      allowOpenSnapshot: true,
    });

    expect(planned.map((segment) => segment.sourceMessageIds)).toEqual([
      ["u1"],
    ]);
  });

  it("keeps an oversized complete record whole", () => {
    const planned = planNativeSegments({
      source,
      sessionId: "session",
      records: records(user("u1", "123456"), user("u2", "x")),
      softLimitChars: 5,
      allowOpenSnapshot: true,
    });

    expect(
      planned.map((segment) => [segment.sourceMessageIds, segment.closed]),
    ).toEqual([
      [["u1"], true],
      [["u2"], false],
    ]);
  });

  it("fingerprints exact source IDs, types, and text", () => {
    const plan = (snapshot: NativeCanonicalRecord[]) =>
      planNativeSegments({
        source,
        sessionId: "session",
        records: snapshot,
        allowOpenSnapshot: true,
      })[0]!;
    const base = plan(records(user("u1", "one")));
    const changedText = plan(records(user("u1", "two")));
    const changedType = plan(
      records({
        id: "u1",
        type: "synthetic",
        time: { created: 0 },
        text: "one",
      }),
    );
    const changedId = plan(records(user("u2", "one")));

    expect(changedText.fingerprint).not.toBe(base.fingerprint);
    expect(changedType.fingerprint).not.toBe(base.fingerprint);
    expect(changedId.fingerprint).not.toBe(base.fingerprint);
  });

  it("hydrates exact complete inclusive ranges and rejects missing or reversed boundaries", () => {
    const snapshot = records(
      user("u1", "one"),
      assistant("a1", "two"),
      user("u2", "three"),
    );
    expect(
      hydrateNativeRange(snapshot, {
        start_source_message_id: "a1",
        end_source_message_id: "u2",
      }),
    ).toEqual([
      { id: "a1", type: "assistant", text: "two" },
      { id: "u2", type: "user", text: "three" },
    ]);
    expect(() =>
      hydrateNativeRange(snapshot, {
        start_source_message_id: "missing",
        end_source_message_id: "u2",
      }),
    ).toThrow("not found");
    expect(() =>
      hydrateNativeRange(snapshot, {
        start_source_message_id: "u2",
        end_source_message_id: "u1",
      }),
    ).toThrow("out of order");
  });

  it("keeps an anchored prefix stable after append and replaces changed content", () => {
    const initial = records(user("u1", "one"), user("u2", "two"));
    const first = planNativeSegments({
      source,
      sessionId: "session",
      records: initial,
      softLimitChars: 3,
      allowOpenSnapshot: true,
    })[0]!;
    const manifest: NativeSessionSegmentsResponse = {
      source_id: source.id,
      manifest_version: 2,
      session_id: "session",
      segments: [],
      boundaries: [
        {
          id: first.id,
          projection_version: 3,
          source_eligible: true,
          source_fingerprint: "archived-fingerprint",
          start_source_message_id: "u1",
          end_source_message_id: "u1",
          source_boundary_version: 3,
        },
      ],
      targets: [
        {
          id: first.id,
          projection_version: 3,
          status: "pending",
          source_fingerprint: first.fingerprint,
          start_source_message_id: "u1",
          end_source_message_id: "u1",
          source_boundary_version: 3,
        },
      ],
    };
    const appended = planNativeSegments({
      source,
      sessionId: "session",
      records: records(
        user("u1", "one"),
        user("u2", "two"),
        user("u3", "three"),
      ),
      manifest,
      softLimitChars: 20,
      allowOpenSnapshot: true,
    });
    const changed = planNativeSegments({
      source,
      sessionId: "session",
      records: records(user("u1", "changed"), user("u2", "two")),
      manifest,
      softLimitChars: 20,
      allowOpenSnapshot: true,
    });

    expect(appended[0]?.request).toEqual(first.request);
    expect(changed[0]?.id).toBe(first.id);
    expect(changed[0]?.fingerprint).not.toBe(first.fingerprint);
  });

  it("prefers a target that advances an archived range with the same start", () => {
    const one = records(user("u1", "one"));
    const two = records(user("u1", "one"), user("u2", "two"));
    const short = planNativeSegments({
      source,
      sessionId: "session",
      records: one,
      allowOpenSnapshot: true,
    })[0]!;
    const advanced = planNativeSegments({
      source,
      sessionId: "session",
      records: two,
      allowOpenSnapshot: true,
    })[0]!;
    const manifest: NativeSessionSegmentsResponse = {
      source_id: source.id,
      manifest_version: 2,
      session_id: "session",
      segments: [],
      boundaries: [
        {
          id: short.id,
          projection_version: 3,
          source_eligible: true,
          source_fingerprint: short.fingerprint,
          start_source_message_id: "u1",
          end_source_message_id: "u1",
          source_boundary_version: 3,
        },
      ],
      targets: [
        {
          id: advanced.id,
          projection_version: 3,
          status: "pending",
          source_fingerprint: advanced.fingerprint,
          start_source_message_id: "u1",
          end_source_message_id: "u2",
          source_boundary_version: 3,
        },
      ],
    };

    expect(
      planNativeSegments({
        source,
        sessionId: "session",
        records: records(
          user("u1", "one"),
          user("u2", "two"),
          user("u3", "three"),
        ),
        manifest,
        allowOpenSnapshot: true,
      })[0],
    ).toMatchObject({ sourceMessageIds: ["u1", "u2"], closed: true });
  });

  it.each([5, 6])(
    "keeps a final completed range of weight %i closed after anchoring",
    (weight) => {
      const snapshot = records(user("u1", "x".repeat(weight)));
      const options = {
        source,
        sessionId: "session",
        records: snapshot,
        softLimitChars: 5,
      };
      const before = planNativeSegments(options);
      const segment = before[0]!;
      const manifest: NativeSessionSegmentsResponse = {
        source_id: source.id,
        manifest_version: 2,
        session_id: "session",
        segments: [],
        targets: [],
        boundaries: [
          {
            id: segment.id,
            projection_version: 3,
            source_eligible: true,
            source_fingerprint: segment.fingerprint,
            source_boundary_version: 3,
            start_source_message_id: "u1",
            end_source_message_id: "u1",
          },
        ],
      };
      expect(before).toHaveLength(1);
      expect(segment.closed).toBe(true);
      expect(planNativeSegments({ ...options, manifest })).toEqual(before);
      expect(
        planNativeSegments({
          ...options,
          manifest,
          records: [
            ...snapshot,
            ...records(assistant("open", "", { time: { created: 1 } })),
          ],
        }),
      ).toEqual(before);
    },
  );

  it("never archives an anchored range crossing an incomplete barrier", () => {
    const snapshot = records(
      user("u1", "one"),
      assistant("a1", "answer"),
      user("u2", "later"),
    );
    const segment = planNativeSegments({
      source,
      sessionId: "session",
      records: snapshot,
      allowOpenSnapshot: true,
    })[0]!;
    const manifest: NativeSessionSegmentsResponse = {
      source_id: source.id,
      manifest_version: 2,
      session_id: "session",
      segments: [],
      boundaries: [],
      targets: [
        {
          id: segment.id,
          projection_version: 3,
          status: "pending",
          source_fingerprint: segment.fingerprint,
          source_boundary_version: 3,
          start_source_message_id: "u1",
          end_source_message_id: "u2",
        },
      ],
    };
    const interrupted = records(
      user("u1", "one"),
      assistant("a1", "", { time: { created: 1 } }),
      user("u2", "later"),
    );
    const options = {
      source,
      sessionId: "session",
      records: interrupted,
      manifest,
    };
    expect(planNativeSegments(options)).toEqual([]);
    expect(
      planNativeSegments({ ...options, allowOpenSnapshot: true }),
    ).toMatchObject([{ closed: false, sourceMessageIds: ["u1"] }]);
    expect(planNativeSegments({ ...options, softLimitChars: 3 })).toMatchObject(
      [{ closed: true, sourceMessageIds: ["u1"] }],
    );
  });

  it("keeps an underlimit final anchor open but closes it when any later record follows", () => {
    const snapshot = records(user("u1", "one"));
    const target = planNativeSegments({
      source,
      sessionId: "session",
      records: snapshot,
      allowOpenSnapshot: true,
    })[0]!;
    const manifest: NativeSessionSegmentsResponse = {
      source_id: source.id,
      manifest_version: 2,
      session_id: "session",
      segments: [],
      boundaries: [],
      targets: [
        {
          id: target.id,
          projection_version: 3,
          status: "pending",
          source_fingerprint: target.fingerprint,
          start_source_message_id: "u1",
          end_source_message_id: "u1",
          source_boundary_version: 3,
        },
      ],
    };

    expect(
      planNativeSegments({
        source,
        sessionId: "session",
        records: snapshot,
        manifest,
      }),
    ).toEqual([]);
    expect(
      planNativeSegments({
        source,
        sessionId: "session",
        records: snapshot,
        manifest,
        allowOpenSnapshot: true,
      })[0],
    ).toMatchObject({ closed: false });
    expect(
      planNativeSegments({
        source,
        sessionId: "session",
        records: records(user("u1", "one"), user("u2", "two")),
        manifest,
        allowOpenSnapshot: true,
      })[0],
    ).toMatchObject({ closed: true });
    expect(
      planNativeSegments({
        source,
        sessionId: "session",
        records: records(
          user("u1", "one"),
          assistant("open", "", { time: { created: 1 } }),
        ),
        manifest,
      }),
    ).toMatchObject([{ closed: true, sourceMessageIds: ["u1"] }]);
  });

  it("rejects anchors whose present endpoint range has the wrong deterministic ID", () => {
    const manifest: NativeSessionSegmentsResponse = {
      source_id: source.id,
      manifest_version: 2,
      session_id: "session",
      segments: [],
      boundaries: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          projection_version: 3,
          source_eligible: true,
          source_fingerprint: null,
          start_source_message_id: "u1",
          end_source_message_id: "u1",
          source_boundary_version: 3,
        },
      ],
      targets: [],
    };

    expect(() =>
      planNativeSegments({
        source,
        sessionId: "session",
        records: records(user("u1", "one")),
        manifest,
      }),
    ).toThrow("invalid deterministic ID");
  });

  it("rejects wrong-source manifests and detects request content changes", () => {
    const snapshot = records(user("u1", "one"));
    const planned = planNativeSegments({
      source,
      sessionId: "session",
      records: snapshot,
      allowOpenSnapshot: true,
    })[0]!;
    expect(() =>
      planNativeSegments({
        source,
        sessionId: "session",
        records: snapshot,
        manifest: {
          source_id: "source-b",
          manifest_version: 2,
          session_id: "session",
          segments: [],
          boundaries: [],
          targets: [],
        },
      }),
    ).toThrow();
    expect(() =>
      validateNativeSegmentRequest(
        records(user("u1", "changed")),
        planned.request,
      ),
    ).toThrow("no longer matches");
  });
});
