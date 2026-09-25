import { constants, type BigIntStats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import {
  SystemPart,
  type Message,
  type SystemPart as SystemPartValue,
  type ToolResultPart,
} from "@opencode/ai";

const MAX_INSTRUCTION_FILES = 32;
const MAX_INSTRUCTION_BYTES = 256 * 1024;
const MAX_TOTAL_INSTRUCTION_BYTES = 1024 * 1024;
const MAX_PROVIDER_NAME_LENGTH = 200;
const MAX_MODEL_ID_LENGTH = 500;
const MAX_ALLOWLIST_PROVIDERS = 256;
const MAX_MODELS_PER_PROVIDER = 10_000;
const MAX_ALLOWLIST_MODELS = 20_000;

const POLICY_ERROR = "Invalid user policy";
const INSTRUCTION_ERROR = "Unable to read user instruction files";

export interface UserPolicy {
  readonly version: 1;
  readonly instructionFiles: readonly string[];
  readonly modelAllowlists: Readonly<Record<string, readonly string[]>>;
  readonly geminiOpenRouterToolGuard: boolean;
}

export interface NativeModel {
  readonly providerID: string;
  readonly id: string;
}

export interface NativeModelEditor {
  list(): readonly NativeModel[];
  update(
    providerID: string,
    modelID: string,
    update: (model: { enabled: boolean }) => void,
  ): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function policyError(): never {
  throw new Error(POLICY_ERROR);
}

function instructionError(): never {
  throw new Error(INSTRUCTION_ERROR);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && own.every((key) => keys.includes(key));
}

function modelIDs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_MODELS_PER_PROVIDER) {
    return policyError();
  }
  for (const id of value) {
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > MAX_MODEL_ID_LENGTH ||
      id.includes("\0") ||
      id.trim().length === 0
    ) {
      return policyError();
    }
  }
  return value;
}

export function parseUserPolicy(value: unknown): UserPolicy {
  try {
    if (
      !isPlainObject(value) ||
      !exactKeys(value, [
        "version",
        "instructionFiles",
        "modelAllowlists",
        "geminiOpenRouterToolGuard",
      ])
    ) {
      return policyError();
    }
    if (
      value.version !== 1 ||
      typeof value.geminiOpenRouterToolGuard !== "boolean"
    ) {
      return policyError();
    }
    if (
      !Array.isArray(value.instructionFiles) ||
      value.instructionFiles.length > MAX_INSTRUCTION_FILES
    ) {
      return policyError();
    }
    const instructionFiles: string[] = [];
    const knownFiles = new Set<string>();
    for (const path of value.instructionFiles) {
      if (
        typeof path !== "string" ||
        path.includes("\0") ||
        path.includes("://") ||
        /[*?[\]{}]/u.test(path) ||
        !isAbsolute(path)
      ) {
        return policyError();
      }
      const normalized = resolve(path);
      if (!knownFiles.has(normalized)) {
        knownFiles.add(normalized);
        instructionFiles.push(normalized);
      }
    }
    if (
      !isPlainObject(value.modelAllowlists) ||
      Object.keys(value.modelAllowlists).length > MAX_ALLOWLIST_PROVIDERS
    ) {
      return policyError();
    }
    let totalModels = 0;
    const modelAllowlists: Record<string, readonly string[]> =
      Object.create(null);
    for (const [providerID, configuredModels] of Object.entries(
      value.modelAllowlists,
    )) {
      if (
        providerID.length === 0 ||
        providerID.length > MAX_PROVIDER_NAME_LENGTH ||
        providerID.includes("\0") ||
        providerID.trim().length === 0
      ) {
        return policyError();
      }
      const models = modelIDs(configuredModels);
      totalModels += models.length;
      if (totalModels > MAX_ALLOWLIST_MODELS) {
        return policyError();
      }
      modelAllowlists[providerID] = Object.freeze([...models]);
    }
    return Object.freeze({
      version: 1 as const,
      instructionFiles: Object.freeze(instructionFiles),
      modelAllowlists: Object.freeze(modelAllowlists),
      geminiOpenRouterToolGuard: value.geminiOpenRouterToolGuard,
    });
  } catch {
    return policyError();
  }
}

export function isUserModelAllowed(
  policy: UserPolicy,
  model: NativeModel,
): boolean {
  const allowlist = policy.modelAllowlists[model.providerID];
  return allowlist === undefined || allowlist.includes(model.id);
}

export function applyModelAllowlist(
  policy: UserPolicy,
  editor: NativeModelEditor,
): void {
  for (const model of editor.list()) {
    if (!isUserModelAllowed(policy, model)) {
      editor.update(model.providerID, model.id, (draft) => {
        draft.enabled = false;
      });
    }
  }
}

interface FileSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly size: bigint;
}

interface ReadInstruction {
  readonly path: string;
  readonly snapshot: FileSnapshot;
  readonly text: string;
  readonly bytes: number;
}

function snapshot(value: BigIntStats): FileSnapshot | undefined {
  if (
    !value.isFile() ||
    value.size < 0n ||
    value.size > BigInt(MAX_INSTRUCTION_BYTES)
  ) {
    return undefined;
  }
  return {
    dev: value.dev,
    ino: value.ino,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
    size: value.size,
  };
}

function sameSnapshot(
  left: FileSnapshot | undefined,
  right: FileSnapshot | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.size === right.size
  );
}

function checkSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    instructionError();
  }
}

async function pathSnapshot(path: string): Promise<FileSnapshot> {
  const value = snapshot(await stat(path, { bigint: true }));
  if (value === undefined) {
    instructionError();
  }
  return value;
}

