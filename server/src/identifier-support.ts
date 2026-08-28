import {
  codePointLength,
  type SegmentCreate,
} from "@reflection/shared/contracts";
import {
  canonicalToolFallbackFrames,
  MAX_COMPLETE_TOOL_SOURCE_CHARS,
  SANITIZED_TOOL_OBJECT_KEY,
  toolFallbackFrameRanges,
} from "@reflection/shared/tool-source";
import {
  addIdentifierSkeletons,
  analyzeIdentifier,
  compareIdentifierTokenSpans,
  cooperativeCopiedSourceTokenSpans,
  cooperativeIdentifierBangTokenSpans,
  cooperativelySortIdentifierTokenSpans,
  consumeSourceIdentifierUnit,
  copiedSourceTokenSpans,
  identifierBangTokenSpans,
  identifierSkeleton,
  IDENTIFIER_WORD_PATTERN,
  SOURCE_URI_PATTERN,
  type IdentifierTokenSpan,
  type SourceIdentifierBudget,
} from "./identifier-lexing.js";
import type {
  IdentifierPatternIndex,
  IdentifierPatternNode,
} from "./identifier-matching.js";
import {
  IDENTIFIER_VALIDATION_CHECK_INTERVAL,
  type CooperativeScheduler,
} from "./identifier-validation-scheduler.js";

const MAX_PLAIN_SKELETON_OCCURRENCES = 10_000;
const MAX_SOURCE_IDENTIFIER_CANDIDATES = 175_000;
const MAX_SOURCE_PLAIN_SCAN_UNITS = 275_000;
const STRUCTURED_TOOL_STATE_KEYS = new Set([
  "attachments",
  "error",
  "input",
  "metadata",
  "output",
  "raw",
  "status",
  "time",
  "title",
]);

interface SourceTextAnalysis {
  text: string;
  identifierSpans: readonly IdentifierTokenSpan[];
}

