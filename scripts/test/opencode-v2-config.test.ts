import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import { Config } from "@opencode/schema/config";
import { Schema } from "effect";
import { parseUserPolicy } from "../../packages/opencode-v2-plugin/src/user-policy.js";
import {
  convertV1ToNative208,
  type ConversionContext,
  type ConversionResult,
} from "../src/opencode-v2-config.js";

const SECRET = "synthetic-SECRET-do-not-emit";
const context: ConversionContext = {
  sourceVersion: "1.18.29",
  root: "/isolated/v2",
  sourceRoot: "/legacy/v1",
  runtime: {
    reflectionConfigPath: "/isolated/v2/reflection.json",
    nativeConfigPath: "/isolated/v2/opencode.json",
    userPolicyPath: "/isolated/v2/policy.json",
    dataPath: "/isolated/v2/data",
    statePath: "/isolated/v2/state",
    cachePath: "/isolated/v2/cache",
    v2Port: 4096,
    v1Port: 4097,
    v2Hostname: "127.0.0.1",
  },
  reflectionNativeCompactionVeto: true,
  agentsDiscoveryHandled: true,
  publicStrings: [
    "openai",
    "openrouter",
    "gpt-5.6-terra-fast",
    "google/gemini-3.8-flash",
    "openai/gpt-5.6-terra-fast",
    "openrouter/google/gemini-3.8-flash",
    "high",
    "fast-coder",
    "question",
    "bash",
    "shell",
    "task",
    "subagent",
    "write",
    "patch",
    "edit",
    "todowrite",
    "*",
    "git *",
    "Notion",
    "figma",
    "disabled",
    "Authorization",
    "API_KEY",
    "PUBLIC_ENV",
    "apiKey",
    "baseURL",
    "headers",
    "body",
    "reasoningEffort",
    "temperature",
    "top_p",
    "topP",
    "provider",
    "order",
    "allow_fallbacks",
    "Google",
    "Vertex",
    "nested",
    "token",
    "array",
    "value",
    "/legacy/v1/AGENTS.md",
    "/legacy/v1/MEMORY.md",
    "/legacy/v1/USER.md",
  ],
  executableMappings: { pnx: "/public/bin/pnx", node: "/public/bin/node" },
  instructionMappings: {
    "/legacy/v1/AGENTS.md": {
      destination: "/legacy/v1/AGENTS.md",
      mode: "read-only-reference",
    },
    "/legacy/v1/MEMORY.md": {
      destination: "/legacy/v1/MEMORY.md",
      mode: "read-only-reference",
    },
    "/legacy/v1/USER.md": {
      destination: "/legacy/v1/USER.md",
      mode: "read-only-reference",
    },
  },
  nativeReplacement: {
    identifiers: ["reflection.js", "gemini-tool-guard.js"],
    directory: "/isolated/v2/plugins/reflection",
  },
  skills: {
    inventoryKnown: true,
    entries: [
      {
        source: "/legacy/v1/skills/big-diff-replay",
        destination: "/legacy/v1/skills/big-diff-replay",
        mode: "read-only-reference",
      },
    ],
  },
  authUnavailableProviders: ["openai"],
};

function fixture() {
  return {
    $schema: "https://synthetic.invalid/v1-schema.json",
    model: "openrouter/google/gemini-3.8-flash",
    default_agent: "fast-coder",
    username: SECRET,
    snapshot: false,
    autoupdate: false,
    share: "disabled",
    server: { port: 4096, hostname: "0.0.0.0" },
    command: {},
    mode: {},
    instructions: [
      "/legacy/v1/AGENTS.md",
      "/legacy/v1/MEMORY.md",
      "/legacy/v1/USER.md",
    ],
    plugin: ["reflection.js", "gemini-tool-guard.js"],
    permission: { todowrite: "deny", "*": "allow", bash: { "git *": "ask" } },
    compaction: { auto: false, preserve_recent_tokens: 12000, tail_turns: 4 },
    provider: {
      openai: {
        whitelist: ["gpt-5.6-terra-fast"],
        options: { apiKey: SECRET },
      },
      openrouter: {
        whitelist: ["google/gemini-3.8-flash"],
        options: {
          headers: { Authorization: SECRET },
          body: { reasoningEffort: "high" },
          baseURL: `https://private.invalid/${SECRET}?key=${SECRET}`,
        },
        models: {
          "google/gemini-3.8-flash": {
            options: {
              provider: { order: ["Vertex", "Google"], allow_fallbacks: false },
            },
            limit: { context: 100000, output: 4000 },
          },
        },
      },
    },
    agent: {
      "fast-coder": {
        name: "fast-coder",
        model: "openai/gpt-5.6-terra-fast",
        variant: "high",
        mode: "subagent",
        prompt: SECRET,
        description: SECRET,
        permission: { question: "deny" },
        options: { temperature: 0.2, top_p: 0.3, reasoningEffort: "high" },
        temperature: 0.8,
        top_p: 0.9,
      },
    },
    mcp: {
      Notion: {
        type: "remote",
        enabled: true,
        url: `https://user:${SECRET}@synthetic.invalid/mcp?key=${SECRET}`,
        headers: { Authorization: SECRET },
        oauth: {
          clientId: SECRET,
          clientSecret: SECRET,
          scope: SECRET,
          redirectUri: `http://localhost/${SECRET}`,
          callbackPort: 3456,
        },
      },
      figma: {
        type: "local",
        enabled: true,
        command: ["pnx", "-y", `--api-key=${SECRET}`],
        environment: { API_KEY: SECRET, PUBLIC_ENV: "also-private-by-default" },
      },
      disabled: {
        type: "remote",
        enabled: false,
        url: "https://synthetic.invalid/mcp",
        oauth: false,
        timeout: 90000,
      },
    },
  };
}

function codes(result: ConversionResult): string[] {
  return result.diagnostics.map((d) => d.code);
}
function convert(input: unknown, overrides: Partial<ConversionContext> = {}) {
  return convertV1ToNative208(input, { ...context, ...overrides });
}

// Only test code reconstructs private bindings. No renderer or retained private values ship.
function bindings(
  input: unknown,
  result: ConversionResult,
): Record<string, unknown> {
  return Object.fromEntries(
    result.secretSlots.map((slot) => {
      let value = input;
      for (const ordinal of slot.sourcePath) {
        if (value === null || typeof value !== "object")
          throw new Error("Invalid fixture pointer");
        value = Object.values(value)[ordinal];
      }
      return [slot.placeholder, value];
    }),
  );
}

