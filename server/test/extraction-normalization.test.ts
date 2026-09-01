import { type ExtractionResult } from "@reflection/shared/contracts";
import { modelVisibleToolState } from "@reflection/shared/tool-source";
import { describe, expect, test } from "vitest";

import { normalizeExtractedPaths } from "../src/extraction-normalization.js";

describe("normalizeExtractedPaths", () => {
  test("replaces absolute path in summary and claims with basename when backticked in source", () => {
    const input: ExtractionResult = {
      summary: "Updated /var/folders/project/src/config.ts with new settings.",
      claims: [
        {
          subject: "/workspace/packages/server/app.ts",
          predicate: "imports from",
          confidence: 0.9,
          object_entity: "/workspace/packages/server/routes.ts",
          object_value: null,
        },
        {
          subject: "server",
          predicate: "reads configuration from",
          confidence: 0.85,
          object_entity: null,
          object_value: "/etc/reflection/settings.json",
        },
      ],
    };

    const messages = [
      { role: "user", text: "In `config.ts`, update the defaults." },
      {
        role: "assistant",
        text: "See `app.ts` and `routes.ts` for handler logic.",
      },
      { role: "user", text: "Settings file is `settings.json`." },
    ];

    const normalized = normalizeExtractedPaths(input, messages);

    expect(normalized.normalizedPaths).toBe(4);
    expect(normalized.result).toEqual({
      summary: "Updated config.ts with new settings.",
      claims: [
        {
          subject: "app.ts",
          predicate: "imports from",
          confidence: 0.9,
          object_entity: "routes.ts",
          object_value: null,
        },
        {
          subject: "server",
          predicate: "reads configuration from",
          confidence: 0.85,
          object_entity: null,
          object_value: "settings.json",
        },
      ],
    });
  });

  test("preserves exact full path when full path occurs in source", () => {
    const input: ExtractionResult = {
      summary: "Updated /workspace/packages/server/app.ts with new routes.",
      claims: [
        {
          subject: "/workspace/packages/server/app.ts",
          predicate: "configures",
          confidence: 0.9,
          object_entity: null,
          object_value: "port 8080",
        },
      ],
    };

    const messages = [
      {
        role: "user",
        text: "File `/workspace/packages/server/app.ts` was edited alongside `app.ts`.",
      },
    ];

    const normalized = normalizeExtractedPaths(input, messages);

    expect(normalized.normalizedPaths).toBe(0);
    expect(normalized.result).toEqual(input);
  });

  test("does not preserve candidate /workspace/app.ts when source contains only /workspace/app.tsx", () => {
    const input: ExtractionResult = {
      summary: "Found /workspace/app.ts in the project.",
      claims: [],
    };

    const messages = [
      {
        role: "user",
        text: "Inspected /workspace/app.tsx; file is `app.ts`.",
      },
    ];

    const normalized = normalizeExtractedPaths(input, messages);

    expect(normalized.normalizedPaths).toBe(1);
    expect(normalized.result).toEqual({
      summary: "Found app.ts in the project.",
      claims: [],
    });
  });

  test("preserves unsupported path when basename does not occur backticked in source", () => {
    const input: ExtractionResult = {
      summary: "Found /var/log/syslog.log.",
      claims: [
        {
          subject: "service",
          predicate: "writes to",
          confidence: 0.9,
          object_entity: null,
          object_value: "/var/log/syslog.log",
        },
      ],
    };

    const messages = [
      {
        role: "user",
        text: "The service logs everything to syslog.log (not backticked).",
      },
    ];

    const normalized = normalizeExtractedPaths(input, messages);

    expect(normalized.normalizedPaths).toBe(0);
    expect(normalized.result).toEqual(input);
  });

  test("does not match protocol-relative URIs as absolute paths", () => {
    const input: ExtractionResult = {
      summary: "Connects to //example.com/api endpoint.",
      claims: [
        {
          subject: "client",
          predicate: "calls",
          confidence: 0.9,
          object_entity: null,
          object_value: "//cdn.example.com/assets/logo.png",
        },
      ],
    };

    const messages = [
      {
        role: "user",
        text: "Connect to `api` via //example.com/api and fetch `logo.png`.",
      },
    ];

    const normalized = normalizeExtractedPaths(input, messages);

    expect(normalized.normalizedPaths).toBe(0);
    expect(normalized.result).toEqual(input);
  });

  test("does not match URLs with protocols as absolute paths", () => {
    const input: ExtractionResult = {
      summary: "See https://example.com/api/docs for API reference.",
      claims: [],
    };

    const messages = [
      { role: "user", text: "Check `docs` on https://example.com/api/docs." },
    ];

    const normalized = normalizeExtractedPaths(input, messages);

    expect(normalized.normalizedPaths).toBe(0);
    expect(normalized.result).toEqual(input);
  });

  test("canonical bounded assistant tool frame authorizes normalization", () => {
    const input: ExtractionResult = {
      summary: "Used /var/folders/service.ts successfully.",
      claims: [
        {
          subject: "/workspace/config.json",
          predicate: "loaded",
          confidence: 0.9,
          object_entity: null,
          object_value: "true",
        },
      ],
    };

    const state = modelVisibleToolState({
      files: ["`service.ts`"],
      config: { path: "`config.json`" },
    });
    const toolText = `\n[Tool "read"]\n${JSON.stringify(state)}\n[/Tool]\n`;
    const messages = [{ role: "assistant", text: toolText }];

    const normalized = normalizeExtractedPaths(input, messages);

    expect(normalized.normalizedPaths).toBe(2);
    expect(normalized.result).toEqual({
      summary: "Used service.ts successfully.",
      claims: [
        {
          subject: "config.json",
          predicate: "loaded",
          confidence: 0.9,
          object_entity: null,
          object_value: "true",
        },
      ],
    });
  });

  test("incomplete or noncanonical assistant tool frames cannot authorize normalization", () => {
    const input: ExtractionResult = {
      summary: "Found /workspace/file.ts in unclosed tool output.",
      claims: [],
    };

    const unclosed = `Feature records a path.\n[Tool "bash"]\n{"output":"\`file.ts\`"`;
    const noncanonical = `\n[Tool "bash"]\n{invalid json \`file.ts\`}\n[/Tool]\n`;

    const normalizedUnclosed = normalizeExtractedPaths(input, [
      { role: "assistant", text: unclosed },
    ]);
    expect(normalizedUnclosed.normalizedPaths).toBe(0);
    expect(normalizedUnclosed.result).toEqual(input);

    const normalizedNoncanonical = normalizeExtractedPaths(input, [
      { role: "assistant", text: noncanonical },
    ]);
    expect(normalizedNoncanonical.normalizedPaths).toBe(0);
    expect(normalizedNoncanonical.result).toEqual(input);
  });

  test("canonical tool blocks beyond the aggregate budget cannot authorize normalization", () => {
    const input: ExtractionResult = {
      summary: "Found /fabricated/blocked.ts.",
      claims: [],
    };

    const first = JSON.stringify({ output: "x".repeat(15_000) });
    const second = JSON.stringify({
      output: `${"y".repeat(6_000)} \`blocked.ts\``,
    });
    const source = `\n[Tool "read"]\n${first}\n[/Tool]\n\n[Tool "read"]\n${second}\n[/Tool]\n`;

    const normalized = normalizeExtractedPaths(input, [
      { role: "assistant", text: source },
    ]);

    expect(normalized.normalizedPaths).toBe(0);
    expect(normalized.result).toEqual(input);
  });

  test("scans parsed tool strings without trusting JSON escape syntax", () => {
    const input: ExtractionResult = {
      summary: "Used /etc/app/config.json in the build.",
      claims: [],
    };

    // Tool state has parsed string containing backticked filename
    const state = modelVisibleToolState({
      output: "loaded `config.json`",
    });
    const source = `\n[Tool "read"]\n${JSON.stringify(state)}\n[/Tool]\n`;

    const normalized = normalizeExtractedPaths(input, [
      { role: "assistant", text: source },
    ]);

    expect(normalized.normalizedPaths).toBe(1);
    expect(normalized.result).toEqual({
      summary: "Used config.json in the build.",
      claims: [],
    });
  });
});
