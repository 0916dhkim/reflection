const MEDIA_TOKEN_RESERVE = 8_000;
const MEDIA_BYTES_PER_TOKEN = 2;
export const TOOL_SOURCE_CHAR_LIMIT = 20_000;
const TOOL_SOURCE_TRUNCATION = "\n[Tool activity truncated]";
const TOOL_STATE_OMITTED = "[Tool state omitted: exceeds fallback budget]";
export const MAX_COMPLETE_TOOL_SOURCE_CHARS =
  TOOL_SOURCE_CHAR_LIMIT - TOOL_SOURCE_TRUNCATION.length;
export const SANITIZED_TOOL_OBJECT_KEY = "[Sanitized tool object]";
const CANONICAL_TOOL_BLOCK_PATTERN =
  /\n\[Tool ("(?:[^"\\\r\n]|\\.)*")\]\n([^\r\n]*)\n\[\/Tool\]\n/gu;

export interface ToolPart {
  readonly tool?: string;
  readonly state?: unknown;
}

export interface CanonicalToolFallbackBlock {
  start: number;
  end: number;
  name: string;
  state: unknown;
}

function containsDataUrl(value: string): boolean {
  return /(?:^|[^a-z0-9+.-])data:/iu.test(value);
}

function toolSourceFrame(part: ToolPart, visibleState: unknown): string {
  let state: string;
  try {
    state = JSON.stringify(visibleState) ?? "null";
  } catch {
    state = '"[tool state unavailable]"';
  }
  let rawName = "unknown";
  try {
    if (typeof part.tool === "string") rawName = part.tool;
  } catch {}
  const sanitizedName = containsDataUrl(rawName)
    ? "[data URL omitted]"
    : rawName;
  const name = JSON.stringify(sanitizedName.slice(0, 500));
  return `\n[Tool ${name}]\n${state}\n[/Tool]\n`;
}

export function toolSourceText(part: ToolPart): string {
  try {
    return toolSourceFrame(part, modelVisibleToolState(part.state));
  } catch {
    return toolSourceFrame(part, "[tool state unavailable]");
  }
}

export function truncatedToolSourceText(
  part: ToolPart,
  remainingChars: number,
): string {
  const omitted = toolSourceFrame(part, TOOL_STATE_OMITTED);
  return `${omitted.length <= remainingChars ? omitted : ""}${TOOL_SOURCE_TRUNCATION}`;
}

function legacyDataUrlKeyWitness(
  lower: string | null,
  upper: string | null,
): string | null {
  const candidates = new Set(["\0data:", " data:", "data:"]);
  if (lower !== null) {
    candidates.add(`${lower}\0data:`);
    candidates.add(`${lower} data:`);
  }
  return (
    [...candidates]
      .filter(
        (candidate) =>
          containsDataUrl(candidate) &&
          (lower === null || lower < candidate) &&
          (upper === null || candidate < upper),
      )
      .sort()[0] ?? null
  );
}

function hasCanonicalObjectKeyOrder(
  entries: ReadonlyArray<[string, unknown]>,
): boolean {
  const canonicalKeys = Object.keys(
    Object.fromEntries(
      entries
        .map(([key]) => key)
        .sort()
        .map((key) => [key, null]),
    ),
  );
  return entries.every(([key], index) => canonicalKeys[index] === key);
}

function isLegacyCanonicalModelValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return value === "[nested value omitted]";
  if (typeof value === "string") return !containsDataUrl(value);
  if (Array.isArray(value)) {
    return value.every((item) => isLegacyCanonicalModelValue(item, depth + 1));
  }
  if (typeof value !== "object" || value === null) return true;
  const entries = Object.entries(value);
  if (
    entries.some(
      ([key, item]) =>
        containsDataUrl(key) || !isLegacyCanonicalModelValue(item, depth + 1),
    )
  ) {
    return false;
  }
  if (hasCanonicalObjectKeyOrder(entries)) {
    return true;
  }

  // Legacy renderers sorted source keys before replacing data-URL keys. A
  // replacement could therefore move out of lexical order or collide with a
  // literal placeholder. Check each placeholder against the neighboring
  // ordinary keys without enumerating every literal/redacted classification.
  const placeholderPattern = /^\[data URL key omitted (0|[1-9]\d*)\]$/u;
  const nonIndexEntries = entries.filter(
    ([key]) => !/^(?:0|[1-9]\d*)$/u.test(key),
  );
  const ordinaryEntries = nonIndexEntries.filter(
    ([key]) => !placeholderPattern.test(key),
  );
  const ordinarySourceKeys = entries
    .map(([key]) => key)
    .filter((key) => !placeholderPattern.test(key))
    .sort();
  if (
    ordinaryEntries.some(
      ([key], index) => index > 0 && ordinaryEntries[index - 1]![0] >= key,
    )
  ) {
    return false;
  }
  const placeholderCount = nonIndexEntries.length - ordinaryEntries.length;
  const lowerOrdinaryKeys: Array<string | undefined> = [];
  let lowerOrdinaryKey: string | undefined;
  for (const [key] of nonIndexEntries) {
    lowerOrdinaryKeys.push(lowerOrdinaryKey);
    if (!placeholderPattern.test(key)) lowerOrdinaryKey = key;
  }
  const upperOrdinaryKeys: Array<string | undefined> = [];
  let upperOrdinaryKey: string | undefined;
  for (let index = nonIndexEntries.length - 1; index >= 0; index -= 1) {
    upperOrdinaryKeys[index] = upperOrdinaryKey;
    const key = nonIndexEntries[index]![0];
    if (!placeholderPattern.test(key)) upperOrdinaryKey = key;
  }
  let plausibleRedaction = false;
  for (const [entryIndex, [key]] of nonIndexEntries.entries()) {
    const match = placeholderPattern.exec(key);
    if (match === null) continue;
    const lower = lowerOrdinaryKeys[entryIndex];
    const upper = upperOrdinaryKeys[entryIndex];
    const literalPlacement =
      (lower === undefined || lower < key) &&
      (upper === undefined || key < upper);
    const claimedIndex = Number(match[1]);
    const witness = legacyDataUrlKeyWitness(lower ?? null, upper ?? null);
    let ordinaryKeysBeforeWitness = 0;
    if (witness === null) {
      ordinaryKeysBeforeWitness = Number.POSITIVE_INFINITY;
    } else {
      let high = ordinarySourceKeys.length;
      while (ordinaryKeysBeforeWitness < high) {
        const middle = Math.floor((ordinaryKeysBeforeWitness + high) / 2);
        if (ordinarySourceKeys[middle]! < witness) {
          ordinaryKeysBeforeWitness = middle + 1;
        } else {
          high = middle;
        }
      }
    }
    const redactedPlacement =
      claimedIndex < entries.length + placeholderCount &&
      claimedIndex >= ordinaryKeysBeforeWitness;
    if (!literalPlacement && !redactedPlacement) return false;
    plausibleRedaction ||= redactedPlacement;
  }
  return plausibleRedaction;
}

function isCurrentCanonicalModelValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return value === "[nested value omitted]";
  if (typeof value === "string") return !containsDataUrl(value);
  if (Array.isArray(value)) {
    return value.every((item) => isCurrentCanonicalModelValue(item, depth + 1));
  }
  if (typeof value !== "object" || value === null) return true;

  const entries = Object.entries(value);
  if (entries.some(([key]) => containsDataUrl(key))) return false;
  if (
    entries.length === 1 &&
    entries[0]![0] === SANITIZED_TOOL_OBJECT_KEY &&
    Array.isArray(entries[0]![1])
  ) {
    const encodedEntries = entries[0]![1];
    let hasRedactedKey = false;
    for (const [index, encodedEntry] of encodedEntries.entries()) {
      if (
        !Array.isArray(encodedEntry) ||
        encodedEntry.length !== 2 ||
        typeof encodedEntry[0] !== "string" ||
        containsDataUrl(encodedEntry[0]) ||
        !isCurrentCanonicalModelValue(encodedEntry[1], depth + 1)
      ) {
        return false;
      }
      hasRedactedKey ||= encodedEntry[0] === `[data URL key omitted ${index}]`;
    }
    if (hasRedactedKey) return true;
  }

  return (
    hasCanonicalObjectKeyOrder(entries) &&
    entries.every(([, item]) => isCurrentCanonicalModelValue(item, depth + 1))
  );
}

