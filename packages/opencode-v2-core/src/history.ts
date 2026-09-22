import {
  MAX_MESSAGE_TEXT_CHARS,
  codePointLength,
} from "@reflection/shared/contracts";
import type { NativeSourceMessage } from "@reflection/shared/native";
import {
  MAX_COMPLETE_TOOL_SOURCE_CHARS,
  modelVisibleToolState,
  modelVisibleMediaTokens,
  modelVisibleToolAttachmentTokens,
  modelVisibleToolInlineDataTokens,
  modelVisibleToolStateSize,
  toolSourceText,
  truncatedToolSourceText,
} from "@reflection/shared/tool-source";

export type NativeMessageType = NativeSourceMessage["type"];

export interface NativeHistoryMessage {
  id: string;
  type: NativeMessageType;
  time: { created: number; completed?: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface NativeCanonicalRecord {
  raw: NativeHistoryMessage;
  source: NativeSourceMessage;
  complete: boolean;
  weightedChars: number;
  /** Losses in the extraction renderer, not mutations of the attached raw record. */
  omissions?: NativeSourceOmission[];
}

export type NativeSourceOmission =
  | "reasoning"
  | "media"
  | "truncated-tool"
  | "tool-context"
  | "truncated-shell";

export class NativeOversizeRecordError extends Error {
  constructor(messageId: string) {
    super(`native source message ${messageId} exceeds the message text limit`);
    this.name = "NativeOversizeRecordError";
  }
}

type NativeRecord = Record<string, unknown>;
const ESTIMATED_CHARS_PER_TOKEN = 4;

function record(value: unknown): NativeRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as NativeRecord)
    : null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function string(value: unknown): value is string {
  return typeof value === "string";
}

function knownType(value: unknown): value is NativeMessageType {
  return (
    value === "user" ||
    value === "assistant" ||
    value === "synthetic" ||
    value === "shell" ||
    value === "skill" ||
    value === "system" ||
    value === "compaction" ||
    value === "idle" ||
    value === "agent-switched" ||
    value === "model-switched" ||
    value === "location-switched"
  );
}

function invalid(message: string): never {
  throw new Error(`invalid native history message: ${message}`);
}

function error(value: unknown): boolean {
  const item = record(value);
  return item !== null && string(item.type) && string(item.message);
}

function model(value: unknown): boolean {
  const item = record(value);
  return item !== null && string(item.providerID) && string(item.id);
}

interface NativeFile {
  mime: string;
  data: string;
  source: { type: "inline" } | { type: "uri"; uri: string };
  name?: string;
  description?: string;
  mention?: { start: number; end: number; text: string };
}

function filesOf(message: NativeHistoryMessage | NativeRecord): NativeFile[] {
  if (message.files === undefined) return [];
  if (!Array.isArray(message.files)) invalid("files must be an array");
  return message.files.map((value: unknown) => {
    const file = record(value);
    if (
      file === null ||
      !string(file.mime) ||
      !string(file.data) ||
      (file.name !== undefined && !string(file.name)) ||
      (file.description !== undefined && !string(file.description))
    )
      invalid("file body");
    const origin = record(file.source);
    if (
      origin === null ||
      (origin.type !== "inline" && origin.type !== "uri") ||
      (origin.type === "uri" && !string(origin.uri))
    ) {
      invalid("file source");
    }
    if (file.mention !== undefined) {
      const mention = record(file.mention);
      if (
        mention === null ||
        !finiteNumber(mention.start) ||
        !finiteNumber(mention.end) ||
        !string(mention.text)
      ) {
        invalid("file mention");
      }
    }
    return file as unknown as NativeFile;
  });
}

// Descriptors are intentionally bounded and sanitized; ordinary source text is
// never passed through this policy. Raw media remains available for restoration.
function descriptor(value: unknown, bounded = true): string {
  if (!string(value)) return "";
  let safe = value;
  if (/\bdata:/iu.test(safe)) safe = "[data URL omitted]";
  else if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(safe)) {
    try {
      const url = new URL(safe);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      safe = url.toString();
    } catch {
      safe = "[invalid URI omitted]";
    }
  }
  return bounded && safe.length > 500
    ? `${safe.slice(0, 480)}[descriptor truncated]`
    : safe;
}