export interface IdentifierSupport {
  exact: ReadonlySet<string>;
  pathSegments: ReadonlySet<string>;
  pathSegmentSequences: readonly (readonly string[])[];
  index: IdentifierPatternIndex;
  oversizedTokens: readonly string[];
  structuredToolKeys: ReadonlySet<string>;
  structuredToolKeyTranspositions: ReadonlySet<string>;
  plainSkeletonCounts: ReadonlyMap<string, number>;
  boundedExactMatches: Map<string, boolean>;
  sourceTexts: readonly {
    text: string;
    identifierSpans: readonly IdentifierTokenSpan[];
  }[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function identifierSkeletons(
  exact: ReadonlySet<string>,
  scheduler: CooperativeScheduler,
): Promise<Set<string>> {
  const skeletons = new Set<string>();
  for (const token of exact) {
    if (scheduler.shouldYield()) await scheduler.yield();
    const analysis = analyzeIdentifier(token);
    if (analysis.oversized) continue;
    if (analysis.components.length <= 1) {
      addIdentifierSkeletons(skeletons, token);
    } else {
      for (const component of analysis.components) {
        if (codePointLength(component) >= 2) skeletons.add(component);
      }
      if (token.startsWith(".") && analysis.skeleton !== null) {
        skeletons.add(`dot${analysis.skeleton}`);
      }
      if (token.endsWith("++") && analysis.skeleton !== null) {
        skeletons.add(`${analysis.skeleton}plusplus`);
      }
      if (token.endsWith("#") && analysis.skeleton !== null) {
        skeletons.add(`${analysis.skeleton}sharp`);
      }
    }
  }
  return skeletons;
}

async function plainSourceSkeletons(
  sourceTexts: readonly SourceTextAnalysis[],
  relevantSkeletons: ReadonlySet<string>,
  scheduler: CooperativeScheduler,
  sourceBudget?: SourceIdentifierBudget,
): Promise<Map<string, number>> {
  const skeletons = new Map<string, number>();
  const analyzedTexts: Array<{
    text: string;
    words: Array<{ start: number; end: number; value: string }>;
  }> = [];
  for (const source of sourceTexts) {
    if (scheduler.shouldYield(IDENTIFIER_VALIDATION_CHECK_INTERVAL)) {
      await scheduler.yield();
    }
    for (const _span of source.identifierSpans) {
      consumeSourceIdentifierUnit(sourceBudget);
    }
    const words: Array<{
      start: number;
      end: number;
      value: string;
    }> = [];
    let spanIndex = 0;
    for (const match of source.text.matchAll(IDENTIFIER_WORD_PATTERN)) {
      if (scheduler.shouldYield()) await scheduler.yield();
      consumeSourceIdentifierUnit(sourceBudget);
      const start = match.index;
      const end = start + match[0].length;
      while (
        source.identifierSpans[spanIndex] !== undefined &&
        source.identifierSpans[spanIndex]!.end <= start
      ) {
        spanIndex += 1;
      }
      const containingSpan = source.identifierSpans[spanIndex];
      if (
        containingSpan !== undefined &&
        containingSpan.start <= start &&
        containingSpan.end >= end
      ) {
        continue;
      }
      const value = identifierSkeleton(match[0]);
      if (value !== null) words.push({ start, end, value });
    }
    analyzedTexts.push({ text: source.text, words });
  }

  let hasPlainPhrase = false;
  for (const { text, words } of analyzedTexts) {
    for (const word of words) {
      if (scheduler.shouldYield()) await scheduler.yield();
      skeletons.set(
        word.value,
        Math.min(
          (skeletons.get(word.value) ?? 0) + 1,
          MAX_PLAIN_SKELETON_OCCURRENCES,
        ),
      );
    }
    hasPlainPhrase ||= words.some(
      (word, index) =>
        index > 0 &&
        /^\p{White_Space}+$/u.test(
          text.slice(words[index - 1]!.end, word.start),
        ),
    );
  }
  if (!hasPlainPhrase || relevantSkeletons.size === 0) return skeletons;

  interface MatcherNode {
    children: Map<string, number>;
    failure: number;
    outputLink: number;
    outputs: Array<{ skeleton: string; length: number }>;
  }
  const nodes: MatcherNode[] = [
    { children: new Map(), failure: 0, outputLink: -1, outputs: [] },
  ];
  for (const skeleton of relevantSkeletons) {
    if (scheduler.shouldYield()) await scheduler.yield();
    let nodeIndex = 0;
    for (const character of skeleton) {
      const node = nodes[nodeIndex]!;
      let childIndex = node.children.get(character);
      if (childIndex === undefined) {
        childIndex = nodes.length;
        node.children.set(character, childIndex);
        nodes.push({
          children: new Map(),
          failure: 0,
          outputLink: -1,
          outputs: [],
        });
      }
      nodeIndex = childIndex;
    }
    nodes[nodeIndex]!.outputs.push({
      skeleton,
      length: codePointLength(skeleton),
    });
  }
  const queue: number[] = [];
  for (const childIndex of nodes[0]!.children.values()) {
    queue.push(childIndex);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    if (scheduler.shouldYield()) await scheduler.yield();
    const nodeIndex = queue[cursor]!;
    const node = nodes[nodeIndex]!;
    node.outputLink =
      nodes[node.failure]!.outputs.length > 0
        ? node.failure
        : nodes[node.failure]!.outputLink;
    for (const [character, childIndex] of node.children) {
      let failure = node.failure;
      while (failure !== 0 && !nodes[failure]!.children.has(character)) {
        failure = nodes[failure]!.failure;
      }
      nodes[childIndex]!.failure = nodes[failure]!.children.get(character) ?? 0;
      queue.push(childIndex);
    }
  }

  for (const node of nodes) {
    if (scheduler.shouldYield()) await scheduler.yield();
    node.outputs = node.outputs.filter(
      (output) =>
        (skeletons.get(output.skeleton) ?? 0) < MAX_PLAIN_SKELETON_OCCURRENCES,
    );
  }
  const nextOutputNode = (start: number): number => {
    let nodeIndex = start;
    const traversed: number[] = [];
    while (nodeIndex >= 0 && nodes[nodeIndex]!.outputs.length === 0) {
      traversed.push(nodeIndex);
      nodeIndex = nodes[nodeIndex]!.outputLink;
    }
    for (const traversedIndex of traversed) {
      nodes[traversedIndex]!.outputLink = nodeIndex;
    }
    return nodeIndex;
  };
  for (const { text, words } of analyzedTexts) {
    let state = 0;
    let runPosition = 0;
    let previousEnd = -1;
    let wordStarts = new Set<number>();
    for (const word of words) {
      if (scheduler.shouldYield()) await scheduler.yield();
      if (
        previousEnd < 0 ||
        !/^\p{White_Space}+$/u.test(text.slice(previousEnd, word.start))
      ) {
        state = 0;
        runPosition = 0;
        wordStarts = new Set();
      }
      const wordStart = runPosition;
      wordStarts.add(wordStart);
      for (const character of word.value) {
        while (state !== 0 && !nodes[state]!.children.has(character)) {
          state = nodes[state]!.failure;
        }
        state = nodes[state]!.children.get(character) ?? 0;
        runPosition += 1;
      }
      let outputNode = nextOutputNode(state);
      while (outputNode >= 0) {
        const node = nodes[outputNode]!;
        node.outputs = node.outputs.filter((output) => {
          const matchStart = runPosition - output.length;
          if (matchStart !== wordStart && wordStarts.has(matchStart)) {
            skeletons.set(
              output.skeleton,
              (skeletons.get(output.skeleton) ?? 0) + 1,
            );
          }
          return (
            (skeletons.get(output.skeleton) ?? 0) <
            MAX_PLAIN_SKELETON_OCCURRENCES
          );
        });
        outputNode = nextOutputNode(node.outputLink);
      }
      previousEnd = word.end;
    }
  }
  return skeletons;
}

export async function identifierSupport(
  exact: ReadonlySet<string>,
  scheduler: CooperativeScheduler,
  plainSkeletonCounts: ReadonlyMap<string, number> = new Map(),
  sourceTexts: readonly SourceTextAnalysis[] = [],
  structuredToolKeys: ReadonlySet<string> = new Set(),
  structuredToolKeyTranspositions: ReadonlySet<string> = new Set(),
): Promise<IdentifierSupport> {
  const skeletons = await identifierSkeletons(exact, scheduler);
  const mutableNodes: Array<{
    children: Map<string, number>;
    pattern: string | null;
    depth: number;
    componentIdentifierIds: number[];
  }> = [
    {
      children: new Map(),
      pattern: null,
      depth: 0,
      componentIdentifierIds: [],
    },
  ];
  const insert = (value: string): number => {
    let nodeIndex = 0;
    for (const character of value) {
      const node = mutableNodes[nodeIndex]!;
      let childIndex = node.children.get(character);
      if (childIndex === undefined) {
        childIndex = mutableNodes.length;
        node.children.set(character, childIndex);
        mutableNodes.push({
          children: new Map(),
          pattern: null,
          depth: mutableNodes[nodeIndex]!.depth + 1,
          componentIdentifierIds: [],
        });
      }
      nodeIndex = childIndex;
    }
    return nodeIndex;
  };
  for (const skeleton of skeletons) {
    if (scheduler.shouldYield()) await scheduler.yield();
    mutableNodes[insert(skeleton)]!.pattern = skeleton;
  }
  const oversizedTokens: string[] = [];
  const componentAlphabet = new Set<string>();
  const proseAmbiguousComponents = new Set<string>();
  const typoSensitiveComponents = new Set<string>();
  const typoSensitiveSingleCharacterComponents = new Set<string>();
  let maxComponentSkeletonLength = 0;
  let identifierId = 0;
  for (const token of exact) {
    if (scheduler.shouldYield()) await scheduler.yield();
    const analysis = analyzeIdentifier(token);
    if (analysis.oversized) {
      oversizedTokens.push(token);
      continue;
    }
    if (analysis.components.length <= 1) continue;
    const caseJoined =
      !/[^\p{L}\p{N}\p{M}\p{Cf}]/u.test(token) &&
      /(?:\p{Ll}\p{Lu}|\p{Lu}\p{Ll})/u.test(token);
    maxComponentSkeletonLength = Math.max(
      maxComponentSkeletonLength,
      codePointLength(analysis.skeleton ?? ""),
    );
    for (const component of new Set(analysis.components)) {
      for (const character of component) componentAlphabet.add(character);
      if (codePointLength(component) >= 2) {
        typoSensitiveComponents.add(component);
        if (caseJoined) proseAmbiguousComponents.add(component);
      }
      if (codePointLength(component) === 1) {
        typoSensitiveSingleCharacterComponents.add(component);
      }
      mutableNodes[insert(component)]!.componentIdentifierIds.push(
        identifierId,
      );
    }
    identifierId += 1;
  }
  const nodes: IdentifierPatternNode[] = mutableNodes.map((node) => ({
    children: node.children,
    pattern: node.pattern,
    failure: 0,
    outputLink: -1,
    componentOutputLink: -1,
    depth: node.depth,
    componentIdentifierIds: Uint32Array.from(node.componentIdentifierIds),
  }));
  const queue: number[] = [];
  for (const childIndex of nodes[0]!.children.values()) queue.push(childIndex);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    if (scheduler.shouldYield()) await scheduler.yield();
    const nodeIndex = queue[cursor]!;
    const node = nodes[nodeIndex]!;
    node.outputLink =
      nodes[node.failure]!.pattern !== null
        ? node.failure
        : nodes[node.failure]!.outputLink;
    node.componentOutputLink =
      nodes[node.failure]!.componentIdentifierIds.length > 0
        ? node.failure
        : nodes[node.failure]!.componentOutputLink;
    for (const [character, childIndex] of node.children) {
      let failure = node.failure;
      while (failure !== 0 && !nodes[failure]!.children.has(character)) {
        failure = nodes[failure]!.failure;
      }
      nodes[childIndex]!.failure = nodes[failure]!.children.get(character) ?? 0;
      queue.push(childIndex);
    }
  }
  const pathSegments = new Set<string>();
  const pathSegmentSequences: string[][] = [];
  for (const token of exact) {
    if (scheduler.shouldYield()) await scheduler.yield();
    if (
      (!token.startsWith("/") || token.startsWith("//")) &&
      !/^(?:[A-Za-z]:\\|\\\\)/u.test(token)
    ) {
      continue;
    }
    const segments = token
      .split(/[\\/]/u)
      .filter((segment) => segment.length > 0);
    if (segments.length > 0) {
      pathSegmentSequences.push(segments);
      for (const segment of segments) pathSegments.add(segment);
    }
  }
  return {
    exact,
    pathSegments,
    pathSegmentSequences,
    index: {
      nodes,
      componentMatches: new Map(),
      componentAlphabet,
      proseAmbiguousComponents,
      typoSensitiveComponents,
      typoSensitiveSingleCharacterComponents,
      maxComponentSkeletonLength,
    },
    oversizedTokens,
    structuredToolKeys,
    structuredToolKeyTranspositions,
    plainSkeletonCounts,
    boundedExactMatches: new Map(),
    sourceTexts,
  };
}

function githubReference(
  candidate: string,
): { number: string; label: "Issue" | "PR" } | null {
  const trimmed = candidate.replace(/[.,;:!?)}\]]+$/u, "");
  if (trimmed.includes("\\")) return null;
  const match =
    /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)\/(pull|issues)\/([^/?#]+)(?:[/?#].*)?$/iu.exec(
      trimmed,
    );
  if (match === null) return null;
  let owner: string;
  let repository: string;
  let number: string;
  try {
    owner = decodeURIComponent(match[1]!);
    repository = decodeURIComponent(match[2]!);
    number = decodeURIComponent(match[4]!);
  } catch {
    return null;
  }
  const validPathName = (value: string): boolean =>
    /^[A-Za-z0-9_.-]+$/u.test(value) && value !== "." && value !== "..";
  if (
    !validPathName(owner) ||
    !validPathName(repository) ||
    !/^[0-9]+$/u.test(number)
  ) {
    return null;
  }
  return {
    number,
    label: match[3]!.toLowerCase() === "pull" ? "PR" : "Issue",
  };
}

