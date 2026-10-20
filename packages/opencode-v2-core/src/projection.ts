export class NativeProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeProjectionError";
  }
}

/** The 70%/75% context policy, bounded by a smaller model input limit and
 * the actual output cap selected for this request. Shared with the final
 * materialized-request guard so planning and dispatch cannot disagree.
 */
export function nativeInputBudget(
  contextLimit: number,
  inputLimit: number | undefined,
  outputLimit: number,
): { soft: number; hard: number } {
  const input = inputLimit ?? contextLimit;
  if (
    ![contextLimit, input, outputLimit].every(Number.isFinite) ||
    contextLimit <= 0 ||
    input <= 0 ||
    outputLimit < 0
  )
    throw new NativeProjectionError("invalid model limits");
  const usable = Math.min(input, contextLimit - outputLimit);
  if (usable <= 0) throw new NativeProjectionError("no usable input budget");
  const hard = Math.min(Math.floor(contextLimit * 0.75), usable);
  return {
    hard,
    // Preserve a projection buffer even when a smaller model input limit
    // lowers the hard ceiling below 70% of the context window.
    soft: Math.min(
      Math.floor(contextLimit * 0.7),
      Math.floor((hard * 14) / 15),
    ),
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Conservative tokenizer-independent estimate: UTF-8 and lexical pressure,
 * structural framing, and explicit media reserves. Not a provider token count.
 * Opaque binary/cyclic/non-JSON content requires a plugin-specific media policy.
 */
export function estimateNativeTokens(value: unknown): number {
  const visiting = new Set<object>();
  function visit(item: unknown): number {
    if (item == null) return 0;
    if (typeof item === "string") {
      return Math.max(
        Math.ceil(Buffer.byteLength(item, "utf8") / 3),
        (item.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? []).length,
      );
    }
    if (typeof item === "number" || typeof item === "boolean") return 2;
    if (
      typeof item !== "object" ||
      visiting.has(item) ||
      ArrayBuffer.isView(item) ||
      item instanceof ArrayBuffer
    ) {
      throw new NativeProjectionError(
        "opaque or cyclic model payload requires an explicit media policy",
      );
    }
    visiting.add(item);
    let total = 2;
    if (Array.isArray(item)) {
      for (const part of item) total += visit(part) + 2;
    } else {
      const fields = object(item)!;
      if (
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      ) {
        throw new NativeProjectionError(
          "non-JSON model content requires an explicit estimation policy",
        );
      }
      const type = fields.type;
      if (type === "image" || type === "image_url") total += 4096;
      if (
        type === "file" ||
        type === "audio" ||
        type === "video" ||
        type === "input_audio"
      ) {
        throw new NativeProjectionError(
          "unbounded file/audio/video requires an explicit media policy",
        );
      }
      for (const [key, child] of Object.entries(fields))
        total += visit(key) + visit(child) + 2;
    }
    visiting.delete(item);
    return total;
  }
  return visit(value);
}