function isLegacyCanonicalToolState(state: unknown): boolean {
  const visibleState = modelVisibleToolStateValue(state);
  return (
    JSON.stringify(visibleState) === JSON.stringify(state) &&
    isLegacyCanonicalModelValue(visibleState)
  );
}

function isCurrentCanonicalToolState(state: unknown): boolean {
  const visibleState = modelVisibleToolStateValue(state);
  return (
    JSON.stringify(visibleState) === JSON.stringify(state) &&
    isCurrentCanonicalModelValue(visibleState)
  );
}

export function canonicalToolFallbackFrames(
  text: string,
): CanonicalToolFallbackBlock[] {
  const blocks: CanonicalToolFallbackBlock[] = [];
  for (const match of text.matchAll(CANONICAL_TOOL_BLOCK_PATTERN)) {
    const encodedName = match[1]!;
    const encodedState = match[2]!;
    try {
      const name: unknown = JSON.parse(encodedName);
      const state: unknown = JSON.parse(encodedState);
      if (
        typeof name === "string" &&
        JSON.stringify(name) === encodedName &&
        name.length <= 500 &&
        !containsDataUrl(name) &&
        JSON.stringify(state) === encodedState &&
        (isCurrentCanonicalToolState(state) ||
          isLegacyCanonicalToolState(state))
      ) {
        blocks.push({
          start: match.index,
          end: match.index + match[0].length,
          name,
          state,
        });
      }
    } catch {}
  }
  return blocks;
}

export function toolFallbackFrameRanges(
  text: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const opening = "\n[Tool ";
  const closing = "\n[/Tool]\n";
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(opening, cursor);
    if (start < 0) break;
    const closingStart = text.indexOf(closing, start + opening.length);
    const end = closingStart < 0 ? text.length : closingStart + closing.length;
    ranges.push({ start, end });
    cursor = end;
  }
  return ranges;
}

export function canonicalToolFallbackBlocks(
  text: string,
): CanonicalToolFallbackBlock[] {
  return canonicalToolFallbackFrames(text).filter(
    (block) => block.end - block.start <= MAX_COMPLETE_TOOL_SOURCE_CHARS,
  );
}

function sanitizeModelValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[nested value omitted]";
  if (typeof value === "string") {
    return containsDataUrl(value) ? "[data URL omitted]" : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeModelValue(item, depth + 1));
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return "[non-JSON value omitted]";
  }
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (!entries.some(([key]) => containsDataUrl(key))) {
    return Object.fromEntries(
      entries.map(([key, item]) => [key, sanitizeModelValue(item, depth + 1)]),
    );
  }
  return {
    [SANITIZED_TOOL_OBJECT_KEY]: entries.map(([key, item], index) => [
      containsDataUrl(key) ? `[data URL key omitted ${index}]` : key,
      sanitizeModelValue(item, depth + 1),
    ]),
  };
}

export function modelVisibleToolState(value: unknown): unknown {
  return sanitizeModelValue(modelVisibleToolStateValue(value));
}

function modelVisibleToolStateValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const state = value as Record<string, unknown>;
  const time =
    typeof state.time === "object" && state.time !== null
      ? (state.time as Record<string, unknown>)
      : {};
  return typeof time.compacted === "number"
    ? { ...state, output: "[Old tool result content cleared]" }
    : state;
}

/**
 * Tool state keys that never reach the provider. `attachments` are measured
 * separately as media, and `metadata` holds host-side bookkeeping such as
 * diffs and file snapshots, which a tool may populate far beyond the size of
 * anything the model sees. Counting either here would size a request by
 * content that is not in it.
 */
const UNSENT_TOOL_STATE_KEYS = new Set(["attachments", "metadata"]);