function addTextSupport(
  text: string,
  tokens: Set<string>,
  sourceBudget?: SourceIdentifierBudget,
): SourceTextAnalysis {
  const copiedSpans = copiedSourceTokenSpans(text, sourceBudget);
  for (const span of copiedSpans) {
    tokens.add(span.value);
  }
  const bangSpans = identifierBangTokenSpans(text);
  for (const span of bangSpans) {
    consumeSourceIdentifierUnit(sourceBudget);
    tokens.add(span.value);
  }
  for (const match of text.matchAll(SOURCE_URI_PATTERN)) {
    const reference = githubReference(match[0]);
    if (reference === null) continue;
    tokens.add(`#${reference.number}`);
    tokens.add(reference.label);
  }
  return {
    text,
    identifierSpans: [...copiedSpans, ...bangSpans].sort(
      compareIdentifierTokenSpans,
    ),
  };
}

async function addGithubReferenceSupport(
  text: string,
  tokens: Set<string>,
  scheduler: CooperativeScheduler,
): Promise<void> {
  let scannedThrough = 0;
  for (const match of text.matchAll(SOURCE_URI_PATTERN)) {
    const matchEnd = match.index + match[0].length;
    if (scheduler.shouldYield(Math.max(1, matchEnd - scannedThrough))) {
      await scheduler.yield();
    }
    scannedThrough = matchEnd;
    const reference = githubReference(match[0]);
    if (reference !== null) {
      tokens.add(`#${reference.number}`);
      tokens.add(reference.label);
    }
    if (scheduler.shouldYield(Math.max(1, match[0].length))) {
      await scheduler.yield();
    }
  }
  if (
    scheduler.shouldYield(
      Math.max(
        IDENTIFIER_VALIDATION_CHECK_INTERVAL,
        text.length - scannedThrough,
      ),
    )
  ) {
    await scheduler.yield();
  }
}

