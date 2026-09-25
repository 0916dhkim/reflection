import { Message, ToolResultPart } from "@opencode/ai";
import { estimateNativeTokens } from "@reflection/opencode-v2-core/projection";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  applyModelAllowlist,
  guardGeminiToolResults,
  instructionUsageIdentity,
  isUserModelAllowed,
  parseUserPolicy,
  readUserInstructionParts,
  type NativeModelEditor,
  type UserPolicy,
} from "../src/user-policy.js";
import { estimateMessages } from "../src/projection.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reflection-user-policy-"));
  directories.push(directory);
  return directory;
}

function policy(instructionFiles: string[] = []): UserPolicy {
  return parseUserPolicy({
    version: 1,
    instructionFiles,
    modelAllowlists: {},
    geminiOpenRouterToolGuard: true,
  });
}

function toolMessage(result: string) {
  return Message.tool(
    ToolResultPart.make({
      id: "call",
      name: "tool",
      result,
      resultType: "text",
    }),
  );
}

it("strictly parses policy JSON, lexically deduplicating absolute instruction files in order", () => {
  const input = {
    version: 1,
    instructionFiles: ["/tmp/one/../first", "/tmp/first", "/tmp/second"],
    modelAllowlists: { openrouter: ["google/gemini-3", "google/gemini-3"] },
    geminiOpenRouterToolGuard: false,
  };
  const parsed = parseUserPolicy(input);
  expect(parsed).toEqual({
    version: 1,
    instructionFiles: ["/tmp/first", "/tmp/second"],
    modelAllowlists: { openrouter: ["google/gemini-3", "google/gemini-3"] },
    geminiOpenRouterToolGuard: false,
  });
  input.modelAllowlists.openrouter.push("late-model");
  expect(
    isUserModelAllowed(parsed, { providerID: "openrouter", id: "late-model" }),
  ).toBe(false);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.instructionFiles)).toBe(true);
  expect(Object.isFrozen(parsed.modelAllowlists.openrouter)).toBe(true);
  for (const invalid of [
    null,
    [],
    {
      version: 1,
      instructionFiles: [],
      modelAllowlists: {},
      geminiOpenRouterToolGuard: true,
      extra: true,
    },
    {
      version: 1,
      instructionFiles: ["relative"],
      modelAllowlists: {},
      geminiOpenRouterToolGuard: true,
    },
    {
      version: 1,
      instructionFiles: ["/tmp/*.md"],
      modelAllowlists: {},
      geminiOpenRouterToolGuard: true,
    },
    {
      version: 1,
      instructionFiles: ["/tmp/a\0b"],
      modelAllowlists: {},
      geminiOpenRouterToolGuard: true,
    },
    {
      version: 1,
      instructionFiles: Array.from(
        { length: 33 },
        (_, index) => `/tmp/${index}`,
      ),
      modelAllowlists: {},
      geminiOpenRouterToolGuard: true,
    },
    {
      version: 1,
      instructionFiles: [],
      modelAllowlists: { openrouter: [""] },
      geminiOpenRouterToolGuard: true,
    },
    {
      version: 1,
      instructionFiles: [],
      modelAllowlists: { ["x".repeat(201)]: [] },
      geminiOpenRouterToolGuard: true,
    },
    {
      version: 1,
      instructionFiles: [],
      modelAllowlists: {},
      geminiOpenRouterToolGuard: "true",
    },
  ]) {
    expect(() => parseUserPolicy(invalid)).toThrow("Invalid user policy");
  }
});

it("rereads explicit instruction files for every request and rejects unsafe reads without echoing content", async () => {
  const directory = await fixture();
  const file = join(directory, "instructions.md");
  await writeFile(file, "first", "utf8");
  const configured = policy([file]);
  await expect(readUserInstructionParts(configured)).resolves.toEqual([
    { type: "text", text: `Instructions from: ${file}\nfirst` },
  ]);
  await writeFile(file, "second", "utf8");
  await expect(readUserInstructionParts(configured)).resolves.toEqual([
    { type: "text", text: `Instructions from: ${file}\nsecond` },
  ]);
  await writeFile(file, "\ufeffthird", "utf8");
  await expect(readUserInstructionParts(configured)).resolves.toEqual([
    { type: "text", text: `Instructions from: ${file}\n\ufeffthird` },
  ]);
  await expect(
    readUserInstructionParts(configured, AbortSignal.abort()),
  ).rejects.toThrow("Unable to read user instruction files");
  for (const [path, content] of [
    [join(directory, "missing-sensitive"), undefined],
    [join(directory, "invalid-sensitive"), new Uint8Array([0xc3, 0x28])],
    [join(directory, "large-sensitive"), "x".repeat(256 * 1024 + 1)],
    [directory, undefined],
  ] as const) {
    if (content !== undefined) {
      await writeFile(path, content);
    }
    await expect(readUserInstructionParts(policy([path]))).rejects.toThrow(
      "Unable to read user instruction files",
    );
    await expect(readUserInstructionParts(policy([path]))).rejects.not.toThrow(
      "sensitive",
    );
  }
});