export function modelVisibleToolStateSize(value: unknown): {
  chars: number;
  utf8Bytes: number;
} {
  try {
    const visible = modelVisibleToolStateValue(value);
    const seen = new WeakSet<object>();
    const serialized =
      JSON.stringify(visible, function (key, item: unknown) {
        if (this === visible && UNSENT_TOOL_STATE_KEYS.has(key)) {
          return undefined;
        }
        if (typeof item === "string" && item.startsWith("data:")) {
          return "[data URL omitted]";
        }
        if (typeof item === "object" && item !== null) {
          if (seen.has(item)) throw new Error("cyclic tool state");
          seen.add(item);
        }
        return item;
      }) ?? "null";
    return {
      chars: serialized.length,
      utf8Bytes: Buffer.byteLength(serialized, "utf8"),
    };
  } catch {
    return {
      chars: Number.POSITIVE_INFINITY,
      utf8Bytes: Number.POSITIVE_INFINITY,
    };
  }
}

function dataUrlBytes(url: string): number | null {
  if (!url.startsWith("data:")) return null;
  const separator = url.indexOf(",");
  if (separator < 0) return null;
  const metadata = url.slice(0, separator);
  const payload = url.slice(separator + 1);
  return metadata.endsWith(";base64")
    ? Math.ceil((payload.length * 3) / 4)
    : Buffer.byteLength(payload, "utf8");
}

export function modelVisibleMediaTokens(value: unknown): number {
  if (typeof value !== "object" || value === null)
    return Number.POSITIVE_INFINITY;
  const media = value as Record<string, unknown>;
  const mime = typeof media.mime === "string" ? media.mime : "";
  if (mime.startsWith("image/")) return MEDIA_TOKEN_RESERVE;
  if (typeof media.url !== "string") return Number.POSITIVE_INFINITY;
  const bytes = dataUrlBytes(media.url);
  return bytes === null
    ? Number.POSITIVE_INFINITY
    : Math.max(MEDIA_TOKEN_RESERVE, Math.ceil(bytes / MEDIA_BYTES_PER_TOKEN));
}

function toolAttachmentTokens(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  const state = value as Record<string, unknown>;
  const time =
    typeof state.time === "object" && state.time !== null
      ? (state.time as Record<string, unknown>)
      : {};
  if (
    state.status !== "completed" ||
    typeof time.compacted === "number" ||
    !Array.isArray(state.attachments)
  ) {
    return 0;
  }
  return state.attachments.reduce((total, attachment) => {
    if (typeof attachment !== "object" || attachment === null) return total;
    const item = attachment as Record<string, unknown>;
    const mime = typeof item.mime === "string" ? item.mime : "";
    const url = typeof item.url === "string" ? item.url : "";
    const validDataUrl = url.startsWith("data:") && url.includes(",");
    const hostMedia = mime.startsWith("image/") || mime === "application/pdf";
    return (
      total +
      (validDataUrl || (hostMedia && url.length > 0)
        ? modelVisibleMediaTokens(item)
        : 0)
    );
  }, 0);
}

export function modelVisibleToolAttachmentTokens(value: unknown): number {
  try {
    return toolAttachmentTokens(value);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function inlineDataUrlTokens(value: unknown): number {
  const pending: Array<{ value: unknown; root: boolean }> = [
    { value, root: true },
  ];
  const seen = new WeakSet<object>();
  let total = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (typeof current.value === "string") {
      if (!current.value.startsWith("data:")) continue;
      const bytes = dataUrlBytes(current.value);
      if (bytes === null) return Number.POSITIVE_INFINITY;
      total += Math.max(
        MEDIA_TOKEN_RESERVE,
        Math.ceil(bytes / MEDIA_BYTES_PER_TOKEN),
      );
      continue;
    }
    if (typeof current.value !== "object" || current.value === null) continue;
    if (seen.has(current.value)) return Number.POSITIVE_INFINITY;
    seen.add(current.value);
    for (const [key, item] of Object.entries(current.value)) {
      if (current.root && key === "attachments") continue;
      pending.push({ value: item, root: false });
    }
  }
  return total;
}

export function modelVisibleToolInlineDataTokens(value: unknown): number {
  try {
    if (typeof value !== "object" || value === null) {
      return inlineDataUrlTokens(value);
    }
    return inlineDataUrlTokens(modelVisibleToolStateValue(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
