import { MAX_MESSAGE_TEXT_CHARS } from "@reflection/shared/contracts";
import { describe, expect, test } from "vitest";

import {
  cooperativeCopiedSourceTokenSpans,
  cooperativeIdentifierBangTokenSpans,
  copiedSourceTokens,
  copiedSourceTokenSpans,
  identifierBangTokenSpans,
} from "../src/identifier-lexing.js";
import { CooperativeScheduler } from "../src/identifier-validation-scheduler.js";

describe("identifier lexing", () => {
  test("finds only unambiguous identifier shapes", () => {
    const uuid = "12345678-1234-4123-8123-123456789abc";
    const fullHash = "a1".repeat(32);
    expect(copiedSourceTokens("effaced 1000000 deadbee1")).toEqual(
      new Set(["deadbee1"]),
    );
    const expected = new Set([
      "tool_example123",
      uuid,
      "cf087d72c6",
      fullHash,
      "#14190",
      "user.did_double_credits",
      "max_completion_tokens",
      "/v2/credit_summary",
      "timeline.svg",
      "X-Request-ID",
    ]);
    const actual = copiedSourceTokens([...expected].join(" "));
    for (const value of expected) expect(actual).toContain(value);
    for (const value of [
      "@scope/pkg",
      "foo@1.2.3",
      "--feature-flag",
      "gh:org/repo",
      "ses_secret123",
      "user_id",
      "isAdmin",
      "fake-package",
      "Fake-package",
      "dir/fabricated",
      "Dir/file.ts",
      "Dir／file.ts",
      "../dir/fabricated",
      String.raw`C:\fabricated\secret`,
      "CVE-2026-1234",
      "README",
      "#4242é",
      "#4242\u0301",
      "alpha．beta",
      "https://evil.example/foo",
      "file:///fabricated/path",
      "ftp://127.0.0.1/Fabricated",
    ]) {
      expect(copiedSourceTokens(value)).toContain(value);
    }
  });

  test.each([
    "@scope/pkg",
    "foo@1.2.3",
    "--feature-flag",
    "gh:org/repo",
    "1.2.3",
    "127.0.0.1",
    "ModelClient",
    "release-1.2.3",
    "artifact-1.2.3.tar.gz",
    "127.0.0.1:5432",
    "HTTP2Server",
    "C++",
    ".NET",
    "v2",
    "x86",
    "S3",
    "$x",
    "@x",
    "_x",
    "#1",
    "C#",
  ])("keeps %s as one maximal identifier", (identifier) => {
    expect(copiedSourceTokens(identifier)).toEqual(new Set([identifier]));
  });

  test.each([
    ["https://example.com/api'good", "https://example.com/api"],
    [String.raw`C:\foo\bar'good`, String.raw`C:\foo\bar`],
  ])("trims an unquoted narrative suffix from %s", (source, identifier) => {
    expect(copiedSourceTokens(source)).toEqual(new Set([identifier]));
  });

  test.each([
    ["'https://example.com/api'good'", "https://example.com/api'good"],
    [String.raw`'C:\foo\bar'good'`, String.raw`C:\foo\bar'good`],
  ])(
    "preserves explicitly quoted identifier punctuation in %s",
    (source, identifier) => {
      expect(copiedSourceTokens(source)).toEqual(new Set([identifier]));
    },
  );

  test("keeps a contextually explicit bang macro as one identifier", () => {
    expect(copiedSourceTokens("`println!`")).toEqual(new Set(["println!"]));
  });

  test("yields before contract-sized source indexing finishes", async () => {
    let indexingFinished = false;
    let heartbeatBeforeCompletion = false;
    const heartbeat = setImmediate(() => {
      heartbeatBeforeCompletion = !indexingFinished;
    });

    try {
      await cooperativeCopiedSourceTokenSpans(
        "a".repeat(MAX_MESSAGE_TEXT_CHARS),
        new CooperativeScheduler(),
      );
      indexingFinished = true;
    } finally {
      clearImmediate(heartbeat);
    }
    expect(heartbeatBeforeCompletion).toBe(true);
  }, 2_000);

  test("keeps cooperative source indexing lexically identical", async () => {
    const source = [
      "`println!`",
      "format !()",
      "macro_name!",
      "https://example.com/api.)",
      String.raw`C:\Temp\File`,
      "@scope/pkg",
      "--feature-flag",
      "ModelClient",
      "74cff22",
    ].join(" ");
    const scheduler = new CooperativeScheduler();

    await expect(
      cooperativeCopiedSourceTokenSpans(source, scheduler),
    ).resolves.toEqual(copiedSourceTokenSpans(source));
    await expect(
      cooperativeIdentifierBangTokenSpans(source, scheduler),
    ).resolves.toEqual(identifierBangTokenSpans(source));
  });
});