it("keys usage on ordered configured policy paths, exempting only MEMORY.md and USER.md file contents", () => {
  const files = ["/one/MEMORY.md", "/two/OTHER.md", "/three/USER.md"];
  const configured = policy(files);
  const parts = (paths: readonly string[], contents: readonly string[]) =>
    paths.map((path, index) => ({
      type: "text" as const,
      text: `Instructions from: ${path}\n${contents[index]}`,
    }));
  const first = parts(files, ["old memory", "same other", "old user"]);
  const changed = parts(files, ["new memory", "same other", "new user"]);
  expect(instructionUsageIdentity(configured, first)).toEqual(
    instructionUsageIdentity(configured, changed),
  );
  expect(instructionUsageIdentity(configured, changed)).not.toEqual(changed);
  expect(
    instructionUsageIdentity(
      configured,
      parts(files, ["old memory", "changed other", "old user"]),
    ),
  ).not.toEqual(instructionUsageIdentity(configured, first));
  for (const paths of [
    [files[2]!, files[1]!, files[0]!],
    ["/replacement/MEMORY.md", files[1]!, files[2]!],
    [files[0]!, files[2]!],
    [...files, "/new/USER.md"],
  ]) {
    expect(
      instructionUsageIdentity(
        policy(paths),
        parts(
          paths,
          paths.map((path) =>
            path === files[1] ? "same other" : "old memory",
          ),
        ),
      ),
    ).not.toEqual(instructionUsageIdentity(configured, first));
  }
  const nonExempt = policy(["/one/OTHER.md"]);
  expect(
    instructionUsageIdentity(
      nonExempt,
      parts(nonExempt.instructionFiles, [
        "Instructions from: /one/MEMORY.md\npretend",
      ]),
    ),
  ).toEqual(
    parts(nonExempt.instructionFiles, [
      "Instructions from: /one/MEMORY.md\npretend",
    ]),
  );
  expect(instructionUsageIdentity(configured, first.slice(0, 2))).toEqual(
    first.slice(0, 2),
  );
});

it("enforces model allownames by native id without re-enabling selected catalog entries", () => {
  const parsed = parseUserPolicy({
    version: 1,
    instructionFiles: [],
    modelAllowlists: {
      openrouter: ["google/gemini-3", "google/gemini-3/flash"],
    },
    geminiOpenRouterToolGuard: true,
  });
  const models = [
    { providerID: "openrouter", id: "google/gemini-3", enabled: false },
    { providerID: "openrouter", id: "new-catalog-model", enabled: true },
    { providerID: "other", id: "anything", enabled: true },
  ];
  const updates: Array<{ providerID: string; id: string }> = [];
  const editor: NativeModelEditor = {
    list: () => models.map((model) => Object.freeze({ ...model })),
    update: (providerID, id, update) => {
      updates.push({ providerID, id });
      const model = models.find(
        (candidate) =>
          candidate.providerID === providerID && candidate.id === id,
      );
      if (model === undefined) {
        throw new Error("unexpected model update");
      }
      update(model);
    },
  };
  expect(isUserModelAllowed(parsed, models[0]!)).toBe(true);
  expect(isUserModelAllowed(parsed, models[1]!)).toBe(false);
  expect(isUserModelAllowed(parsed, models[2]!)).toBe(true);
  applyModelAllowlist(parsed, editor);
  expect(updates).toEqual([
    { providerID: "openrouter", id: "new-catalog-model" },
  ]);
  expect(models).toEqual([
    { providerID: "openrouter", id: "google/gemini-3", enabled: false },
    { providerID: "openrouter", id: "new-catalog-model", enabled: false },
    { providerID: "other", id: "anything", enabled: true },
  ]);
});