function fileDescriptor(file: NativeFile): string {
  return `\n[Attachment ${JSON.stringify({
    name: descriptor(file.name),
    description: descriptor(file.description),
    mime: descriptor(file.mime),
    source: file.source.type,
    ...(file.source.type === "uri" ? { uri: descriptor(file.source.uri) } : {}),
  })}; binary content omitted]`;
}

function toolContent(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((part) => {
      const item = record(part);
      return (
        item !== null &&
        ((item.type === "text" && string(item.text)) ||
          (item.type === "file" && string(item.uri) && string(item.mime)))
      );
    })
  );
}

function toolState(value: unknown): NativeRecord {
  const state = record(value);
  if (state === null) invalid("assistant tool state");
  if (state.status === "streaming") {
    if (!string(state.input)) invalid("streaming tool state");
  } else if (state.status === "running") {
    if (record(state.input) === null || record(state.metadata) === null) {
      invalid("running tool state");
    }
  } else if (state.status === "completed") {
    if (record(state.input) === null || !toolContent(state.content)) {
      invalid("completed tool state");
    }
  } else if (state.status === "error") {
    if (
      record(state.input) === null ||
      !error(state.error) ||
      (state.content !== undefined && !toolContent(state.content))
    ) {
      invalid("errored tool state");
    }
  } else {
    invalid("unknown assistant tool state");
  }
  return state;
}

function assistantPart(value: unknown): NativeRecord {
  const part = record(value);
  if (part === null) invalid("assistant content part");
  if (part.type === "text" || part.type === "reasoning") {
    if (!string(part.text)) invalid("assistant text part");
    return part;
  }
  if (
    part.type !== "tool" ||
    !string(part.id) ||
    !string(part.name) ||
    record(part.time) === null ||
    !finiteNumber(record(part.time)?.created)
  ) {
    invalid("assistant tool part");
  }
  toolState(part.state);
  return part;
}

function validateNativeHistoryMessage(value: unknown): NativeHistoryMessage {
  const item = record(value);
  if (
    item === null ||
    !string(item.id) ||
    item.id.length === 0 ||
    item.id.length > 500 ||
    !knownType(item.type) ||
    record(item.time) === null ||
    !finiteNumber(record(item.time)?.created)
  ) {
    invalid("id, type, or time");
  }
  switch (item.type) {
    case "user":
    case "synthetic":
    case "system":
      if (!string(item.text)) invalid(`${item.type} text`);
      filesOf(item);
      break;
    case "skill":
      if (!string(item.text) || !string(item.skill) || !string(item.name)) {
        invalid("skill body");
      }
      break;
    case "assistant":
      if (
        !string(item.agent) ||
        !model(item.model) ||
        !Array.isArray(item.content)
      ) {
        invalid("assistant body");
      }
      item.content.forEach(assistantPart);
      break;
    case "shell":
      if (
        !string(item.shellID) ||
        !string(item.command) ||
        !["running", "exited", "timeout", "killed"].includes(
          String(item.status),
        )
      ) {
        invalid("shell body");
      }
      if (
        item.output !== undefined &&
        !string(item.output) &&
        !string(record(item.output)?.output)
      )
        invalid("shell output");
      if (
        item.exit !== undefined &&
        item.exit !== null &&
        !finiteNumber(item.exit)
      )
        invalid("shell exit");
      if (item.error !== undefined && !string(item.error) && !error(item.error))
        invalid("shell error");
      break;
    case "idle":
      if (
        item.outcome !== "succeeded" &&
        item.outcome !== "failed" &&
        item.outcome !== "interrupted"
      ) {
        invalid("idle body");
      }
      break;
    case "agent-switched":
      if (!string(item.agent)) invalid("agent switch");
      break;
    case "model-switched":
      if (!model(item.model)) invalid("model switch");
      break;
    case "location-switched":
      if (!string(record(item.location)?.directory)) invalid("location switch");
      break;
    case "compaction":
      if (
        (item.status !== "running" &&
          item.status !== "completed" &&
          item.status !== "failed") ||
        (item.reason !== "auto" && item.reason !== "manual") ||
        (item.status === "failed"
          ? !error(item.error)
          : !string(item.summary) || !string(item.recent))
      ) {
        invalid("compaction body");
      }
      break;
  }
  return item as NativeHistoryMessage;
}

