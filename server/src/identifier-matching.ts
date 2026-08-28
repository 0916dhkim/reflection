import { codePointLength } from "@reflection/shared/contracts";
import {
  analyzeIdentifier,
  foldIdentifierText,
  IDENTIFIER_WORD_PATTERN,
  MAX_IDENTIFIER_SOURCE_CHARACTERS,
  type IdentifierTokenSpan,
} from "./identifier-lexing.js";
import {
  IDENTIFIER_VALIDATION_CHECK_INTERVAL,
  type CooperativeScheduler,
} from "./identifier-validation-scheduler.js";

const MAX_COMPONENT_NEAR_VARIANTS = 100_000;
const MAX_COMPONENT_NEAR_CHARACTERS = 2_000_000;
const MAX_OVERSIZED_NEAR_COMPARISONS = 2_000_000;

export interface IdentifierValidationWorkBudget {
  remaining: number;
  exceeded: boolean;
}

export interface IdentifierPatternIndex {
  nodes: readonly IdentifierPatternNode[];
  componentMatches: Map<string, boolean>;
  componentAlphabet: ReadonlySet<string>;
  proseAmbiguousComponents: ReadonlySet<string>;
  typoSensitiveComponents: ReadonlySet<string>;
  typoSensitiveSingleCharacterComponents: ReadonlySet<string>;
  maxComponentSkeletonLength: number;
}

export interface IdentifierPatternNode {
  children: Map<string, number>;
  pattern: string | null;
  failure: number;
  outputLink: number;
  componentOutputLink: number;
  depth: number;
  componentIdentifierIds: Uint32Array;
}

export interface IdentifierMatchingSupport {
  exact: ReadonlySet<string>;
  index: IdentifierPatternIndex;
  oversizedTokens: readonly string[];
  boundedExactMatches: Map<string, boolean>;
  sourceTexts: readonly {
    text: string;
    identifierSpans: readonly IdentifierTokenSpan[];
  }[];
}

export function consumeIdentifierWork(
  budget: IdentifierValidationWorkBudget,
  amount: number,
): boolean {
  if (budget.exceeded) return false;
  budget.remaining -= amount;
  if (budget.remaining >= 0) return true;
  budget.exceeded = true;
  return false;
}

export async function supportContainsBoundedExactText(
  support: IdentifierMatchingSupport,
  candidate: string,
  workBudget: IdentifierValidationWorkBudget,
  scheduler: CooperativeScheduler,
): Promise<boolean> {
  const cached = support.boundedExactMatches.get(candidate);
  if (cached !== undefined) return cached;
  let matches = false;
  for (const { text, identifierSpans } of support.sourceTexts) {
    if (scheduler.shouldYield(IDENTIFIER_VALIDATION_CHECK_INTERVAL)) {
      await scheduler.yield();
    }
    if (
      await containsBoundedExactText(
        text,
        identifierSpans,
        candidate,
        workBudget,
        scheduler,
      )
    ) {
      matches = true;
      break;
    }
  }
  if (!workBudget.exceeded) {
    support.boundedExactMatches.set(candidate, matches);
  }
  return matches;
}

function identifierWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}\p{M}\p{Cf}_]/u.test(character);
}