describe("pure v1.18.29 to native 2.0.8 planning conversion", () => {
  describe("actual user-policy parser agreement", () => {
    it.each([32, 33])(
      "validates %i mapped instruction files with the plugin parser",
      (count) => {
        const instructions = Array.from(
          { length: count },
          (_, i) => `/legacy/v1/instruction-${i}.md`,
        );
        const result = convert(
          { instructions },
          {
            publicStrings: [...context.publicStrings, ...instructions],
            instructionMappings: Object.fromEntries(
              instructions.map((source) => [
                source,
                { destination: source, mode: "read-only-reference" as const },
              ]),
            ),
          },
        );
        expect(result.nativeSchemaValid).toBe(true);
        expect(result.userPolicyValid).toBe(count === 32);
        expect(result.conversionComplete).toBe(count === 32);
        if (count === 32)
          expect(() => parseUserPolicy(result.userPolicy)).not.toThrow();
        else {
          expect(() => parseUserPolicy(result.userPolicy)).toThrow();
          expect(result.diagnostics).toContainEqual({
            code: "USER_POLICY_INVALID",
            fieldPath: [],
            blocking: true,
          });
          expect(
            result.ledger.every((entry) => entry.disposition === "blocked"),
          ).toBe(true);
        }
      },
    );

    it.each(["", "   ", "model\0private", "m".repeat(500), "m".repeat(501)])(
      "agrees on model ID boundaries without exposing parser errors",
      (model) => {
        const result = convert(
          { provider: { openai: { whitelist: [model] } } },
          { publicStrings: [...context.publicStrings, model] },
        );
        const valid = model.length === 500;
        expect(result.conversionComplete).toBe(valid);
        if (model.includes("\0")) {
          expect(codes(result)).toContain("PUBLIC_DECLARATION_REQUIRED");
          expect(result.userPolicy.modelAllowlists.openai).toEqual([]);
        } else {
          expect(result.userPolicyValid).toBe(valid);
          if (valid)
            expect(() => parseUserPolicy(result.userPolicy)).not.toThrow();
          else {
            expect(() => parseUserPolicy(result.userPolicy)).toThrow();
            expect(codes(result)).toContain("USER_POLICY_INVALID");
          }
        }
        expect(JSON.stringify(result.diagnostics)).not.toContain(
          "Invalid user policy",
        );
      },
    );

    it.each(["", "   ", "provider\0private", "p".repeat(200), "p".repeat(201)])(
      "uses the actual provider-name constraints (%s)",
      (provider) => {
        const result = convert(
          { provider: { [provider]: { whitelist: [] } } },
          { publicStrings: [...context.publicStrings, provider] },
        );
        // Unreviewed providers remain blocked independently of the policy schema.
        expect(result.conversionComplete).toBe(false);
        if (!provider.includes("\0")) {
          expect(result.userPolicyValid).toBe(provider.length === 200);
          if (result.userPolicyValid)
            expect(() => parseUserPolicy(result.userPolicy)).not.toThrow();
          else expect(codes(result)).toContain("USER_POLICY_INVALID");
        }
      },
    );

    it.each([256, 257])(
      "checks %i allowlist providers with the actual parser",
      (count) => {
        const ids = Array.from({ length: count }, (_, i) => `synthetic-${i}`);
        const result = convert(
          {
            provider: Object.fromEntries(
              ids.map((id) => [id, { whitelist: [] }]),
            ),
          },
          { publicStrings: [...context.publicStrings, ...ids] },
        );
        expect(result.userPolicyValid).toBe(count === 256);
        expect(result.conversionComplete).toBe(false);
        if (count === 257)
          expect(codes(result)).toContain("USER_POLICY_INVALID");
        else expect(() => parseUserPolicy(result.userPolicy)).not.toThrow();
      },
    );

    it.each([10000, 10001])(
      "checks %i models per provider using the actual parser",
      (count) => {
        const result = convert({
          provider: {
            openai: {
              whitelist: Array.from(
                { length: count },
                () => "gpt-5.6-terra-fast",
              ),
            },
          },
        });
        expect(result.userPolicyValid).toBe(count === 10000);
        expect(result.conversionComplete).toBe(count === 10000);
        if (count === 10001)
          expect(codes(result)).toContain("USER_POLICY_INVALID");
        else expect(() => parseUserPolicy(result.userPolicy)).not.toThrow();
      },
    );

    it("keeps the parser's total model limit and the converter's earlier JSON-size guard fail-closed", () => {
      const policy = convert({}).userPolicy;
      const models = Array.from({ length: 10000 }, () => "gpt-5.6-terra-fast");
      const modelAllowlists = { openai: models, openrouter: models };
      expect(() =>
        parseUserPolicy({ ...policy, modelAllowlists }),
      ).not.toThrow();
      expect(() =>
        parseUserPolicy({
          ...policy,
          modelAllowlists: { ...modelAllowlists, synthetic: ["extra"] },
        }),
      ).toThrow();
      for (const allowlists of [
        modelAllowlists,
        { ...modelAllowlists, synthetic: ["extra"] },
      ]) {
        const result = convert({
          provider: Object.fromEntries(
            Object.entries(allowlists).map(([id, whitelist]) => [
              id,
              { whitelist },
            ]),
          ),
        });
        expect(result.conversionComplete).toBe(false);
        expect(result.userPolicyValid).toBe(false);
        expect(codes(result)).toContain("INVALID_JSON_INPUT");
      }
    });

    it("does not let relative instruction paths reach a completed conversion", () => {
      const result = convert(
        { instructions: ["relative.md"] },
        {
          publicStrings: [...context.publicStrings, "relative.md"],
          instructionMappings: {
            "relative.md": {
              destination: "relative.md",
              mode: "read-only-reference",
            },
          },
        },
      );
      expect(result.conversionComplete).toBe(false);
      expect(codes(result)).toContain("INSTRUCTION_MAPPING_REQUIRED");
      expect(() =>
        parseUserPolicy({
          ...result.userPolicy,
          instructionFiles: ["relative.md"],
        }),
      ).toThrow();
    });

    it("still completes the synthetic two-file/eleven-model shape", () => {
      const models = Array.from(
        { length: 11 },
        (_, i) => `synthetic/model-${i}`,
      );
      const result = convert(
        {
          instructions: ["/legacy/v1/MEMORY.md", "/legacy/v1/USER.md"],
          provider: { openrouter: { whitelist: models } },
        },
        { publicStrings: [...context.publicStrings, ...models] },
      );
      expect(result.conversionComplete).toBe(true);
      expect(result.userPolicyValid).toBe(true);
      expect(parseUserPolicy(result.userPolicy)).toEqual(result.userPolicy);
    });
  });

  it("converts synthetic current metadata with the real strict pinned decoder", () => {
    const input = fixture();
    const before = JSON.stringify(input);
    const result = convert(input);
    expect(result.diagnostics.filter((d) => d.blocking)).toEqual([]);
    expect(result.conversionComplete).toBe(true);
    expect(result.activationReady).toBe(false);
    expect(result.nativeSchemaValid).toBe(true);
    expect(() =>
      Schema.decodeUnknownSync(Config.Info, { onExcessProperty: "error" })(
        result.draftNativeConfig,
      ),
    ).not.toThrow();
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("also-private-by-default");
    expect(
      result.ledger.every((entry) => entry.disposition !== "blocked"),
    ).toBe(true);
    expect(result.runtime).toEqual(context.runtime);
    expect(result.draftNativeConfig).toMatchObject({
      compaction: { auto: false, keep: { tokens: 12000 } },
      model: { providerID: "openrouter", model: "google/gemini-3.8-flash" },
      agents: {
        "fast-coder": {
          model: {
            providerID: "openai",
            model: "gpt-5.6-terra-fast",
            variant: "high",
          },
          request: {
            body: { temperature: 0.8, top_p: 0.9, reasoningEffort: "high" },
          },
        },
      },
      providers: {
        openrouter: {
          models: {
            "google/gemini-3.8-flash": {
              settings: {
                provider: {
                  order: ["Vertex", "Google"],
                  allow_fallbacks: false,
                },
              },
            },
          },
        },
      },
    });
    expect(result.draftNativeConfig.agents).not.toHaveProperty(
      "fast-coder.disabled",
    );
    expect(result.draftNativeConfig.providers).not.toHaveProperty(
      "openai.package",
    );
    expect(result.draftNativeConfig.providers).not.toHaveProperty(
      "openrouter.package",
    );
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "PROVIDER_AUTH_PENDING",
        "MCP_OAUTH_AUTH_PENDING",
        "UNMATCHED_LEGACY_ACTION",
        "INACTIVE_NOT_NATIVE_EQUIVALENT",
      ]),
    );
  });

  it("preserves ordered last-match permissions and agent overrides, not specificity", () => {
    const result = convert(fixture());
    expect(result.draftNativeConfig.permissions).toEqual([
      { action: "todowrite", resource: "*", effect: "deny" },
      { action: "*", resource: "*", effect: "allow" },
      { action: "shell", resource: "git *", effect: "ask" },
    ]);
    expect(result.draftNativeConfig.agents).toMatchObject({
      "fast-coder": {
        permissions: [{ action: "question", resource: "*", effect: "deny" }],
      },
    });
  });

  it("preserves enabled Notion OAuth definition without grants and maps every private binding", () => {
    const input = fixture();
    const result = convert(input);
    const values = bindings(input, result);
    expect(result.draftNativeConfig.mcp).toMatchObject({
      servers: {
        Notion: {
          type: "remote",
          disabled: false,
          codemode: false,
          oauth: { callback_port: 3456 },
        },
        figma: {
          type: "local",
          disabled: false,
          codemode: false,
          command: ["/public/bin/pnx", expect.any(String), expect.any(String)],
        },
        disabled: { disabled: true, oauth: false },
      },
    });
    expect(Object.values(values)).toContain(input.mcp.Notion.url);
    expect(Object.values(values)).toContain(input.mcp.figma.command[2]);
    expect(Object.values(values)).toContain("-y");
    expect(Object.values(values)).toContain(input.agent["fast-coder"].prompt);
    expect(
      result.secretSlots.every(
        (slot) => typeof values[slot.placeholder] === "string",
      ),
    ).toBe(true);
    expect(result.secretSlots.map((slot) => slot.id).length).toBe(
      new Set(result.secretSlots.map((slot) => slot.id)).size,
    );
  });

  it("maps providers' headers/body separately and model options to settings, never body", () => {
    const result = convert(fixture());
    expect(result.draftNativeConfig.providers).toMatchObject({
      openrouter: {
        settings: { baseURL: expect.stringContaining("__OPENCODE_PRIVATE_") },
        headers: {
          Authorization: expect.stringContaining("__OPENCODE_PRIVATE_"),
        },
        body: { reasoningEffort: "high" },
      },
    });
    expect(result.draftNativeConfig.providers).not.toHaveProperty(
      "openrouter.settings.headers",
    );
    expect(result.draftNativeConfig.providers).not.toHaveProperty(
      "openrouter.models.google/gemini-3.8-flash.body",
    );
    expect(result.userPolicy).toEqual({
      version: 1,
      instructionFiles: [
        "/legacy/v1/AGENTS.md",
        "/legacy/v1/MEMORY.md",
        "/legacy/v1/USER.md",
      ],
      modelAllowlists: {
        openai: ["gpt-5.6-terra-fast"],
        openrouter: ["google/gemini-3.8-flash"],
      },
      geminiOpenRouterToolGuard: true,
    });
  });

  it("recognizes reviewed built-in packages without replacing OpenAI or OpenRouter integrations", () => {
    const result = convert({
      provider: {
        openai: {
          id: "openai",
          npm: "@ai-sdk/openai",
          env: ["API_KEY"],
          name: SECRET,
        },
        openrouter: {
          npm: "@openrouter/ai-sdk-provider",
          api: SECRET,
          options: { reasoningEffort: "high" },
          models: { "google/gemini-3.8-flash": { name: SECRET } },
        },
      },
    });
    expect(result.conversionComplete).toBe(true);
    expect(result.draftNativeConfig.providers).toMatchObject({
      openai: { env: ["API_KEY"], name: expect.any(String) },
      openrouter: {
        settings: { reasoningEffort: "high", baseURL: expect.any(String) },
      },
    });
    expect(result.draftNativeConfig.providers).not.toHaveProperty(
      "openai.package",
    );
    expect(result.draftNativeConfig.providers).not.toHaveProperty(
      "openrouter.package",
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(
      codes(result).filter(
        (code) => code === "NATIVE_BUILTIN_PROVIDER_PACKAGE",
      ),
    ).toHaveLength(2);
  });

  it("blocks provider identity, endpoint and package conflicts", () => {
    expect(codes(convert({ provider: { openai: { id: SECRET } } }))).toContain(
      "PROVIDER_ID_CONFLICT",
    );
    expect(codes(convert({ provider: { openai: { npm: SECRET } } }))).toContain(
      "UNREVIEWED_PROVIDER_PACKAGE",
    );
    expect(
      codes(
        convert({
          provider: {
            openai: {
              api: SECRET,
              options: { baseURL: "other-private-endpoint" },
            },
          },
        }),
      ),
    ).toContain("PROVIDER_ENDPOINT_CONFLICT");
    expect(codes(convert({ provider: { question: {} } }))).toContain(
      "UNREVIEWED_PROVIDER_MAPPING",
    );
    expect(
      convert({
        provider: { openai: { api: SECRET, options: { baseURL: SECRET } } },
      }).conversionComplete,
    ).toBe(true);
  });

  it("maps supported scalars and agent fields without arbitrary pass-through", () => {
    const result = convert({
      snapshot: true,
      autoupdate: "notify",
      share: "manual",
      commands: {},
      agent: {
        "fast-coder": {
          color: "#ab12ff",
          hidden: true,
          steps: 3,
          mode: "primary",
        },
      },
    });
    expect(result.conversionComplete).toBe(true);
    expect(result.draftNativeConfig).toMatchObject({
      snapshots: true,
      update: "notify",
      share: "manual",
      agents: {
        "fast-coder": {
          color: "#ab12ff",
          hidden: true,
          steps: 3,
          mode: "primary",
        },
      },
    });
    expect(convert({ autoupdate: true }).draftNativeConfig.update).toBe("auto");
    expect(convert({ share: "auto" }).draftNativeConfig.share).toBe("auto");
  });

  it("keeps overridden agent option values out of bindings and preserves explicit precedence regardless of input order", () => {
    const result = convert({
      agent: {
        "fast-coder": {
          temperature: 0.7,
          top_p: 0.6,
          options: { temperature: SECRET, top_p: SECRET },
        },
      },
    });
    expect(result.conversionComplete).toBe(true);
    expect(result.draftNativeConfig.agents).toEqual({
      "fast-coder": { request: { body: { temperature: 0.7, top_p: 0.6 } } },
    });
    expect(result.secretSlots).toEqual([]);
  });

  it("externalizes numeric sensitive settings too, rather than assuming secrets are strings", () => {
    const input = {
      provider: {
        openai: { options: { nested: { token: [987654321, false] } } },
      },
    };
    const result = convert(input);
    expect(result.conversionComplete).toBe(true);
    expect(JSON.stringify(result)).not.toContain("987654321");
    expect(Object.values(bindings(input, result))).toEqual([987654321, false]);
    expect(
      convert({ provider: { openai: { options: { apiKey: 987654321 } } } })
        .conversionComplete,
    ).toBe(false);
  });

  it("uses reviewed executable mappings and one native plugin replacement", () => {
    const result = convert(fixture());
    expect(result.draftNativeConfig.plugins).toEqual([
      {
        package: "/isolated/v2/plugins/reflection",
        options: {
          configPath: "/isolated/v2/reflection.json",
          userPolicyPath: "/isolated/v2/policy.json",
        },
      },
    ]);
    expect(result.draftNativeConfig.skills).toEqual([
      "/legacy/v1/skills/big-diff-replay",
    ]);
    expect(result.assets.map((asset) => asset.kind)).toEqual([
      "skill",
      "plugin",
      "instruction",
      "instruction",
      "instruction",
    ]);
  });

  it.each([undefined, 70000])(
    "preserves v1 millisecond defaults and explicit precedence (global %s)",
    (timeout) => {
      const result = convert({
        ...(timeout === undefined
          ? {}
          : { experimental: { mcp_timeout: timeout } }),
        mcp: {
          figma: { type: "local", command: ["pnx"] },
          disabled: { type: "remote", url: SECRET, timeout: 12345 },
        },
      });
      expect(result.conversionComplete).toBe(true);
      expect(result.draftNativeConfig.mcp).toMatchObject({
        timeout: {
          startup: 30000,
          catalog: 30000,
          execution: timeout ?? 60000,
        },
        servers: {
          figma: {
            timeout: {
              startup: 30000,
              catalog: 30000,
              execution: timeout ?? 60000,
            },
          },
          disabled: {
            timeout: { startup: 12345, catalog: 12345, execution: 12345 },
          },
        },
      });
    },
  );

  it("keeps progress-reset and remote transport/catalog parity caveats visible", () => {
    expect(codes(convert(fixture()))).toEqual(
      expect.arrayContaining([
        "MCP_PROGRESS_RESET_PARITY_UNVERIFIED",
        "MCP_TRANSPORT_PARITY_UNVERIFIED",
      ]),
    );
  });

  it("applies explicit server timeout to startup/catalog/execution for local and remote servers", () => {
    const result = convert({
      experimental: { mcp_timeout: 70000 },
      mcp: {
        figma: { type: "local", command: ["pnx"], timeout: 12345 },
        Notion: { type: "remote", url: SECRET, timeout: 45678 },
      },
    });
    expect(result.conversionComplete).toBe(true);
    expect(result.draftNativeConfig.mcp).toMatchObject({
      timeout: { startup: 30000, catalog: 30000, execution: 70000 },
      servers: {
        figma: {
          timeout: { startup: 12345, catalog: 12345, execution: 12345 },
        },
        Notion: {
          timeout: { startup: 45678, catalog: 45678, execution: 45678 },
        },
      },
    });
    expect(
      convert({ experimental: { mcp_timeout: 70000 } }).draftNativeConfig.mcp,
    ).toEqual({
      timeout: { startup: 30000, catalog: 30000, execution: 70000 },
    });
  });

  it("uses only explicitly reviewed v2 binding without mutating or propagating the v1 hostname", () => {
    const input = fixture();
    const result = convert(input);
    expect(result.runtime?.v2Hostname).toBe("127.0.0.1");
    expect(input.server).toEqual({ port: 4096, hostname: "0.0.0.0" });
    expect(result.runtime?.v1Port).toBe(4097);
    expect(codes(result)).toContain("FINAL_BINDING_FROM_CONTEXT");
    const isolated = convert({ server: { hostname: SECRET } });
    expect(isolated.conversionComplete).toBe(true);
    expect(isolated.secretSlots).toEqual([]);
    expect(isolated.ledger).toContainEqual({
      sourcePath: [0, 0],
      disposition: "externalized",
    });
    expect(JSON.stringify(isolated)).not.toContain(SECRET);
    expect(
      convert(
        {},
        {
          runtime: {
            ...context.runtime,
            v2Hostname: "reviewed.synthetic.invalid",
          },
        },
      ).runtime?.v2Hostname,
    ).toBe("reviewed.synthetic.invalid");
  });

  it.each(["", "\0", "   "])(
    "requires a nonempty explicit context binding (%s)",
    (v2Hostname) => {
      const result = convert(
        { server: { hostname: "0.0.0.0" } },
        { runtime: { ...context.runtime, v2Hostname } },
      );
      expect(result.conversionComplete).toBe(false);
      expect(result.runtime).toBeNull();
    },
  );

  it("does not infer missing hostname or runtime paths from source data", () => {
    for (const key of [
      "v2Hostname",
      "nativeConfigPath",
      "reflectionConfigPath",
      "userPolicyPath",
    ]) {
      const runtime = { ...context.runtime };
      Reflect.deleteProperty(runtime, key);
      const result = convert({ server: { hostname: "0.0.0.0" } }, { runtime });
      expect(result.conversionComplete).toBe(false);
      expect(result.runtime).toBeNull();
    }
  });

  it.each([null, 3, "", "a\0b"])(
    "rejects invalid source hostnames (%s)",
    (hostname) => {
      expect(codes(convert({ server: { hostname } }))).toContain(
        "INVALID_HOSTNAME",
      );
    },
  );

  it("separates native, Reflection, and user-policy files and rejects their collisions", () => {
    const result = convert({});
    expect(result.runtime?.nativeConfigPath).toBe("/isolated/v2/opencode.json");
    expect(result.draftNativeConfig.plugins).toEqual([
      {
        package: context.nativeReplacement.directory,
        options: {
          configPath: context.runtime.reflectionConfigPath,
          userPolicyPath: context.runtime.userPolicyPath,
        },
      },
    ]);
    for (const nativeConfigPath of [
      context.runtime.reflectionConfigPath,
      context.runtime.userPolicyPath,
      "/isolated/v2/folder/../reflection.json",
      "/legacy/v1/opencode.json",
    ]) {
      expect(
        convert({}, { runtime: { ...context.runtime, nativeConfigPath } })
          .conversionComplete,
      ).toBe(false);
    }
  });

  it("keeps instruction files live as explicit read-only references and deduplicates resolved paths in order", () => {
    const alias = "/legacy/v1/./MEMORY.md";
    const result = convert(
      {
        instructions: [
          "/legacy/v1/MEMORY.md",
          "/legacy/v1/USER.md",
          alias,
          "/legacy/v1/AGENTS.md",
        ],
      },
      {
        publicStrings: [...context.publicStrings, alias],
        instructionMappings: {
          ...context.instructionMappings,
          [alias]: { destination: alias, mode: "read-only-reference" },
        },
      },
    );
    expect(result.conversionComplete).toBe(true);
    expect(result.userPolicy.instructionFiles).toEqual([
      "/legacy/v1/MEMORY.md",
      "/legacy/v1/USER.md",
      "/legacy/v1/AGENTS.md",
    ]);
    expect(
      result.assets.filter((asset) => asset.kind === "instruction"),
    ).toHaveLength(3);
    expect(
      result.assets
        .filter((asset) => asset.kind === "instruction")
        .every(
          (asset) =>
            asset.mode === "read-only-reference" &&
            asset.source === asset.destination,
        ),
    ).toBe(true);
    expect(codes(result)).not.toContain("INSTRUCTION_COPY_NOT_LIVE_PARITY");
    expect(result.assets.find((asset) => asset.kind === "skill")).toEqual({
      kind: "skill",
      source: "/legacy/v1/skills/big-diff-replay",
      destination: "/legacy/v1/skills/big-diff-replay",
      mode: "read-only-reference",
    });
  });

  describe("explicit source-home instruction expansion", () => {
    const sourceHome = "/synthetic/home";
    const sourceRoot = `${sourceHome}/.config/opencode`;
    const rawPaths = [
      "~/.config/opencode/MEMORY.md",
      "~/.config/opencode/USER.md",
    ];
    const absolutePaths = [`${sourceRoot}/MEMORY.md`, `${sourceRoot}/USER.md`];
    const homeContext: ConversionContext = {
      ...context,
      sourceHome,
      sourceRoot,
      skills: { inventoryKnown: true, entries: [] },
      publicStrings: [...context.publicStrings, ...rawPaths, ...absolutePaths],
      instructionMappings: Object.fromEntries(
        [...rawPaths, ...absolutePaths].map((raw, i) => [
          raw,
          {
            destination: absolutePaths[i % 2]!,
            mode: "read-only-reference" as const,
          },
        ]),
      ),
    };

    it("expands MEMORY/USER references without environment or homedir reads, preserving input and ordinal pointers", () => {
      const input = { instructions: [...rawPaths], username: SECRET };
      const original = JSON.stringify(input);
      let environmentReads = 0;
      const homeSpy = vi.spyOn(os, "homedir").mockImplementation(() => {
        throw new Error("Unexpected home lookup");
      });
      const guardedProcess = new Proxy(process, {
        get(target, key, receiver) {
          if (key === "env") {
            environmentReads++;
            throw new Error("Unexpected environment lookup");
          }
          return Reflect.get(target, key, receiver);
        },
      });
      let result: ConversionResult;
      try {
        vi.stubGlobal("process", guardedProcess);
        result = convert(input, homeContext);
      } finally {
        vi.unstubAllGlobals();
        homeSpy.mockRestore();
      }
      expect(environmentReads).toBe(0);
      expect(result.conversionComplete).toBe(true);
      expect(result.userPolicy.instructionFiles).toEqual(absolutePaths);
      expect(
        result.assets.filter((asset) => asset.kind === "instruction"),
      ).toEqual(
        absolutePaths.map((source) => ({
          kind: "instruction",
          source,
          destination: source,
          mode: "read-only-reference",
        })),
      );
      expect(result.ledger).toContainEqual({
        sourcePath: [0, 0],
        disposition: "externalized",
      });
      expect(result.ledger).toContainEqual({
        sourcePath: [0, 1],
        disposition: "externalized",
      });
      expect(result.secretSlots[0]?.sourcePath).toEqual([1]);
      expect(Object.values(bindings(input, result))).toEqual([SECRET]);
      expect(JSON.stringify(input)).toBe(original);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it("deduplicates absolute and tilde aliases by resolved path without reordering", () => {
      const result = convert(
        {
          instructions: [
            rawPaths[1],
            absolutePaths[0],
            rawPaths[0],
            absolutePaths[1],
          ],
        },
        homeContext,
      );
      expect(result.conversionComplete).toBe(true);
      expect(result.userPolicy.instructionFiles).toEqual([
        absolutePaths[1],
        absolutePaths[0],
      ]);
      expect(
        result.assets.filter((asset) => asset.kind === "instruction"),
      ).toHaveLength(2);
    });

    it.each([undefined, "", "relative/home", "/synthetic/\0home"])(
      "refuses tilde paths without a valid explicit home (%s)",
      (sourceHome) => {
        const result = convert(
          { instructions: rawPaths },
          { ...homeContext, sourceHome },
        );
        expect(result.conversionComplete).toBe(false);
        expect(codes(result)).toContain("SOURCE_HOME_REQUIRED");
        expect(result.userPolicy.instructionFiles).toEqual([]);
      },
    );

    it("does not require sourceHome for absolute-only inputs or accept a resolved-key fallback", () => {
      expect(
        convert(
          { instructions: absolutePaths },
          { ...homeContext, sourceHome: undefined },
        ).conversionComplete,
      ).toBe(true);
      const instructionMappings = Object.fromEntries(
        absolutePaths.map((path) => [
          path,
          { destination: path, mode: "read-only-reference" as const },
        ]),
      );
      expect(
        convert(
          { instructions: rawPaths },
          { ...homeContext, instructionMappings },
        ).conversionComplete,
      ).toBe(false);
    });

    it("rejects a wrong home and mismatched read-only destinations", () => {
      expect(
        convert(
          { instructions: rawPaths },
          { ...homeContext, sourceHome: "/different/home" },
        ).conversionComplete,
      ).toBe(false);
      const result = convert(
        { instructions: [rawPaths[0]] },
        {
          ...homeContext,
          instructionMappings: {
            [rawPaths[0]!]: {
              destination: absolutePaths[1]!,
              mode: "read-only-reference",
            },
          },
        },
      );
      expect(result.conversionComplete).toBe(false);
      expect(result.userPolicy.instructionFiles).toEqual([]);
    });

    it.each([
      "~otheruser/.config/opencode/MEMORY.md",
      "~/.config/opencode/*.md",
      "https://synthetic.invalid/MEMORY.md",
      "~/.config/opencode/USER\0.md",
      "~/.config/opencode/../../outside.md",
      "~/../outside.md",
    ])("rejects unsafe source paths (%s)", (source) => {
      const result = convert(
        { instructions: [source] },
        {
          ...homeContext,
          publicStrings: [...homeContext.publicStrings, source],
          instructionMappings: {
            [source]: {
              destination: absolutePaths[0]!,
              mode: "read-only-reference",
            },
          },
        },
      );
      expect(result.conversionComplete).toBe(false);
      expect(result.userPolicy.instructionFiles).toEqual([]);
    });
  });

  it("permits explicitly selected private copies but warns they are not live definition parity", () => {
    const result = convert(
      { instructions: ["/legacy/v1/USER.md"] },
      {
        instructionMappings: {
          "/legacy/v1/USER.md": {
            destination: "/isolated/v2/USER.md",
            mode: "private-copy",
          },
        },
        skills: {
          inventoryKnown: true,
          entries: [
            {
              source: "/legacy/v1/skills/a",
              destination: "/isolated/v2/skills/a",
              mode: "private-copy",
            },
          ],
        },
      },
    );
    expect(result.conversionComplete).toBe(true);
    expect(result.userPolicy.instructionFiles).toEqual([
      "/isolated/v2/USER.md",
    ]);
    expect(result.draftNativeConfig.skills).toEqual(["/isolated/v2/skills/a"]);
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "INSTRUCTION_COPY_NOT_LIVE_PARITY",
        "SKILL_COPY_NOT_LIVE_PARITY",
      ]),
    );
    expect(
      result.assets
        .filter((asset) => asset.kind !== "plugin")
        .every((asset) => asset.mode === "private-copy"),
    ).toBe(true);
  });

  it.each([
    "/legacy/v1/opencode.json",
    "/legacy/v1/auth.json",
    "/legacy/v1/opencode.db",
    "/outside/USER.md",
  ])(
    "rejects config/state or out-of-root files as instruction references (%s)",
    (source) => {
      const result = convert(
        { instructions: [source] },
        {
          publicStrings: [...context.publicStrings, source],
          instructionMappings: {
            [source]: { destination: source, mode: "read-only-reference" },
          },
        },
      );
      expect(codes(result)).toContain("INSTRUCTION_MAPPING_REQUIRED");
      expect(result.userPolicy.instructionFiles).toEqual([]);
    },
  );

  it("does not turn mismatched references or source state directories into shared assets", () => {
    expect(
      convert(
        { instructions: ["/legacy/v1/USER.md"] },
        {
          instructionMappings: {
            "/legacy/v1/USER.md": {
              destination: "/legacy/v1/MEMORY.md",
              mode: "read-only-reference",
            },
          },
        },
      ).conversionComplete,
    ).toBe(false);
    for (const source of [
      "/legacy/v1/auth",
      "/legacy/v1/state",
      "/outside/skills/a",
    ]) {
      expect(
        convert(
          {},
          {
            skills: {
              inventoryKnown: true,
              entries: [
                { source, destination: source, mode: "read-only-reference" },
              ],
            },
          },
        ).conversionComplete,
      ).toBe(false);
    }
  });

  it("keeps pinned wire-body top_p/temperature semantics and blocks unverified topP instead of rewriting", () => {
    const result = convert({
      agent: {
        "fast-coder": {
          options: { temperature: 0.4, top_p: 0.5 },
          prompt: SECRET,
        },
      },
    });
    expect(result.conversionComplete).toBe(true);
    expect(result.draftNativeConfig.agents).toMatchObject({
      "fast-coder": { request: { body: { temperature: 0.4, top_p: 0.5 } } },
    });
    expect(
      Object.values(
        bindings(
          {
            agent: {
              "fast-coder": {
                options: { temperature: 0.4, top_p: 0.5 },
                prompt: SECRET,
              },
            },
          },
          result,
        ),
      ),
    ).toEqual([SECRET]);
    const blocked = convert({
      agent: { "fast-coder": { options: { topP: 0.5 }, top_p: 0.6 } },
    });
    expect(blocked.conversionComplete).toBe(false);
    expect(codes(blocked)).toContain("UNSUPPORTED_AGENT_TOP_P_CAMEL_CASE");
  });

  it("normalizes combined provider policies identically for both source key orders", () => {
    const enabled = [
      "openrouter",
      "openai",
      "azure-cognitive-services",
      "google-vertex-anthropic",
    ];
    const disabled = ["openai", "openrouter"];
    for (const input of [
      { enabled_providers: enabled, disabled_providers: disabled },
      { disabled_providers: disabled, enabled_providers: enabled },
    ]) {
      const result = convert(input, {
        publicStrings: [...context.publicStrings, ...enabled],
      });
      expect(result.conversionComplete).toBe(true);
      expect(result.draftNativeConfig.experimental).toEqual({
        policies: [
          { action: "provider.use", resource: "*", effect: "deny" },
          { action: "provider.use", resource: "openrouter", effect: "allow" },
          { action: "provider.use", resource: "openai", effect: "allow" },
          { action: "provider.use", resource: "azure", effect: "allow" },
          {
            action: "provider.use",
            resource: "google-vertex",
            effect: "allow",
          },
          { action: "provider.use", resource: "openai", effect: "deny" },
          { action: "provider.use", resource: "openrouter", effect: "deny" },
        ],
      });
    }
    expect(
      convert({ enabled_providers: [] }).draftNativeConfig.experimental,
    ).toEqual({
      policies: [{ action: "provider.use", resource: "*", effect: "deny" }],
    });
    expect(convert({ enabled_providers: SECRET }).conversionComplete).toBe(
      false,
    );
    expect(convert({ enabled_providers: [SECRET] }).conversionComplete).toBe(
      false,
    );
  });

  it.each(["logLevel", "small_model", "lsp", "footer"])(
    "honestly blocks unimplemented known fields (%s)",
    (key) => {
      const result = convert({ [key]: SECRET });
      expect(result.conversionComplete).toBe(false);
      expect(codes(result)).toContain("UNHANDLED_FIELD");
      expect(JSON.stringify(result)).not.toContain(SECRET);
    },
  );

  it("preserves explicit agent disable but does not manufacture it for missing OpenAI auth", () => {
    expect(
      convert({ agent: { "fast-coder": { disable: true } } }).draftNativeConfig
        .agents,
    ).toEqual({ "fast-coder": { disabled: true } });
    expect(
      convert({ agent: { "fast-coder": { disable: false } } }).draftNativeConfig
        .agents,
    ).toEqual({ "fast-coder": { disabled: false } });
  });

  it("maps aliases in place and blocks conflicting policies instead of collapsing them", () => {
    const mapped = convert({
      permission: { task: "allow", write: "deny", patch: "deny" },
    });
    expect(mapped.conversionComplete).toBe(true);
    expect(mapped.draftNativeConfig.permissions).toEqual([
      { action: "subagent", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
    ]);
    expect(
      codes(convert({ permission: { write: "allow", patch: "deny" } })),
    ).toContain("PERMISSION_RENAME_COLLISION");
    expect(
      codes(convert({ permission: { bash: "allow", shell: "deny" } })),
    ).toContain("PERMISSION_RENAME_COLLISION");
    expect(
      convert({ permission: "ask" }).draftNativeConfig.permissions,
    ).toEqual([{ action: "*", resource: "*", effect: "ask" }]);
  });

  it("preserves provider policy order and allowlist order", () => {
    const result = convert({
      disabled_providers: ["openrouter", "openai"],
      provider: {
        openrouter: {
          whitelist: ["google/gemini-3.8-flash", "gpt-5.6-terra-fast"],
        },
      },
    });
    expect(result.conversionComplete).toBe(true);
    expect(result.draftNativeConfig.experimental).toEqual({
      policies: [
        { action: "provider.use", resource: "openrouter", effect: "deny" },
        { action: "provider.use", resource: "openai", effect: "deny" },
      ],
    });
    expect(result.userPolicy.modelAllowlists.openrouter).toEqual([
      "google/gemini-3.8-flash",
      "gpt-5.6-terra-fast",
    ]);
  });

  it("requires an explicit compaction override and never emits auto=true", () => {
    expect(codes(convert({ compaction: { auto: true } }))).toContain(
      "COMPACTION_POLICY_CONFLICT",
    );
    const overridden = convert(
      { compaction: { auto: true } },
      { overrideCompactionAuto: true },
    );
    expect(overridden.conversionComplete).toBe(true);
    expect(overridden.draftNativeConfig.compaction).toEqual({ auto: false });
    expect(codes(overridden)).toContain("COMPACTION_POLICY_OVERRIDE");
    expect(codes(convert({ compaction: { tail_turns: 4 } }))).toContain(
      "UNSUPPORTED_TAIL_TURNS",
    );
    expect(
      codes(
        convert(
          { compaction: { auto: false, tail_turns: 4 } },
          { reflectionNativeCompactionVeto: false },
        ),
      ),
    ).toContain("UNSUPPORTED_TAIL_TURNS");
  });

  it.each([
    [{ unexpected: SECRET }, "UNHANDLED_FIELD"],
    [{ agent: { "fast-coder": { unknown: SECRET } } }, "UNHANDLED_FIELD"],
    [{ agent: { "fast-coder": { name: SECRET } } }, "AGENT_NAME_CONFLICT"],
    [{ agent: { "fast-coder": { variant: "high" } } }, "INVALID_VARIANT"],
    [
      { provider: { openai: { blacklist: [SECRET] } } },
      "UNSUPPORTED_PROVIDER_BLACKLIST",
    ],
    [{ plugin: [SECRET] }, "UNKNOWN_PLUGIN"],
    [{ command: { secret: SECRET } }, "UNSUPPORTED_NONEMPTY_FIELD"],
    [{ mode: { secret: SECRET } }, "UNSUPPORTED_NONEMPTY_FIELD"],
    [{ mcp: { Notion: { enabled: true } } }, "MCP_FULL_DEFINITION_REQUIRED"],
    [
      { mcp: { figma: { type: "local", command: [SECRET] } } },
      "EXECUTABLE_MAPPING_REQUIRED",
    ],
    [
      {
        mcp: {
          figma: {
            type: "local",
            command: ["pnx"],
            environment: { API_KEY: 123 },
          },
        },
      },
      "INVALID_STRING",
    ],
    [
      {
        mcp: {
          Notion: {
            type: "remote",
            url: SECRET,
            headers: { Authorization: false },
          },
        },
      },
      "INVALID_STRING",
    ],
    [{ mcp: { Notion: { type: "remote" } } }, "NATIVE_SCHEMA_INVALID"],
    [{ experimental: { mcp_timeout: 0 } }, "INVALID_TIMEOUT"],
    [{ compaction: { auto: "false" } }, "INVALID_BOOLEAN"],
    [{ server: { hostname: "" } }, "INVALID_HOSTNAME"],
    [{ model: SECRET }, "INVALID_MODEL_SELECTION"],
    [{ permission: { question: SECRET } }, "INVALID_PERMISSION"],
  ])(
    "blocks unsupported or invalid data without reflecting values (%s)",
    (input, code) => {
      const result = convert(input);
      expect(result.conversionComplete).toBe(false);
      expect(result.activationReady).toBe(false);
      expect(codes(result)).toContain(code);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(
        result.ledger.some((entry) => entry.disposition === "blocked"),
      ).toBe(true);
    },
  );

  it("redacts unknown field names as well as values from diagnostics and the ledger", () => {
    const result = convert({
      [SECRET]: { [SECRET]: SECRET },
      provider: { [SECRET]: { options: { [SECRET]: SECRET } } },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.ledger).toEqual(
      expect.arrayContaining([{ sourcePath: [0, 0], disposition: "blocked" }]),
    );
  });

  it("externalizes nested arbitrary settings including arrays, with no sorting or string heuristics", () => {
    const input = {
      provider: {
        openrouter: {
          options: {
            nested: {
              array: [SECRET, "Vertex", { token: "high" }, null, 3, false],
            },
          },
        },
      },
    };
    const result = convert(input);
    expect(result.conversionComplete).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(Object.values(bindings(input, result))).toEqual([SECRET, "high"]);
    expect(result.draftNativeConfig.providers).toMatchObject({
      openrouter: {
        settings: {
          nested: {
            array: [
              expect.any(String),
              "Vertex",
              { token: expect.stringContaining("__OPENCODE_PRIVATE_") },
              null,
              3,
              false,
            ],
          },
        },
      },
    });
  });

  it.each([
    "https://synthetic.invalid/instructions",
    "/legacy/v1/*.md",
    "relative.md",
    "/legacy/v1/UNKNOWN.md",
  ])("blocks unresolvable instructions: %s", (source) => {
    const result = convert(
      { instructions: [source] },
      { publicStrings: [...context.publicStrings, source] },
    );
    expect(codes(result)).toContain("INSTRUCTION_MAPPING_REQUIRED");
    expect(result.userPolicy.instructionFiles).toEqual([]);
  });

  it.each([
    { agentsDiscoveryHandled: false },
    { reflectionNativeCompactionVeto: false },
    { skills: { inventoryKnown: false, entries: [] } },
    {
      skills: {
        inventoryKnown: true,
        entries: [
          {
            source: "/legacy/v1/skills/a",
            destination: "/isolated/v2/skills/b",
            mode: "private-copy" as const,
          },
        ],
      },
    },
    { root: "/legacy/v1" },
    { root: "/legacy/v1/nested" },
    { root: "/legacy" },
    { runtime: { ...context.runtime, dataPath: "/isolated/v2/../outside" } },
    { runtime: { ...context.runtime, cachePath: context.runtime.dataPath } },
    {
      nativeReplacement: {
        ...context.nativeReplacement,
        directory: "/outside",
      },
    },
  ])("blocks incomplete or non-isolated context: %s", (override) => {
    expect(convert({}, override).conversionComplete).toBe(false);
  });

  it("accounts for every JSON node including nested option leaves", () => {
    const input = fixture();
    let count = 0;
    const visit = (value: unknown) => {
      count++;
      if (typeof value === "object" && value !== null)
        Object.values(value).forEach(visit);
    };
    visit(input);
    const result = convert(input);
    expect(result.ledger).toHaveLength(count);
    expect(
      new Set(result.ledger.map((entry) => entry.sourcePath.join("/"))).size,
    ).toBe(count);
    expect(
      result.ledger.every((entry) =>
        ["mapped", "externalized", "redundant", "blocked"].includes(
          entry.disposition,
        ),
      ),
    ).toBe(true);
  });

  it("blocks lexical destination collisions without accessing the filesystem", () => {
    expect(
      convert(
        {},
        {
          runtime: {
            ...context.runtime,
            cachePath: "/isolated/v2/folder/../data",
          },
        },
      ).conversionComplete,
    ).toBe(false);
    const result = convert(
      { instructions: ["/legacy/v1/AGENTS.md", "/legacy/v1/USER.md"] },
      {
        instructionMappings: {
          "/legacy/v1/AGENTS.md": {
            destination: "/isolated/v2/shared.md",
            mode: "private-copy",
          },
          "/legacy/v1/USER.md": {
            destination: "/isolated/v2/shared.md",
            mode: "private-copy",
          },
        },
      },
    );
    expect(codes(result)).toContain("MANIFEST_DESTINATION_CONFLICT");
    expect(result.conversionComplete).toBe(false);
    expect(
      codes(
        convert(
          { instructions: ["/legacy/v1/USER.md"] },
          {
            instructionMappings: {
              "/legacy/v1/USER.md": {
                destination: context.runtime.userPolicyPath,
                mode: "private-copy",
              },
            },
          },
        ),
      ),
    ).toContain("MANIFEST_DESTINATION_CONFLICT");
  });

  it("rejects cycles, non-JSON values and getters without executing them or leaking exceptions", () => {
    let reads = 0;
    const getter = Object.defineProperty({}, "private", {
      enumerable: true,
      get() {
        reads++;
        throw new Error(SECRET);
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const input of [
      getter,
      cycle,
      { value: undefined },
      { value: NaN },
      new Date(),
      { value: BigInt(4) },
      null,
      [],
    ]) {
      const result = convert(input);
      expect(codes(result)).toContain("INVALID_JSON_INPUT");
      expect(result.conversionComplete).toBe(false);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
    expect(reads).toBe(0);
  });

  it("proves excess properties fail the real decoder, not just a hand-written approximation", () => {
    const decode = Schema.decodeUnknownSync(Config.Info, {
      onExcessProperty: "error",
    });
    expect(() => decode({ agent: {} })).toThrow();
    expect(() =>
      decode({
        mcp: {
          servers: {
            synthetic: {
              type: "remote",
              url: "placeholder",
              timeout: { startup: "30s" },
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      decode({
        agents: {
          synthetic: {
            model: {
              providerID: "openai",
              model: "synthetic",
              variant: "high",
            },
          },
        },
        mcp: { timeout: { startup: 30000, catalog: 30000, execution: 60000 } },
      }),
    ).not.toThrow();
  });
});