function projectedToolState(state: NativeRecord): NativeRecord {
  const projected: NativeRecord = { status: state.status };
  for (const key of ["input", "content", "error"] as const) {
    if (state[key] !== undefined) projected[key] = state[key];
  }
  const time = record(state.time);
  if (time !== null && finiteNumber(time.compacted)) {
    projected.time = { compacted: time.compacted };
  }
  return projected;
}

function assistantSourceText(
  message: NativeRecord,
  omissions: Set<NativeSourceOmission>,
): string {
  const content = message.content as unknown[];
  const text = content
    .filter((part) => record(part)?.type === "text")
    .map((part) => record(part)?.text)
    .join("");
  for (const part of content) {
    const item = record(part);
    if (item?.type === "reasoning") omissions.add("reasoning");
    if (item?.type === "tool") {
      const toolContent = record(item.state)?.content;
      if (
        Array.isArray(toolContent) &&
        toolContent.some((entry) => record(entry)?.type === "file")
      )
        omissions.add("media");
      // Even untruncated tool frames use the shared sanitization policy.
      omissions.add("tool-context");
    }
  }
  if (text.length > 0) return text;

  let result = "";
  for (const part of content) {
    const tool = record(part);
    if (tool?.type !== "tool") continue;
    if (!string(tool.name)) invalid("assistant tool name");
    const state = toolState(tool.state);
    const frame = toolSourceText({
      tool: tool.name,
      state: projectedToolState(state),
    });
    if (result.length + frame.length <= MAX_COMPLETE_TOOL_SOURCE_CHARS) {
      result += frame;
      continue;
    }
    result += truncatedToolSourceText(
      { tool: tool.name, state: projectedToolState(state) },
      MAX_COMPLETE_TOOL_SOURCE_CHARS - result.length,
    );
    omissions.add("truncated-tool");
    break;
  }
  return result;
}

function toolPressure(tool: NativeRecord): number {
  if (!string(tool.name)) invalid("assistant tool name");
  const state = projectedToolState(toolState(tool.state));
  const stateSize = modelVisibleToolStateSize(state);
  let pressure = Math.max(
    tool.name.length + stateSize.chars,
    toolSourceText({ tool: tool.name, state }).length,
  );
  pressure +=
    modelVisibleToolAttachmentTokens(state) * ESTIMATED_CHARS_PER_TOKEN;
  pressure +=
    modelVisibleToolInlineDataTokens(state) * ESTIMATED_CHARS_PER_TOKEN;
  const content = state.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const file = record(part);
      if (file?.type !== "file") continue;
      pressure +=
        modelVisibleMediaTokens({ mime: file.mime, url: file.uri }) *
        ESTIMATED_CHARS_PER_TOKEN;
    }
  }
  return pressure;
}

function weightedCharsFor(
  message: NativeHistoryMessage,
  sourceText: string,
): number {
  if (message.type !== "assistant") {
    let weight = codePointLength(sourceText);
    for (const file of filesOf(message)) {
      // Images use the shared resolution-independent reserve. For other
      // inline media, estimate decoded bytes from base64 length without
      // copying/serializing the payload into the sizing path.
      const tokens = file.mime.startsWith("image/")
        ? modelVisibleMediaTokens({ mime: file.mime })
        : Math.max(
            modelVisibleMediaTokens({ mime: "image/png" }),
            Math.ceil((file.data.length * 3) / 8),
          );
      weight += tokens * ESTIMATED_CHARS_PER_TOKEN;
    }
    return weight;
  }
  const content = (message as NativeRecord).content as unknown[];
  return content.reduce<number>((weight, part) => {
    const item = record(part);
    if (item?.type === "text" || item?.type === "reasoning") {
      return weight + codePointLength(item.text as string);
    }
    return item?.type === "tool" ? weight + toolPressure(item) : weight;
  }, 0);
}