async function addTextSupportCooperatively(
  text: string,
  tokens: Set<string>,
  scheduler: CooperativeScheduler,
  sourceBudget?: SourceIdentifierBudget,
): Promise<SourceTextAnalysis> {
  const copiedSpans = await cooperativeCopiedSourceTokenSpans(
    text,
    scheduler,
    sourceBudget,
  );
  for (const span of copiedSpans) {
    if (scheduler.shouldYield()) await scheduler.yield();
    tokens.add(span.value);
  }
  const bangSpans = await cooperativeIdentifierBangTokenSpans(
    text,
    scheduler,
    sourceBudget,
  );
  for (const span of bangSpans) {
    if (scheduler.shouldYield()) await scheduler.yield();
    tokens.add(span.value);
  }
  await addGithubReferenceSupport(text, tokens, scheduler);
  return {
    text,
    identifierSpans: await cooperativelySortIdentifierTokenSpans(
      copiedSpans.concat(bangSpans),
      scheduler,
    ),
  };
}

export function copiedSourceSupport(text: string): Set<string> {
  const tokens = new Set<string>();
  addTextSupport(text, tokens);
  return tokens;
}

function toolStateRootEntries(value: unknown): Array<[string, unknown]> {
  const object = asRecord(value);
  if (object === null) return [];
  const entries = Object.entries(object);
  if (
    entries.length !== 1 ||
    entries[0]![0] !== SANITIZED_TOOL_OBJECT_KEY ||
    !Array.isArray(entries[0]![1])
  ) {
    return entries;
  }
  const decoded: Array<[string, unknown]> = [];
  let hasRedactedKey = false;
  for (const [index, entry] of entries[0]![1].entries()) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string"
    ) {
      return entries;
    }
    hasRedactedKey ||= entry[0] === `[data URL key omitted ${index}]`;
    decoded.push([entry[0], entry[1]]);
  }
  return hasRedactedKey ? decoded : entries;
}