function codePointAt(value: string, offset: number): string | undefined {
  const codePoint = value.codePointAt(offset);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function codePointBefore(value: string, offset: number): string | undefined {
  if (offset <= 0) return undefined;
  const trailingUnit = value.charCodeAt(offset - 1);
  const start =
    trailingUnit >= 0xdc00 &&
    trailingUnit <= 0xdfff &&
    offset >= 2 &&
    value.charCodeAt(offset - 2) >= 0xd800 &&
    value.charCodeAt(offset - 2) <= 0xdbff
      ? offset - 2
      : offset - 1;
  return value.slice(start, offset);
}

async function containsBoundedExactText(
  source: string,
  identifierSpans: readonly IdentifierTokenSpan[],
  candidate: string,
  workBudget: IdentifierValidationWorkBudget,
  scheduler: CooperativeScheduler,
): Promise<boolean> {
  if (candidate.length === 0) return false;
  if (!consumeIdentifierWork(workBudget, source.length)) return false;
  const candidateStartsWithWordCharacter = identifierWordCharacter(
    codePointAt(candidate, 0),
  );
  const candidateEndsWithWordCharacter = identifierWordCharacter(
    codePointBefore(candidate, candidate.length),
  );
  let spanIndex = 0;
  let index = source.indexOf(candidate);
  while (index >= 0) {
    if (scheduler.shouldYield()) await scheduler.yield();
    if (!consumeIdentifierWork(workBudget, 1)) return false;
    const end = index + candidate.length;
    const boundedStart =
      !candidateStartsWithWordCharacter ||
      !identifierWordCharacter(codePointBefore(source, index));
    const boundedEnd =
      !candidateEndsWithWordCharacter ||
      !identifierWordCharacter(codePointAt(source, end));
    while (
      spanIndex < identifierSpans.length &&
      identifierSpans[spanIndex]!.end <= index
    ) {
      if (!consumeIdentifierWork(workBudget, 1)) return false;
      spanIndex += 1;
    }
    const span = identifierSpans[spanIndex];
    const splitsIdentifier =
      span !== undefined &&
      ((span.start < index && index < span.end) ||
        (span.start < end && end < span.end));
    if (boundedStart && boundedEnd && !splitsIdentifier) return true;
    index = source.indexOf(candidate, index + 1);
  }
  return false;
}

function intersectIdentifierIds(
  left: Uint32Array,
  right: Uint32Array,
): Uint32Array {
  if (left === right) return left;
  const [smaller, larger] =
    left.length <= right.length ? [left, right] : [right, left];
  if (
    smaller.length * Math.log2(larger.length + 1) <
    left.length + right.length
  ) {
    const result: number[] = [];
    for (const value of smaller) {
      let low = 0;
      let high = larger.length - 1;
      while (low <= high) {
        const middle = (low + high) >>> 1;
        const candidate = larger[middle]!;
        if (candidate < value) low = middle + 1;
        else if (candidate > value) high = middle - 1;
        else {
          result.push(value);
          break;
        }
      }
    }
    return Uint32Array.from(result);
  }
  const result: number[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftValue = left[leftIndex]!;
    const rightValue = right[rightIndex]!;
    if (leftValue === rightValue) {
      result.push(leftValue);
      leftIndex += 1;
      rightIndex += 1;
    } else if (leftValue < rightValue) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return Uint32Array.from(result);
}

function unionIdentifierIds(
  left: Uint32Array | undefined,
  right: Uint32Array,
): Uint32Array {
  if (left === undefined || left.length === 0) return right;
  if (left === right || right.length === 0) return left;
  const result: number[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftValue = left[leftIndex];
    const rightValue = right[rightIndex];
    if (
      rightValue === undefined ||
      (leftValue !== undefined && leftValue < rightValue)
    ) {
      result.push(leftValue!);
      leftIndex += 1;
    } else if (leftValue === undefined || rightValue < leftValue) {
      result.push(rightValue);
      rightIndex += 1;
    } else {
      result.push(leftValue);
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return Uint32Array.from(result);
}

export function patternIndexIncludes(
  index: IdentifierPatternIndex,
  candidate: string,
): boolean {
  let nodeIndex = 0;
  for (const character of candidate) {
    const childIndex = index.nodes[nodeIndex]!.children.get(character);
    if (childIndex === undefined) return false;
    nodeIndex = childIndex;
  }
  return index.nodes[nodeIndex]!.pattern !== null;
}

export function componentIndexIncludes(
  index: IdentifierPatternIndex,
  candidate: string,
  cache = true,
  workBudget?: IdentifierValidationWorkBudget,
): boolean {
  if (cache) {
    const cached = index.componentMatches.get(candidate);
    if (cached !== undefined) return cached;
  }
  const characters = [...candidate];
  if (
    workBudget !== undefined &&
    !consumeIdentifierWork(workBudget, characters.length)
  ) {
    return false;
  }
  const reachable = new Map<number, Uint32Array>();
  let state = 0;
  for (let end = 1; end <= characters.length; end += 1) {
    const character = characters[end - 1]!;
    while (state !== 0 && !index.nodes[state]!.children.has(character)) {
      if (workBudget !== undefined && !consumeIdentifierWork(workBudget, 1)) {
        return false;
      }
      state = index.nodes[state]!.failure;
    }
    state = index.nodes[state]!.children.get(character) ?? 0;
    let outputNode =
      index.nodes[state]!.componentIdentifierIds.length > 0
        ? state
        : index.nodes[state]!.componentOutputLink;
    while (outputNode >= 0) {
      const componentNode = index.nodes[outputNode]!;
      const start = end - componentNode.depth;
      const priorIdentifiers = start === 0 ? undefined : reachable.get(start);
      if (start === 0 || priorIdentifiers !== undefined) {
        const componentIdentifiers = componentNode.componentIdentifierIds;
        if (
          workBudget !== undefined &&
          !consumeIdentifierWork(
            workBudget,
            1 + componentIdentifiers.length + (priorIdentifiers?.length ?? 0),
          )
        ) {
          return false;
        }
        const derivedIdentifiers =
          priorIdentifiers === undefined
            ? componentIdentifiers
            : intersectIdentifierIds(priorIdentifiers, componentIdentifiers);
        if (derivedIdentifiers.length > 0) {
          if (
            workBudget !== undefined &&
            !consumeIdentifierWork(
              workBudget,
              derivedIdentifiers.length + (reachable.get(end)?.length ?? 0),
            )
          ) {
            return false;
          }
          reachable.set(
            end,
            unionIdentifierIds(reachable.get(end), derivedIdentifiers),
          );
        }
      }
      if (workBudget !== undefined && !consumeIdentifierWork(workBudget, 1)) {
        return false;
      }
      outputNode = componentNode.componentOutputLink;
    }
    if (end === characters.length && (reachable.get(end)?.length ?? 0) > 0) {
      if (cache) index.componentMatches.set(candidate, true);
      return true;
    }
  }
  if (cache && !workBudget?.exceeded) {
    index.componentMatches.set(candidate, false);
  }
  return false;
}

interface CandidateMatcherNode {
  children: Map<string, number>;
  failure: number;
  outputLink: number;
  outputs: string[];
}

async function streamNormalizedIdentifierSkeleton(
  token: string,
  consume: (value: string) => boolean,
  scheduler: CooperativeScheduler,
): Promise<boolean> {
  let carry = "";
  const emit = (rawChunk: string, final: boolean): boolean => {
    const normalized = `${carry}${rawChunk}`.normalize("NFKD");
    if (final) {
      carry = "";
      return consume(foldIdentifierText(normalized));
    }
    let offset = 0;
    let lastStarterOffset = -1;
    for (const codePoint of normalized) {
      if (!/^[\p{M}\p{Cf}]$/u.test(codePoint)) {
        lastStarterOffset = offset;
      }
      offset += codePoint.length;
    }
    if (lastStarterOffset < 0) {
      carry = "";
      return false;
    }
    const stable = normalized.slice(0, lastStarterOffset);
    carry = normalized.slice(lastStarterOffset);
    return stable.length > 0 && consume(foldIdentifierText(stable));
  };

  const chunk: string[] = [];
  let chunkCharacters = 0;
  for (const match of token.matchAll(IDENTIFIER_WORD_PATTERN)) {
    for (const codePoint of match[0]) {
      if (scheduler.shouldYield()) await scheduler.yield();
      chunk.push(codePoint);
      chunkCharacters += 1;
      if (chunkCharacters < MAX_IDENTIFIER_SOURCE_CHARACTERS) continue;
      if (emit(chunk.join(""), false)) return true;
      chunk.length = 0;
      chunkCharacters = 0;
    }
  }
  return emit(chunk.join(""), true);
}

export async function oversizedIdentifierMatches(
  candidates: ReadonlySet<string>,
  supports: readonly IdentifierMatchingSupport[],
  scheduler: CooperativeScheduler,
): Promise<Set<string>> {
  const oversizedTokens = supports.flatMap(
    (support) => support.oversizedTokens,
  );
  const eligibleCandidates = [...candidates].filter(
    (candidate) => codePointLength(candidate) >= 2,
  );
  if (oversizedTokens.length === 0 || eligibleCandidates.length === 0) {
    return new Set();
  }

  const nodes: CandidateMatcherNode[] = [
    { children: new Map(), failure: 0, outputLink: -1, outputs: [] },
  ];
  for (const candidate of eligibleCandidates) {
    if (scheduler.shouldYield()) await scheduler.yield();
    let nodeIndex = 0;
    for (const character of candidate) {
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
    nodes[nodeIndex]!.outputs.push(candidate);
  }

  const queue: number[] = [];
  for (const childIndex of nodes[0]!.children.values()) {
    queue.push(childIndex);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    if (scheduler.shouldYield()) await scheduler.yield();
    const nodeIndex = queue[cursor]!;
    const node = nodes[nodeIndex]!;
    const failureNode = nodes[node.failure]!;
    node.outputLink =
      failureNode.outputs.length > 0 ? node.failure : failureNode.outputLink;
    for (const [character, childIndex] of node.children) {
      let failure = node.failure;
      while (failure !== 0 && !nodes[failure]!.children.has(character)) {
        failure = nodes[failure]!.failure;
      }
      nodes[childIndex]!.failure = nodes[failure]!.children.get(character) ?? 0;
      queue.push(childIndex);
    }
  }

  const matches = new Set<string>();
  const normalizedOversizedTokens: number[][] = [];
  let state = 0;
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
  const scan = (normalized: string): boolean => {
    for (const character of normalized) {
      while (state !== 0 && !nodes[state]!.children.has(character)) {
        state = nodes[state]!.failure;
      }
      state = nodes[state]!.children.get(character) ?? 0;
      let outputNode = nextOutputNode(state);
      while (outputNode >= 0) {
        for (const candidate of nodes[outputNode]!.outputs) {
          matches.add(candidate);
        }
        nodes[outputNode]!.outputs = [];
        outputNode = nextOutputNode(nodes[outputNode]!.outputLink);
      }
      if (matches.size === eligibleCandidates.length) return true;
    }
    return false;
  };

  for (const token of oversizedTokens) {
    if (scheduler.shouldYield()) await scheduler.yield();
    let normalized = "";
    if (
      await streamNormalizedIdentifierSkeleton(
        token,
        (chunk) => {
          normalized += chunk;
          return scan(chunk);
        },
        scheduler,
      )
    ) {
      return matches;
    }
    normalizedOversizedTokens.push(
      [...normalized].map((character) => character.codePointAt(0)!),
    );
    state = 0;
  }

  let comparisons = 0;
  const windowOneEditApart = (
    candidate: readonly number[],
    source: readonly number[],
    start: number,
    length: number,
  ): boolean | null => {
    const compare = (left: number, right: number): boolean | null => {
      comparisons += 1;
      return comparisons > MAX_OVERSIZED_NEAR_COMPARISONS
        ? null
        : left === right;
    };
    if (candidate.length === length) {
      const mismatches: number[] = [];
      for (let index = 0; index < candidate.length; index += 1) {
        const same = compare(candidate[index]!, source[start + index]!);
        if (same === null) return null;
        if (!same) mismatches.push(index);
        if (mismatches.length > 2) return false;
      }
      if (mismatches.length === 1) return true;
      if (mismatches.length !== 2) return false;
      const [first, second] = mismatches;
      return (
        second === first! + 1 &&
        candidate[first!] === source[start + second!] &&
        candidate[second!] === source[start + first!]
      );
    }
    const candidateIsShorter = candidate.length < length;
    const shorterLength = Math.min(candidate.length, length);
    const longerLength = Math.max(candidate.length, length);
    let shorterIndex = 0;
    let longerIndex = 0;
    let skipped = false;
    while (shorterIndex < shorterLength && longerIndex < longerLength) {
      const shorter = candidateIsShorter
        ? candidate[shorterIndex]!
        : source[start + shorterIndex]!;
      const longer = candidateIsShorter
        ? source[start + longerIndex]!
        : candidate[longerIndex]!;
      const same = compare(shorter, longer);
      if (same === null) return null;
      if (same) {
        shorterIndex += 1;
        longerIndex += 1;
      } else {
        if (skipped) return false;
        skipped = true;
        longerIndex += 1;
      }
    }
    return true;
  };
  const candidateRecords = eligibleCandidates
    .filter(
      (candidate) => !matches.has(candidate) && codePointLength(candidate) >= 4,
    )
    .map((candidate) => ({
      candidate,
      codePoints: [...candidate].map((character) => character.codePointAt(0)!),
    }));
  for (const [recordIndex, record] of candidateRecords.entries()) {
    if (scheduler.shouldYield()) await scheduler.yield();
    let matched = false;
    for (const source of normalizedOversizedTokens) {
      if (scheduler.shouldYield()) await scheduler.yield();
      for (const length of new Set([
        record.codePoints.length - 1,
        record.codePoints.length,
        record.codePoints.length + 1,
      ])) {
        if (length < 1 || length > source.length) continue;
        for (let start = 0; start + length <= source.length; start += 1) {
          if (scheduler.shouldYield()) await scheduler.yield();
          const result = windowOneEditApart(
            record.codePoints,
            source,
            start,
            length,
          );
          if (result === null) {
            for (const remaining of candidateRecords.slice(recordIndex)) {
              matches.add(remaining.candidate);
            }
            return matches;
          }
          if (result) {
            matches.add(record.candidate);
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      if (matched) break;
    }
  }
  return matches;
}

interface IdentifierHashRecord {
  value: string;
  codePoints: readonly number[];
}

const identifierHashPowers = [1];
const IDENTIFIER_HASH_BASE = 1_000_003;

function identifierDeletionHashes(value: string): string[] {
  const codePoints = [...value].map((character) => character.codePointAt(0)!);
  while (identifierHashPowers.length <= codePoints.length) {
    identifierHashPowers.push(
      Math.imul(
        identifierHashPowers[identifierHashPowers.length - 1]!,
        IDENTIFIER_HASH_BASE,
      ) >>> 0,
    );
  }
  const prefix = new Uint32Array(codePoints.length + 1);
  for (let index = 0; index < codePoints.length; index += 1) {
    prefix[index + 1] =
      (Math.imul(prefix[index]!, IDENTIFIER_HASH_BASE) + codePoints[index]!) >>>
      0;
  }
  const hashes = new Set<string>([
    `${codePoints.length}:${prefix[codePoints.length]}`,
  ]);
  for (let index = 0; index < codePoints.length; index += 1) {
    const suffixLength = codePoints.length - index - 1;
    const suffixHash =
      (prefix[codePoints.length]! -
        Math.imul(prefix[index + 1]!, identifierHashPowers[suffixLength]!)) >>>
      0;
    const hash =
      (Math.imul(prefix[index]!, identifierHashPowers[suffixLength]!) +
        suffixHash) >>>
      0;
    hashes.add(`${codePoints.length - 1}:${hash}`);
  }
  return [...hashes];
}

function oneIdentifierEditApart(
  left: readonly number[],
  right: readonly number[],
): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  if (left.length === right.length) {
    const mismatches: number[] = [];
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) mismatches.push(index);
      if (mismatches.length > 2) return false;
    }
    if (mismatches.length === 1) return true;
    return (
      mismatches.length === 2 &&
      mismatches[1] === mismatches[0]! + 1 &&
      left[mismatches[0]!] === right[mismatches[1]!] &&
      left[mismatches[1]!] === right[mismatches[0]!]
    );
  }
  const [shorter, longer] =
    left.length < right.length ? [left, right] : [right, left];
  let shorterIndex = 0;
  let longerIndex = 0;
  let skipped = false;
  while (shorterIndex < shorter.length && longerIndex < longer.length) {
    if (shorter[shorterIndex] === longer[longerIndex]) {
      shorterIndex += 1;
      longerIndex += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    longerIndex += 1;
  }
  return true;
}

export async function nearIdentifierMatches(
  candidates: ReadonlySet<string>,
  support: IdentifierMatchingSupport,
  workBudget: IdentifierValidationWorkBudget,
  scheduler: CooperativeScheduler,
): Promise<Set<string>> {
  const candidatesByHash = new Map<string, IdentifierHashRecord[]>();
  for (const value of candidates) {
    if (scheduler.shouldYield()) await scheduler.yield();
    if (codePointLength(value) < 2) continue;
    const record = {
      value,
      codePoints: [...value].map((character) => character.codePointAt(0)!),
    };
    for (const hash of identifierDeletionHashes(value)) {
      const records = candidatesByHash.get(hash);
      if (records === undefined) candidatesByHash.set(hash, [record]);
      else records.push(record);
    }
  }
  if (candidatesByHash.size === 0) return new Set();

  const matches = new Set<string>();
  let componentVariants = 0;
  let componentCharacters = 0;
  const componentBudgetExceeded = (): boolean =>
    workBudget.exceeded ||
    componentVariants > MAX_COMPONENT_NEAR_VARIANTS ||
    componentCharacters > MAX_COMPONENT_NEAR_CHARACTERS;
  const componentAlphabet = [...support.index.componentAlphabet];
  const componentVariantMatches = (characters: readonly string[]): boolean => {
    componentVariants += 1;
    componentCharacters += characters.length;
    if (componentBudgetExceeded()) return false;
    const value = characters.join("");
    return (
      (!patternIndexIncludes(support.index, value) ||
        support.index.typoSensitiveComponents.has(value)) &&
      componentIndexIncludes(support.index, value, false, workBudget)
    );
  };
  for (const candidate of candidates) {
    if (scheduler.shouldYield()) await scheduler.yield();
    if (
      codePointLength(candidate) < 2 ||
      codePointLength(candidate) >
        support.index.maxComponentSkeletonLength + 1 ||
      support.index.componentAlphabet.size === 0 ||
      componentIndexIncludes(support.index, candidate, true, workBudget)
    ) {
      continue;
    }
    const characters = [...candidate];
    let matched = false;
    for (let index = 0; index < characters.length && !matched; index += 1) {
      if (scheduler.shouldYield()) await scheduler.yield();
      const removed = characters.splice(index, 1)[0]!;
      matched = componentVariantMatches(characters);
      characters.splice(index, 0, removed);
      if (componentBudgetExceeded()) {
        return new Set(
          [...candidates].filter((value) => codePointLength(value) >= 2),
        );
      }
    }
    for (let index = 0; index + 1 < characters.length && !matched; index += 1) {
      if (scheduler.shouldYield()) await scheduler.yield();
      [characters[index], characters[index + 1]] = [
        characters[index + 1]!,
        characters[index]!,
      ];
      matched = componentVariantMatches(characters);
      [characters[index], characters[index + 1]] = [
        characters[index + 1]!,
        characters[index]!,
      ];
      if (componentBudgetExceeded()) {
        return new Set(
          [...candidates].filter((value) => codePointLength(value) >= 2),
        );
      }
    }
    for (let index = 0; index < characters.length && !matched; index += 1) {
      if (scheduler.shouldYield()) await scheduler.yield();
      const original = characters[index]!;
      for (const replacement of componentAlphabet) {
        if (scheduler.shouldYield()) await scheduler.yield();
        if (replacement === original) continue;
        characters[index] = replacement;
        matched = componentVariantMatches(characters);
        if (matched) break;
        if (componentBudgetExceeded()) {
          return new Set(
            [...candidates].filter((value) => codePointLength(value) >= 2),
          );
        }
      }
      characters[index] = original;
    }
    for (let index = 0; index <= characters.length && !matched; index += 1) {
      if (scheduler.shouldYield()) await scheduler.yield();
      for (const inserted of componentAlphabet) {
        if (scheduler.shouldYield()) await scheduler.yield();
        characters.splice(index, 0, inserted);
        matched = componentVariantMatches(characters);
        characters.splice(index, 1);
        if (matched) break;
        if (componentBudgetExceeded()) {
          return new Set(
            [...candidates].filter((value) => codePointLength(value) >= 2),
          );
        }
      }
    }
    if (matched) matches.add(candidate);
  }
  for (const token of support.exact) {
    if (scheduler.shouldYield()) await scheduler.yield();
    const analysis = analyzeIdentifier(token);
    if (analysis.skeleton === null || analysis.oversized) continue;
    const skeletons = new Set([analysis.skeleton]);
    if (token.startsWith(".")) skeletons.add(`dot${analysis.skeleton}`);
    if (token.endsWith("++")) skeletons.add(`${analysis.skeleton}plusplus`);
    if (token.endsWith("#")) skeletons.add(`${analysis.skeleton}sharp`);
    for (const skeleton of skeletons) {
      const sourceCodePoints = [...skeleton].map(
        (character) => character.codePointAt(0)!,
      );
      for (const hash of identifierDeletionHashes(skeleton)) {
        if (scheduler.shouldYield()) await scheduler.yield();
        for (const candidate of candidatesByHash.get(hash) ?? []) {
          if (
            candidate.value !== skeleton &&
            oneIdentifierEditApart(sourceCodePoints, candidate.codePoints)
          ) {
            matches.add(candidate.value);
          }
        }
      }
    }
  }
  return matches;
}