function sourceFor(
  message: NativeHistoryMessage,
  omissions: Set<NativeSourceOmission>,
): NativeSourceMessage {
  const raw = message as NativeRecord;
  let text: string;
  switch (message.type) {
    case "assistant":
      text = assistantSourceText(raw, omissions);
      break;
    case "user":
    case "synthetic":
    case "system":
    case "skill": {
      const files = filesOf(raw);
      if (files.length > 0) omissions.add("media");
      if (
        message.type === "user" &&
        Array.isArray(raw.skills) &&
        raw.skills.length > 0
      ) {
        omissions.add("tool-context");
      }
      text = (raw.text as string) + files.map(fileDescriptor).join("");
      break;
    }
    case "shell": {
      const output = string(raw.output)
        ? raw.output
        : (record(raw.output)?.output ?? "");
      text = `[Shell command]\n${raw.command}\n[Shell output]\n${output}\n[Shell status: ${raw.status}${raw.exit == null ? "" : `; exit: ${raw.exit}`}]`;
      if (raw.error !== undefined) {
        const failure = record(raw.error);
        text += `\n[Shell error]\n${string(raw.error) ? raw.error : `${failure?.type}: ${failure?.message}`}`;
      }
      if (record(raw.output)?.truncated === true) {
        text += "\n[Shell output already truncated by source]";
        omissions.add("truncated-shell");
      }
      break;
    }
    case "compaction":
      text =
        `[Machine-generated historical summary; not user-authored; ${raw.status}]\n` +
        (raw.status === "failed"
          ? `${record(raw.error)?.type}: ${record(raw.error)?.message}`
          : `[Summary]\n${raw.summary}\n[Recent historical context]\n${raw.recent}`);
      break;
    case "agent-switched":
      text = `[Agent switched] ${JSON.stringify(modelVisibleToolState({ agent: raw.agent }))}`;
      break;
    case "model-switched": {
      const selected = record(raw.model)!;
      text = `[Model switched] ${JSON.stringify(modelVisibleToolState({ providerID: selected.providerID, id: selected.id, ...(string(selected.variant) ? { variant: selected.variant } : {}) }))}`;
      break;
    }
    case "location-switched":
      text = `[Location switched] ${JSON.stringify({ directory: descriptor(record(raw.location)?.directory, false) })}`;
      break;
    case "idle":
      text = "";
      break;
  }
  return { id: message.id, type: message.type, text };
}

function complete(message: NativeHistoryMessage): boolean {
  const raw = message as NativeRecord;
  if (message.type === "assistant") {
    const completed = record(raw.time)?.completed;
    if (!finiteNumber(completed)) return false;
    return !(raw.content as unknown[]).some((part) => {
      const state = record(record(part)?.state);
      return state?.status === "running" || state?.status === "streaming";
    });
  }
  if (message.type === "shell") {
    return ["exited", "timeout", "killed"].includes(String(raw.status));
  }
  if (message.type === "compaction") {
    return raw.status === "completed" || raw.status === "failed";
  }
  return true;
}

/**
 * Validates and renders the v2 transcript in the API's supplied sequence.
 * Assistant tool frames are generated internal context, never user-authored
 * text; they remain typed as the originating assistant source message.
 */
export function canonicalizeNativeHistory(
  history: unknown[],
): NativeCanonicalRecord[] {
  const ids = new Set<string>();
  return history.map((value) => {
    const raw = validateNativeHistoryMessage(value);
    if (ids.has(raw.id)) invalid(`duplicate id ${raw.id}`);
    ids.add(raw.id);
    const omissions = new Set<NativeSourceOmission>();
    const source = sourceFor(raw, omissions);
    if (codePointLength(source.text) > MAX_MESSAGE_TEXT_CHARS) {
      throw new NativeOversizeRecordError(raw.id);
    }
    return {
      raw,
      source,
      complete: complete(raw),
      // This deliberately measures original model-visible pressure rather
      // than source text. Tool-only source may carry an explicit bounded
      // fallback marker while its raw tool/media payload still drives packing.
      weightedChars: weightedCharsFor(raw, source.text),
      ...(omissions.size > 0 ? { omissions: [...omissions] } : {}),
    };
  });
}