function addStructuredToolKeys(
  value: unknown,
  keys: Set<string>,
  transpositions: Set<string>,
): void {
  for (const [key] of toolStateRootEntries(value)) {
    if (!STRUCTURED_TOOL_STATE_KEYS.has(key)) continue;
    const skeleton = identifierSkeleton(key);
    if (skeleton === null) continue;
    keys.add(key);
    // Bare lowercase words are prose-ambiguous. Adjacent transpositions catch
    // the high-confidence typo shape without treating ordinary edits as keys.
    const characters = [...skeleton];
    for (let index = 0; index + 1 < characters.length; index += 1) {
      [characters[index], characters[index + 1]] = [
        characters[index + 1]!,
        characters[index]!,
      ];
      const transposition = characters.join("");
      if (transposition !== skeleton) transpositions.add(transposition);
      [characters[index], characters[index + 1]] = [
        characters[index + 1]!,
        characters[index]!,
      ];
    }
  }
}

async function addToolStateSupport(
  value: unknown,
  tokens: Set<string>,
  sourceTexts: SourceTextAnalysis[],
  sourceBudget: SourceIdentifierBudget,
  scheduler: CooperativeScheduler,
): Promise<void> {
  if (scheduler.shouldYield()) await scheduler.yield();
  if (typeof value === "string") {
    sourceTexts.push(
      await addTextSupportCooperatively(value, tokens, scheduler, sourceBudget),
    );
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const text = JSON.stringify(value);
    sourceTexts.push(
      await addTextSupportCooperatively(text, tokens, scheduler, sourceBudget),
    );
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      await addToolStateSupport(
        item,
        tokens,
        sourceTexts,
        sourceBudget,
        scheduler,
      );
    }
    return;
  }
  const object = asRecord(value);
  if (object === null) return;
  for (const [key, item] of Object.entries(object)) {
    sourceTexts.push(
      await addTextSupportCooperatively(key, tokens, scheduler, sourceBudget),
    );
    await addToolStateSupport(
      item,
      tokens,
      sourceTexts,
      sourceBudget,
      scheduler,
    );
  }
}