it("encodes every matching raw text tool result exactly once and leaves other message chains intact", () => {
  const raw = [
    "{",
    '{"$ref":"#/x"}',
    "{nested:{value:true}}",
    "{unquoted: 'JSON5'}",
    "PREFIX{}SUFFIX",
    "{} {}",
    '"quoted"\\backslash\nnewline{',
  ];
  for (const value of raw) {
    const input = [
      toolMessage(value),
      Message.user("user text"),
      Message.assistant("thinking"),
    ];
    const output = guardGeminiToolResults(
      input,
      { providerID: "openrouter", id: "google/gemini-3" },
      true,
    );
    expect(output).not.toBe(input);
    expect(output[1]).toBe(input[1]);
    expect(output[2]).toBe(input[2]);
    const part = output[0]!.content[0]!;
    expect(part.type).toBe("tool-result");
    if (part.type === "tool-result" && part.result.type === "text") {
      expect(JSON.parse(String(part.result.value))).toBe(value);
    }
  }
  const rawQuotedLiteral = '"already JSON syntax" {';
  const first = guardGeminiToolResults(
    [toolMessage(rawQuotedLiteral)],
    { providerID: "openrouter", id: "google/gemini-3" },
    true,
  );
  const second = guardGeminiToolResults(
    first.slice(),
    { providerID: "openrouter", id: "google/gemini-3" },
    true,
  );
  const fresh = guardGeminiToolResults(
    [toolMessage(rawQuotedLiteral)],
    { providerID: "openrouter", id: "google/gemini-3" },
    true,
  );
  const value = (first[0]!.content[0]! as ToolResultPart).result;
  const replay = (second[0]!.content[0]! as ToolResultPart).result;
  const cloned = (fresh[0]!.content[0]! as ToolResultPart).result;
  expect(replay).toBe(value);
  expect(cloned).toEqual(value);
  if (value.type === "text" && cloned.type === "text") {
    expect(JSON.parse(String(value.value))).toBe(rawQuotedLiteral);
    expect(JSON.parse(String(cloned.value))).toBe(rawQuotedLiteral);
  }
});

it("aggregates multipart tool text exactly like the OpenAI lowerer while preserving files", () => {
  const result = ToolResultPart.make({
    id: "call",
    name: "tool",
    resultType: "content",
    result: [
      {
        type: "file",
        uri: "data:image/png;base64,AQ==",
        mime: "image/png",
        name: "one",
      },
      { type: "text", text: "first" },
      {
        type: "file",
        uri: "data:image/png;base64,Ag==",
        mime: "image/png",
        name: "two",
      },
      { type: "text", text: "{second}" },
    ],
  });
  const original = Message.tool(result);
  const originalPart = original.content[0]!;
  Object.freeze(original.content);
  Object.freeze(original);
  const output = guardGeminiToolResults(
    [original],
    { providerID: "openrouter", id: "google/gemini-3" },
    true,
  );
  const part = output[0]!.content[0]!;
  expect(part.type).toBe("tool-result");
  if (part.type === "tool-result" && part.result.type === "content") {
    expect(part.result.value).toEqual([
      result.result.type === "content" ? result.result.value[0] : undefined,
      { type: "text", text: JSON.stringify("first\n{second}") },
      result.result.type === "content" ? result.result.value[2] : undefined,
    ]);
  }
  expect(original.content[0]).toBe(originalPart);
});

it("does not alter errors, running-like tool results, nonmatching models, or token accounting without a brace", () => {
  const error = Message.tool(
    ToolResultPart.make({
      id: "error",
      name: "tool",
      result: "{error}",
      resultType: "error",
    }),
  );
  const plain = toolMessage("plain");
  const messages = [
    error,
    plain,
    Message.user("user"),
    Message.assistant("assistant"),
  ];
  for (const model of [
    { providerID: "other", id: "google/gemini-3" },
    { providerID: "openrouter", id: "anthropic/claude" },
  ]) {
    expect(guardGeminiToolResults(messages, model, true)).toBe(messages);
  }
  expect(
    guardGeminiToolResults(
      messages,
      { providerID: "openrouter", id: "google/gemini-3" },
      false,
    ),
  ).toBe(messages);
  expect(
    guardGeminiToolResults(
      messages,
      { providerID: "openrouter", id: "google/gemini-3" },
      true,
    )[0],
  ).toBe(error);
  const raw = toolMessage("{schema}");
  const guarded = guardGeminiToolResults(
    [raw],
    { providerID: "openrouter", id: "google/gemini-3" },
    true,
  );
  expect(estimateNativeTokens(estimateMessages(guarded))).toBeGreaterThan(
    estimateNativeTokens(estimateMessages([raw])),
  );
});