async function readInstructionFile(
  path: string,
  signal: AbortSignal | undefined,
): Promise<ReadInstruction> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    checkSignal(signal);
    const beforePath = await pathSnapshot(path);
    checkSignal(signal);
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const beforeFile = snapshot(await handle.stat({ bigint: true }));
    const afterOpenPath = await pathSnapshot(path);
    if (
      !sameSnapshot(beforePath, beforeFile) ||
      !sameSnapshot(beforePath, afterOpenPath)
    ) {
      instructionError();
    }
    const bytes = Buffer.alloc(Number(beforePath.size));
    let offset = 0;
    while (offset < bytes.length) {
      checkSignal(signal);
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) {
        instructionError();
      }
      offset += bytesRead;
    }
    checkSignal(signal);
    const afterFile = snapshot(await handle.stat({ bigint: true }));
    const afterPath = await pathSnapshot(path);
    if (
      !sameSnapshot(beforePath, afterFile) ||
      !sameSnapshot(beforePath, afterPath)
    ) {
      instructionError();
    }
    return {
      path,
      snapshot: beforePath,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      ),
      bytes: bytes.length,
    };
  } catch {
    return instructionError();
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readUserInstructionParts(
  policy: UserPolicy,
  signal?: AbortSignal,
): Promise<SystemPartValue[]> {
  try {
    let totalBytes = 0;
    const instructions: ReadInstruction[] = [];
    for (const path of policy.instructionFiles) {
      checkSignal(signal);
      const instruction = await readInstructionFile(path, signal);
      totalBytes += instruction.bytes;
      if (totalBytes > MAX_TOTAL_INSTRUCTION_BYTES) {
        instructionError();
      }
      instructions.push(instruction);
    }
    checkSignal(signal);
    for (const instruction of instructions) {
      if (
        !sameSnapshot(
          instruction.snapshot,
          await pathSnapshot(instruction.path),
        )
      ) {
        instructionError();
      }
    }
    checkSignal(signal);
    return instructions.map((instruction) =>
      SystemPart.make(
        `Instructions from: ${instruction.path}\n${instruction.text}`,
      ),
    );
  } catch {
    return instructionError();
  }
}

/** Usage continuity is keyed by configured file provenance, not by text that
 * merely resembles an instruction. Only these two policy-loaded files may
 * change contents without invalidating the previous provider usage. */
export function instructionUsageIdentity(
  policy: UserPolicy,
  parts: readonly SystemPartValue[],
): readonly SystemPartValue[] {
  // If the read result cannot be paired with the configured paths, retain the
  // entire real payload in the identity rather than exempting unknown content.
  if (parts.length !== policy.instructionFiles.length) return parts;
  return parts.map((part, index) => {
    const path = policy.instructionFiles[index]!;
    const name = basename(path);
    return name === "MEMORY.md" || name === "USER.md"
      ? SystemPart.make(
          `Instructions from: ${path}\n[usage identity: policy file contents]`,
        )
      : part;
  });
}

const guardedToolResults = new WeakSet<object>();
type ToolContentItem = Extract<
  ToolResultPart["result"],
  { readonly type: "content" }
>["value"][number];

function guardToolResult(
  part: Message["content"][number],
): Message["content"][number] {
  if (part.type !== "tool-result" || guardedToolResults.has(part)) {
    return part;
  }
  if (
    part.result.type === "text" &&
    typeof part.result.value === "string" &&
    part.result.value.includes("{")
  ) {
    const guarded = {
      ...part,
      result: { ...part.result, value: JSON.stringify(part.result.value) },
    };
    guardedToolResults.add(guarded);
    return guarded;
  }
  if (part.result.type !== "content") {
    return part;
  }
  const text = part.result.value.filter((item) => item.type === "text");
  const aggregate = text.map((item) => item.text).join("\n");
  if (text.length === 0 || !aggregate.includes("{")) {
    return part;
  }
  let replaced = false;
  const content: ToolContentItem[] = [];
  for (const item of part.result.value) {
    if (item.type === "file") {
      content.push(item);
      continue;
    }
    if (replaced) {
      continue;
    }
    replaced = true;
    content.push({ ...item, text: JSON.stringify(aggregate) });
  }
  const guarded = {
    ...part,
    result: { ...part.result, value: content },
  };
  guardedToolResults.add(guarded);
  return guarded;
}

export function guardGeminiToolResults(
  messages: readonly Message[],
  model: NativeModel,
  enabled: boolean,
): Message[] | readonly Message[] {
  if (
    !enabled ||
    model.providerID !== "openrouter" ||
    !model.id.startsWith("google/")
  ) {
    return messages;
  }
  let changed = false;
  const guarded = messages.map((message) => {
    let messageChanged = false;
    const content = message.content.map((part) => {
      const result = guardToolResult(part);
      if (result !== part) {
        messageChanged = true;
      }
      return result;
    });
    if (!messageChanged) {
      return message;
    }
    changed = true;
    const descriptors = {
      ...Object.getOwnPropertyDescriptors(message),
      content: {
        ...Object.getOwnPropertyDescriptor(message, "content")!,
        value: content,
      },
    };
    const copy: Message = Object.create(
      Object.getPrototypeOf(message),
      descriptors,
    );
    for (const [index, part] of content.entries()) {
      if (part !== message.content[index]) {
        guardedToolResults.add(copy.content[index]!);
      }
    }
    return copy;
  });
  return changed ? guarded : messages;
}