export async function sourceIdentifierSupport(
  request: SegmentCreate,
  scheduler: CooperativeScheduler,
): Promise<{
  identifiers: Set<string>;
  structuredToolKeys: Set<string>;
  structuredToolKeyTranspositions: Set<string>;
  plainSkeletons: Map<string, number>;
  sourceTexts: SourceTextAnalysis[];
}> {
  const identifiers = new Set<string>();
  const structuredToolKeys = new Set<string>();
  const structuredToolKeyTranspositions = new Set<string>();
  const sourceTexts: SourceTextAnalysis[] = [];
  const sourceBudget: SourceIdentifierBudget = {
    remaining: MAX_SOURCE_IDENTIFIER_CANDIDATES,
  };
  let remainingToolChars = MAX_COMPLETE_TOOL_SOURCE_CHARS;
  let toolBudgetExhausted = false;
  for (const message of request.messages) {
    const blocks =
      message.role === "assistant"
        ? canonicalToolFallbackFrames(message.text)
        : [];
    const blocksByStart = new Map(blocks.map((block) => [block.start, block]));
    const ranges =
      message.role === "assistant" ? toolFallbackFrameRanges(message.text) : [];
    let cursor = 0;
    for (const range of ranges) {
      const text = message.text.slice(cursor, range.start);
      sourceTexts.push(
        await addTextSupportCooperatively(
          text,
          identifiers,
          scheduler,
          sourceBudget,
        ),
      );
      if (scheduler.shouldYield(IDENTIFIER_VALIDATION_CHECK_INTERVAL)) {
        await scheduler.yield();
      }
      const block = blocksByStart.get(range.start);
      if (block === undefined || block.end !== range.end) {
        cursor = range.end;
        continue;
      }
      const blockChars = range.end - range.start;
      if (toolBudgetExhausted || blockChars > remainingToolChars) {
        toolBudgetExhausted = true;
        cursor = range.end;
        continue;
      }
      remainingToolChars -= blockChars;
      sourceTexts.push(
        await addTextSupportCooperatively(
          block.name,
          identifiers,
          scheduler,
          sourceBudget,
        ),
      );
      addStructuredToolKeys(
        block.state,
        structuredToolKeys,
        structuredToolKeyTranspositions,
      );
      await addToolStateSupport(
        block.state,
        identifiers,
        sourceTexts,
        sourceBudget,
        scheduler,
      );
      if (scheduler.shouldYield(IDENTIFIER_VALIDATION_CHECK_INTERVAL)) {
        await scheduler.yield();
      }
      cursor = range.end;
    }
    const text = message.text.slice(cursor);
    sourceTexts.push(
      await addTextSupportCooperatively(
        text,
        identifiers,
        scheduler,
        sourceBudget,
      ),
    );
    if (scheduler.shouldYield(IDENTIFIER_VALIDATION_CHECK_INTERVAL)) {
      await scheduler.yield();
    }
  }
  const relevantSkeletons = await identifierSkeletons(identifiers, scheduler);
  const plainSkeletons = await plainSourceSkeletons(
    sourceTexts,
    relevantSkeletons,
    scheduler,
    { remaining: MAX_SOURCE_PLAIN_SCAN_UNITS },
  );
  return {
    identifiers,
    structuredToolKeys,
    structuredToolKeyTranspositions,
    plainSkeletons,
    sourceTexts,
  };
}
