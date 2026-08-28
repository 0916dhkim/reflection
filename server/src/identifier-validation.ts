import {
  codePointLength,
  type ExtractedClaim,
  type ExtractionResult,
  type ExtractionWireClaim,
  type SegmentCreate,
} from "@reflection/shared/contracts";
import { TerminalExtractionValidationError } from "@reflection/shared/domain";
import type { ValidatedExtractionResult } from "./extraction-validation.js";
import {
  ABSOLUTE_PATH_PATTERN,
  addIdentifierComponentSkeletons,
  addIdentifierSkeletons,
  codeBangTokenSpans,
  copiedSourceTokenSpans,
  DISTINCTIVE_IDENTIFIER_SYMBOL_PATTERN,
  identifierSkeleton,
  IDENTIFIER_WORD_PATTERN,
  SOURCE_CODE_FILENAME_PATTERN,
  SourceIdentifierBudgetError,
  syntacticBangTokenSpans,
  terminalBangTokenSpans,
  type IdentifierTokenSpan,
} from "./identifier-lexing.js";
import {
  componentIndexIncludes,
  consumeIdentifierWork,
  nearIdentifierMatches,
  oversizedIdentifierMatches,
  patternIndexIncludes,
  supportContainsBoundedExactText,
  type IdentifierValidationWorkBudget,
} from "./identifier-matching.js";
import {
  identifierSupport,
  sourceIdentifierSupport,
  type IdentifierSupport,
} from "./identifier-support.js";
import {
  CooperativeScheduler,
  IDENTIFIER_VALIDATION_CHECK_INTERVAL,
} from "./identifier-validation-scheduler.js";

export { copiedSourceTokens } from "./identifier-lexing.js";
export { copiedSourceSupport } from "./identifier-support.js";

export interface IdentifierValidationLogger {
  warn(message: string, context: Readonly<Record<string, unknown>>): void;
}

class IdentifierValidationFailure extends Error {}

const MAX_PREPARED_IDENTIFIER_OCCURRENCES = 130_000;
const MAX_IDENTIFIER_VALIDATION_WORK = 2_000_000;

function normalizedPredicateSkeletons(
  predicate: string,
  sourceIdentifiers: ReadonlySet<string>,
): Map<string, number> {
  const skeletons = new Map<string, number>();
  const wholePredicateIsExact = sourceIdentifiers.has(predicate);
  for (const [index, component] of [
    predicate,
    ...predicate.split(/[\s_]+/u),
  ].entries()) {
    if (index > 0 && component === predicate) continue;
    if (!wholePredicateIsExact && !sourceIdentifiers.has(component)) continue;
    const componentSkeletons = new Set<string>();
    addIdentifierSkeletons(componentSkeletons, component);
    addIdentifierComponentSkeletons(componentSkeletons, component);
    for (const skeleton of componentSkeletons) {
      skeletons.set(skeleton, Number.MAX_SAFE_INTEGER);
    }
  }
  return skeletons;
}

function supportIncludes(
  supports: readonly IdentifierSupport[],
  token: string,
): boolean {
  return supports.some(
    (support) =>
      support.exact.has(token) || support.structuredToolKeys.has(token),
  );
}

function plainSupportIncludes(
  supports: readonly IdentifierSupport[],
  token: string,
): boolean {
  const skeleton = identifierSkeleton(token);
  return (
    skeleton !== null &&
    supports.some(
      (support) => (support.plainSkeletonCounts.get(skeleton) ?? 0) > 0,
    )
  );
}

interface IdentifierSpanIndex {
  maxEndAtOrBeforeStart: Int32Array;
  ends: ReadonlySet<number>;
}

function identifierSpanIndex(
  textLength: number,
  spans: readonly IdentifierTokenSpan[],
): IdentifierSpanIndex {
  const maxEndAtOrBeforeStart = new Int32Array(textLength + 1);
  maxEndAtOrBeforeStart.fill(-1);
  const ends = new Set<number>();
  for (const span of spans) {
    if (span.start < 0 || span.start > textLength) continue;
    maxEndAtOrBeforeStart[span.start] = Math.max(
      maxEndAtOrBeforeStart[span.start]!,
      span.end,
    );
    ends.add(span.end);
  }
  let maximumEnd = -1;
  for (let start = 0; start <= textLength; start += 1) {
    maximumEnd = Math.max(maximumEnd, maxEndAtOrBeforeStart[start]!);
    maxEndAtOrBeforeStart[start] = maximumEnd;
  }
  return { maxEndAtOrBeforeStart, ends };
}

function spanIndexContains(
  index: IdentifierSpanIndex,
  start: number,
  end: number,
): boolean {
  return (index.maxEndAtOrBeforeStart[start] ?? -1) >= end;
}

interface AttachedTextClusterIndex {
  starts: Uint32Array;
  ends: Uint32Array;
}

function attachedTextClusterIndex(text: string): AttachedTextClusterIndex {
  const starts = new Uint32Array(text.length);
  const ends = new Uint32Array(text.length);
  for (const match of text.matchAll(/[^\p{White_Space}]+/gu)) {
    const end = match.index + match[0].length;
    starts.fill(match.index, match.index, end);
    ends.fill(end, match.index, end);
  }
  return { starts, ends };
}

function unsupportedAttachedIdentifierWords(
  text: string,
  groundedSpans: readonly IdentifierTokenSpan[],
  groundedSpanIndex: IdentifierSpanIndex,
  clusterIndex: AttachedTextClusterIndex,
  supports: readonly IdentifierSupport[],
  normalizedSkeletons: ReadonlyMap<string, number> | undefined,
): IdentifierTokenSpan[] {
  const clusters = new Map<string, { start: number; end: number }>();
  for (const span of groundedSpans) {
    const start = clusterIndex.starts[span.start] ?? span.start;
    const end = clusterIndex.ends[span.end - 1] ?? span.end;
    if (start < span.start || end > span.end) {
      clusters.set(`${start}:${end}`, { start, end });
    }
  }

  const unsupported = new Map<string, IdentifierTokenSpan>();
  for (const cluster of clusters.values()) {
    const clusterText = text.slice(cluster.start, cluster.end);
    for (const match of clusterText.matchAll(IDENTIFIER_WORD_PATTERN)) {
      const span = {
        start: cluster.start + match.index,
        end: cluster.start + match.index + match[0].length,
        value: match[0],
      };
      if (spanIndexContains(groundedSpanIndex, span.start, span.end)) {
        continue;
      }
      let possessive = false;
      if (span.value.toLowerCase() === "s") {
        for (
          let groundedEnd = Math.max(0, span.start - 8);
          groundedEnd < span.start;
          groundedEnd += 1
        ) {
          if (!groundedSpanIndex.ends.has(groundedEnd)) continue;
          if (
            /^[^\p{L}\p{N}\p{M}\p{Cf}\p{White_Space}]{0,3}['’]$/u.test(
              text.slice(groundedEnd, span.start),
            )
          ) {
            possessive = true;
            break;
          }
        }
      }
      const quoteAttached =
        groundedSpanIndex.ends.has(span.start - 1) &&
        /^['’]$/u.test(text.slice(span.start - 1, span.start));
      if (quoteAttached && !possessive) {
        unsupported.set(`${span.start}:${span.end}`, span);
        continue;
      }
      if (
        possessive ||
        supportIncludes(supports, span.value) ||
        normalizedSkeletonIncludes(normalizedSkeletons, span.value) ||
        plainSupportIncludes(supports, span.value)
      ) {
        continue;
      }
      unsupported.set(`${span.start}:${span.end}`, span);
    }
  }
  return [...unsupported.values()];
}

const IDENTIFIER_WRAPPERS = [
  ["**", "**"],
  ["__", "__"],
  ["~~", "~~"],
  ["`", "`"],
  ["[", "]"],
  ["(", ")"],
  ["{", "}"],
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["<", ">"],
] as const;

function identifierAffixesAreNarrative(
  prefix: string,
  suffix: string,
  allowEmptyInvocation: boolean,
): boolean {
  for (let iteration = 0; iteration < 20; iteration += 1) {
    let changed = false;
    const withoutSentencePunctuation = suffix.replace(/[.,;:!?…]+$/u, "");
    if (withoutSentencePunctuation !== suffix) {
      suffix = withoutSentencePunctuation;
      changed = true;
    }
    const withoutPossessive = suffix.replace(/['’]s$/iu, "");
    if (withoutPossessive !== suffix) {
      suffix = withoutPossessive;
      changed = true;
    }
    if (allowEmptyInvocation) {
      const withoutInvocation = suffix.replace(/^(?:\(\)|\[\]|\{\})/u, "");
      if (withoutInvocation !== suffix) {
        suffix = withoutInvocation;
        changed = true;
      }
    }
    const wrapper = IDENTIFIER_WRAPPERS.find(
      ([opening, closing]) =>
        prefix.endsWith(opening) &&
        (suffix.startsWith(closing) || suffix.endsWith(closing)),
    );
    if (wrapper !== undefined) {
      const [opening, closing] = wrapper;
      prefix = prefix.slice(0, -opening.length);
      suffix = suffix.startsWith(closing)
        ? suffix.slice(closing.length)
        : suffix.slice(0, -closing.length);
      changed = true;
    }
    if (!changed) break;
  }
  return prefix.length === 0 && suffix.length === 0;
}

function unsupportedIdentifierAffixes(
  text: string,
  groundedSpans: readonly IdentifierTokenSpan[],
  clusterIndex: AttachedTextClusterIndex,
  invocationBangKeys: ReadonlySet<string>,
): IdentifierTokenSpan[] {
  const unsupported = new Map<string, IdentifierTokenSpan>();
  for (const span of groundedSpans) {
    const start = clusterIndex.starts[span.start] ?? span.start;
    const end = clusterIndex.ends[span.end - 1] ?? span.end;
    if (start === span.start && end === span.end) continue;
    const prefix = text.slice(start, span.start);
    const suffix = text.slice(span.end, end);
    if (
      identifierAffixesAreNarrative(
        prefix,
        suffix,
        invocationBangKeys.has(`${span.start}:${span.end}`),
      )
    ) {
      continue;
    }
    unsupported.set(`${start}:${end}`, {
      start,
      end,
      value: text.slice(start, end),
    });
  }
  return [...unsupported.values()];
}

function unsupportedSymbolicIdentifierFragments(
  text: string,
  groundedSpanIndex: IdentifierSpanIndex,
  supports: readonly IdentifierSupport[],
): IdentifierTokenSpan[] {
  const sourceFragments = new Set<string>();
  for (const support of supports) {
    for (const identifier of support.exact) {
      for (const match of identifier.matchAll(
        DISTINCTIVE_IDENTIFIER_SYMBOL_PATTERN,
      )) {
        sourceFragments.add(match[0]);
      }
    }
  }
  if (sourceFragments.size === 0) return [];
  return [...text.matchAll(DISTINCTIVE_IDENTIFIER_SYMBOL_PATTERN)]
    .map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      value: match[0],
    }))
    .filter(
      (span) =>
        sourceFragments.has(span.value) &&
        !spanIndexContains(groundedSpanIndex, span.start, span.end),
    );
}

function plainSkeletonBudget(
  supports: readonly IdentifierSupport[],
): Map<string, number> {
  const budget = new Map<string, number>();
  for (const support of supports) {
    for (const [skeleton, count] of support.plainSkeletonCounts) {
      budget.set(skeleton, Math.max(budget.get(skeleton) ?? 0, count));
    }
  }
  return budget;
}

function normalizedSkeletonIncludes(
  normalizedSkeletons: ReadonlyMap<string, number> | undefined,
  token: string,
): boolean {
  if (normalizedSkeletons === undefined) return false;
  const tokenSkeletons = new Set<string>();
  addIdentifierSkeletons(tokenSkeletons, token);
  return [...tokenSkeletons].some(
    (skeleton) => (normalizedSkeletons.get(skeleton) ?? 0) > 0,
  );
}

function pathSegmentSupportIncludes(
  supports: readonly IdentifierSupport[],
  value: string,
): boolean {
  return supports.some((support) => support.pathSegments.has(value));
}

interface IdentifierSkeletonOccurrence {
  skeleton: string;
  start: number;
  end: number;
  supported: boolean;
}

interface PreparedIdentifierOccurrences {
  occurrences: readonly IdentifierSkeletonOccurrence[];
  candidates: ReadonlySet<string>;
  exceededBudget: boolean;
}

type IdentifierFieldKind =
  | "summary"
  | "entity"
  | "predicate"
  | "literal"
  | "predicate-component";

interface IdentifierFieldPolicy {
  enforceBareBang: boolean;
  enforceSingleCharacterComponents: boolean;
  allowProseComponents: boolean;
  allowNarrativeUriPunctuation: boolean;
  allowPlainComponentSupport: boolean;
}

const IDENTIFIER_FIELD_POLICIES = {
  summary: {
    enforceBareBang: false,
    enforceSingleCharacterComponents: false,
    allowProseComponents: true,
    allowNarrativeUriPunctuation: true,
    allowPlainComponentSupport: true,
  },
  entity: {
    enforceBareBang: true,
    enforceSingleCharacterComponents: true,
    allowProseComponents: false,
    allowNarrativeUriPunctuation: false,
    allowPlainComponentSupport: false,
  },
  predicate: {
    enforceBareBang: true,
    enforceSingleCharacterComponents: false,
    allowProseComponents: false,
    allowNarrativeUriPunctuation: false,
    allowPlainComponentSupport: true,
  },
  literal: {
    enforceBareBang: false,
    enforceSingleCharacterComponents: true,
    allowProseComponents: false,
    allowNarrativeUriPunctuation: false,
    allowPlainComponentSupport: false,
  },
  "predicate-component": {
    enforceBareBang: true,
    enforceSingleCharacterComponents: false,
    allowProseComponents: false,
    allowNarrativeUriPunctuation: false,
    allowPlainComponentSupport: true,
  },
} satisfies Record<IdentifierFieldKind, IdentifierFieldPolicy>;

interface CopiedIdentifierValidationField {
  outputText: string;
  supports: readonly IdentifierSupport[];
  kind: IdentifierFieldKind;
  normalizedSkeletons?: ReadonlyMap<string, number>;
  plainSkeletonBudget?: Map<string, number>;
}

async function prepareIdentifierOccurrences(
  outputText: string,
  supports: readonly IdentifierSupport[],
  workBudget: IdentifierValidationWorkBudget,
  scheduler: CooperativeScheduler,
  maxOccurrences = MAX_PREPARED_IDENTIFIER_OCCURRENCES,
): Promise<PreparedIdentifierOccurrences> {
  if (!consumeIdentifierWork(workBudget, outputText.length)) {
    return { occurrences: [], candidates: new Set(), exceededBudget: true };
  }
  const words: Array<{ start: number; end: number; value: string }> = [];
  for (const match of outputText.matchAll(IDENTIFIER_WORD_PATTERN)) {
    if (scheduler.shouldYield()) await scheduler.yield();
    const word = {
      start: match.index,
      end: match.index + match[0].length,
      value: identifierSkeleton(match[0]) ?? "",
    };
    if (word.value.length > 0) words.push(word);
  }
  const occurrences: Array<{
    skeleton: string;
    start: number;
    end: number;
    componentEligible: boolean;
  }> = [];
  const occurrenceKeys = new Set<string>();
  const candidates = new Set<string>();
  const addOccurrence = (
    skeleton: string,
    start: number,
    end: number,
    componentEligible: boolean,
  ): boolean => {
    const key = `${start}:${end}:${skeleton}`;
    if (occurrenceKeys.has(key)) return true;
    if (occurrences.length >= maxOccurrences) return false;
    occurrenceKeys.add(key);
    occurrences.push({ skeleton, start, end, componentEligible });
    candidates.add(skeleton);
    return true;
  };
  for (const word of words) {
    if (scheduler.shouldYield()) await scheduler.yield();
    if (!addOccurrence(word.value, word.start, word.end, true)) {
      return { occurrences: [], candidates: new Set(), exceededBudget: true };
    }
  }

  for (const support of supports) {
    if (scheduler.shouldYield()) await scheduler.yield();
    let state = 0;
    let runPosition = 0;
    let previousEnd = -1;
    let wordStarts = new Map<number, number>();
    for (const word of words) {
      if (scheduler.shouldYield()) await scheduler.yield();
      if (!consumeIdentifierWork(workBudget, word.value.length + 1)) {
        return { occurrences: [], candidates: new Set(), exceededBudget: true };
      }
      if (
        previousEnd < 0 ||
        !/^\p{White_Space}+$/u.test(outputText.slice(previousEnd, word.start))
      ) {
        state = 0;
        runPosition = 0;
        wordStarts = new Map();
      }
      wordStarts.set(runPosition, word.start);
      for (const character of word.value) {
        while (
          state !== 0 &&
          !support.index.nodes[state]!.children.has(character)
        ) {
          state = support.index.nodes[state]!.failure;
        }
        state = support.index.nodes[state]!.children.get(character) ?? 0;
        runPosition += 1;
      }
      let outputNode = state;
      while (outputNode >= 0) {
        if (!consumeIdentifierWork(workBudget, 1)) {
          return {
            occurrences: [],
            candidates: new Set(),
            exceededBudget: true,
          };
        }
        const node = support.index.nodes[outputNode]!;
        const start = wordStarts.get(runPosition - node.depth);
        if (node.pattern !== null && start !== undefined) {
          if (!addOccurrence(node.pattern, start, word.end, false)) {
            return {
              occurrences: [],
              candidates: new Set(),
              exceededBudget: true,
            };
          }
        }
        outputNode = node.outputLink;
      }
      previousEnd = word.end;
    }
  }

  for (let start = 0; start < words.length; start += 1) {
    if (scheduler.shouldYield()) await scheduler.yield();
    if (codePointLength(words[start]!.value) !== 1) continue;
    if (
      start > 0 &&
      codePointLength(words[start - 1]!.value) === 1 &&
      /^\p{White_Space}+$/u.test(
        outputText.slice(words[start - 1]!.end, words[start]!.start),
      )
    ) {
      continue;
    }
    let skeleton = words[start]!.value;
    let end = start;
    while (
      end + 1 < words.length &&
      codePointLength(words[end + 1]!.value) === 1 &&
      /^\p{White_Space}+$/u.test(
        outputText.slice(words[end]!.end, words[end + 1]!.start),
      )
    ) {
      end += 1;
      skeleton += words[end]!.value;
    }
    if (end > start) {
      if (
        !addOccurrence(skeleton, words[start]!.start, words[end]!.end, true)
      ) {
        return { occurrences: [], candidates: new Set(), exceededBudget: true };
      }
    }
  }

  const componentMatches = new Map<string, boolean>();
  for (const { skeleton, componentEligible } of occurrences) {
    if (scheduler.shouldYield()) await scheduler.yield();
    if (componentMatches.has(skeleton)) continue;
    let matches = supports.some((support) =>
      patternIndexIncludes(support.index, skeleton),
    );
    if (!matches && componentEligible && codePointLength(skeleton) >= 2) {
      for (const support of supports) {
        const result = componentIndexIncludes(
          support.index,
          skeleton,
          true,
          workBudget,
        );
        if (workBudget.exceeded) {
          return {
            occurrences: [],
            candidates: new Set(),
            exceededBudget: true,
          };
        }
        if (result) {
          matches = true;
          break;
        }
      }
    }
    componentMatches.set(skeleton, matches);
  }
  return {
    occurrences: occurrences.map(({ skeleton, start, end }) => ({
      skeleton,
      start,
      end,
      supported: componentMatches.get(skeleton) ?? false,
    })),
    candidates,
    exceededBudget: false,
  };
}

function occurrenceKey(occurrence: IdentifierSkeletonOccurrence): string {
  return `${occurrence.start}:${occurrence.end}:${occurrence.skeleton}`;
}

async function adjacentProseComponentKeys(
  outputText: string,
  occurrences: readonly IdentifierSkeletonOccurrence[],
  supports: readonly IdentifierSupport[],
  scheduler: CooperativeScheduler,
): Promise<Set<string>> {
  const occurrencesByStart = new Map<number, IdentifierSkeletonOccurrence[]>();
  const occurrencesByEnd = new Map<number, IdentifierSkeletonOccurrence[]>();
  for (const occurrence of occurrences) {
    if (scheduler.shouldYield()) await scheduler.yield();
    const starting = occurrencesByStart.get(occurrence.start) ?? [];
    starting.push(occurrence);
    occurrencesByStart.set(occurrence.start, starting);
    const ending = occurrencesByEnd.get(occurrence.end) ?? [];
    ending.push(occurrence);
    occurrencesByEnd.set(occurrence.end, ending);
  }

  const adjacent = new Set<string>();
  for (const [end, leftOccurrences] of occurrencesByEnd) {
    if (scheduler.shouldYield()) await scheduler.yield();
    const whitespace = /^\p{White_Space}+/u.exec(outputText.slice(end));
    if (whitespace === null) continue;
    const rightOccurrences = occurrencesByStart.get(end + whitespace[0].length);
    if (rightOccurrences === undefined) continue;
    for (const support of supports) {
      const ambiguous = support.index.proseAmbiguousComponents;
      const left = leftOccurrences.filter((occurrence) =>
        ambiguous.has(occurrence.skeleton),
      );
      if (left.length === 0) continue;
      const right = rightOccurrences.filter((occurrence) =>
        ambiguous.has(occurrence.skeleton),
      );
      if (right.length === 0) continue;
      for (const occurrence of left) adjacent.add(occurrenceKey(occurrence));
      for (const occurrence of right) adjacent.add(occurrenceKey(occurrence));
    }
  }
  return adjacent;
}

async function sequenceContainsValues(
  sequence: readonly string[],
  values: readonly string[],
  prefixLengths: readonly number[],
  scheduler: CooperativeScheduler,
): Promise<boolean> {
  if (values.length === 0) return sequence.length > 0;
  let matched = 0;
  for (const segment of sequence) {
    if (scheduler.shouldYield()) await scheduler.yield();
    while (matched > 0 && values[matched] !== segment) {
      matched = prefixLengths[matched - 1]!;
    }
    if (values[matched] === segment) matched += 1;
    if (matched === values.length) return true;
  }
  return false;
}

async function valueSequencePrefixLengths(
  values: readonly string[],
  scheduler: CooperativeScheduler,
): Promise<number[]> {
  const prefixLengths = new Array<number>(values.length).fill(0);
  let matched = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (scheduler.shouldYield()) await scheduler.yield();
    while (matched > 0 && values[matched] !== values[index]) {
      matched = prefixLengths[matched - 1]!;
    }
    if (values[matched] === values[index]) matched += 1;
    prefixLengths[index] = matched;
  }
  return prefixLengths;
}

async function alteredIdentifierSkeletons(
  outputText: string,
  prepared: PreparedIdentifierOccurrences,
  outputSpans: readonly IdentifierTokenSpan[],
  supports: readonly IdentifierSupport[],
  oversizedMatches: ReadonlyMap<IdentifierSupport, ReadonlySet<string>>,
  nearMatches: ReadonlyMap<IdentifierSupport, ReadonlySet<string>>,
  plainSkeletonBudget: Map<string, number>,
  scheduler: CooperativeScheduler,
  normalizedSkeletonBudget: Map<string, number> = new Map(),
  allowProseComponents = false,
): Promise<number> {
  let altered = 0;
  const pathReferencesByRange = new Map<string, IdentifierSkeletonOccurrence>();
  for (const occurrence of prepared.occurrences) {
    if (scheduler.shouldYield()) await scheduler.yield();
    const value = outputText.slice(occurrence.start, occurrence.end);
    if (supports.some((support) => support.pathSegments.has(value))) {
      pathReferencesByRange.set(
        `${occurrence.start}:${occurrence.end}`,
        occurrence,
      );
    }
  }
  const pathReferences = [...pathReferencesByRange.values()];
  const pathReferenceCounts = new Map<string, number>();
  for (const occurrence of pathReferences) {
    if (scheduler.shouldYield()) await scheduler.yield();
    const value = outputText.slice(occurrence.start, occurrence.end);
    pathReferenceCounts.set(value, (pathReferenceCounts.get(value) ?? 0) + 1);
  }
  const maximumSourcePathReferenceCounts = new Map<string, number>();
  for (const support of supports) {
    if (scheduler.shouldYield()) await scheduler.yield();
    for (const sequence of support.pathSegmentSequences) {
      const counts = new Map<string, number>();
      for (const segment of sequence) {
        if (scheduler.shouldYield()) await scheduler.yield();
        counts.set(segment, (counts.get(segment) ?? 0) + 1);
      }
      for (const [segment, count] of counts) {
        maximumSourcePathReferenceCounts.set(
          segment,
          Math.max(maximumSourcePathReferenceCounts.get(segment) ?? 0, count),
        );
      }
    }
  }
  const safePathReferences = new Set<string>();
  const sortedPathReferences = [...pathReferences].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const pathReferenceValues: string[] = [];
  for (const occurrence of sortedPathReferences) {
    if (scheduler.shouldYield()) await scheduler.yield();
    pathReferenceValues.push(
      outputText.slice(occurrence.start, occurrence.end),
    );
  }
  let pathReferencesWithinBudgets = true;
  for (const value of pathReferenceValues) {
    if (scheduler.shouldYield()) await scheduler.yield();
    if (
      (pathReferenceCounts.get(value) ?? 0) >
      (maximumSourcePathReferenceCounts.get(value) ?? 0)
    ) {
      pathReferencesWithinBudgets = false;
      break;
    }
  }
  const pathReferencePrefixLengths = await valueSequencePrefixLengths(
    pathReferenceValues,
    scheduler,
  );
  let pathReferencesPreserveSourceOrder = false;
  preserveSourceOrder: for (const support of supports) {
    for (const sequence of support.pathSegmentSequences) {
      if (
        await sequenceContainsValues(
          sequence,
          pathReferenceValues,
          pathReferencePrefixLengths,
          scheduler,
        )
      ) {
        pathReferencesPreserveSourceOrder = true;
        break preserveSourceOrder;
      }
    }
  }
  if (pathReferencesWithinBudgets && pathReferencesPreserveSourceOrder) {
    for (const occurrence of sortedPathReferences) {
      if (scheduler.shouldYield()) await scheduler.yield();
      safePathReferences.add(`${occurrence.start}:${occurrence.end}`);
    }
  }
  const adjacentProseComponents = allowProseComponents
    ? await adjacentProseComponentKeys(
        outputText,
        prepared.occurrences,
        supports,
        scheduler,
      )
    : new Set<string>();
  const proseComponentSupportsBySkeleton = new Map<
    string,
    readonly IdentifierSupport[]
  >();
  const supportedOutputSpanIndex = identifierSpanIndex(
    outputText.length,
    outputSpans.filter(
      (span) =>
        supportIncludes(supports, span.value) ||
        pathSegmentSupportIncludes(supports, span.value),
    ),
  );
  for (const occurrence of prepared.occurrences) {
    if (scheduler.shouldYield()) await scheduler.yield();
    const { skeleton } = occurrence;
    const exactOccurrence = outputText.slice(occurrence.start, occurrence.end);
    const pathReference = supports.some((support) =>
      support.pathSegments.has(exactOccurrence),
    );
    const pathReferenceKey = `${occurrence.start}:${occurrence.end}`;
    if (pathReference && safePathReferences.has(pathReferenceKey)) {
      continue;
    }
    let proseComponentSupports = proseComponentSupportsBySkeleton.get(skeleton);
    if (proseComponentSupports === undefined) {
      proseComponentSupports = supports.filter((support) =>
        support.index.proseAmbiguousComponents.has(skeleton),
      );
      proseComponentSupportsBySkeleton.set(skeleton, proseComponentSupports);
    }
    const adjacentProseComponent = adjacentProseComponents.has(
      occurrenceKey(occurrence),
    );
    const oversizedIdentifierComponent = supports.some((support) =>
      oversizedMatches.get(support)?.has(skeleton),
    );
    const nearIdentifierComponent = supports.some((support) =>
      nearMatches.get(support)?.has(skeleton),
    );
    const unsupportedIdentifierComponent =
      oversizedIdentifierComponent || nearIdentifierComponent;
    if (
      allowProseComponents &&
      proseComponentSupports.length > 0 &&
      !adjacentProseComponent &&
      !nearIdentifierComponent &&
      codePointLength(skeleton) >= 2 &&
      /^\p{Ll}[\p{Ll}\p{M}\p{Cf}]*$/u.test(exactOccurrence)
    ) {
      continue;
    }
    if (!occurrence.supported && !unsupportedIdentifierComponent) {
      continue;
    }
    const normalizedOccurrencesRemaining =
      normalizedSkeletonBudget.get(skeleton) ?? 0;
    if (normalizedOccurrencesRemaining > 0) {
      normalizedSkeletonBudget.set(
        skeleton,
        normalizedOccurrencesRemaining - 1,
      );
      continue;
    }
    const containedBySupportedToken = spanIndexContains(
      supportedOutputSpanIndex,
      occurrence.start,
      occurrence.end,
    );
    if (containedBySupportedToken) continue;
    if (pathReference) {
      altered += 1;
      continue;
    }
    const plainOccurrencesRemaining = plainSkeletonBudget.get(skeleton) ?? 0;
    if (plainOccurrencesRemaining > 0) {
      plainSkeletonBudget.set(skeleton, plainOccurrencesRemaining - 1);
      continue;
    }
    altered += 1;
  }
  return altered;
}

async function normalizeExtractedPaths(
  result: { summary: string; claims: readonly ExtractedClaim[] },
  sourceTexts: readonly string[],
  sourceIdentifiers: ReadonlySet<string>,
  scheduler: CooperativeScheduler,
): Promise<{
  result: { summary: string; claims: ExtractedClaim[] };
  normalizedPaths: number;
}> {
  const sourceFilenames = new Set<string>();
  for (const text of sourceTexts) {
    if (scheduler.shouldYield(IDENTIFIER_VALIDATION_CHECK_INTERVAL)) {
      await scheduler.yield();
    }
    for (const match of text.matchAll(SOURCE_CODE_FILENAME_PATTERN)) {
      if (scheduler.shouldYield()) await scheduler.yield();
      sourceFilenames.add(match[1]!);
    }
  }

  let normalizedPaths = 0;
  const normalize = (text: string): string =>
    text.replace(ABSOLUTE_PATH_PATTERN, (path) => {
      if (sourceIdentifiers.has(path)) return path;
      const filename = path.slice(path.lastIndexOf("/") + 1);
      if (!sourceFilenames.has(filename)) return path;
      normalizedPaths += 1;
      return filename;
    });
  const claims = result.claims.map((claim): ExtractedClaim => {
    const common = {
      ...claim,
      subject: normalize(claim.subject),
      predicate: normalize(claim.predicate),
    };
    return claim.object_entity === null
      ? {
          ...common,
          object_entity: null,
          object_value: normalize(claim.object_value),
        }
      : {
          ...common,
          object_entity: normalize(claim.object_entity),
          object_value: null,
        };
  });
  return {
    result: { summary: normalize(result.summary), claims },
    normalizedPaths,
  };
}

async function validateSourceIdentifiers(
  logger: IdentifierValidationLogger,
  scheduler: CooperativeScheduler,
  model: string,
  result: { summary: string; claims: readonly ExtractedClaim[] },
  support: IdentifierSupport,
  predicateSkeletons: readonly ReadonlyMap<string, number>[],
  additionalFields: readonly CopiedIdentifierValidationField[] = [],
): Promise<void> {
  const fields: CopiedIdentifierValidationField[] = [...additionalFields];
  const add = (
    outputText: string,
    kind: IdentifierFieldKind,
    normalizedSkeletons?: ReadonlyMap<string, number>,
  ): void => {
    fields.push({
      outputText,
      supports: [support],
      kind,
      normalizedSkeletons,
    });
  };
  add(result.summary, "summary");
  for (const [index, claim] of result.claims.entries()) {
    add(claim.subject, "entity");
    add(claim.predicate, "predicate", predicateSkeletons[index]);
    if (claim.object_entity !== null) {
      add(claim.object_entity, "entity");
    }
    if (claim.object_value !== null) {
      add(claim.object_value, "literal");
    }
  }
  await validateCopiedIdentifierBatch(
    logger,
    scheduler,
    fields,
    "extraction altered source identifiers",
    model,
  );
}

async function validateCopiedIdentifierBatch(
  logger: IdentifierValidationLogger,
  scheduler: CooperativeScheduler,
  fields: readonly CopiedIdentifierValidationField[],
  logMessage: string,
  model: string,
): Promise<void> {
  const preparedFields: Array<{
    field: CopiedIdentifierValidationField;
    prepared: PreparedIdentifierOccurrences;
  }> = [];
  const candidatesBySupport = new Map<IdentifierSupport, Set<string>>();
  let remainingOccurrences = MAX_PREPARED_IDENTIFIER_OCCURRENCES;
  const workBudget: IdentifierValidationWorkBudget = {
    remaining: MAX_IDENTIFIER_VALIDATION_WORK,
    exceeded: false,
  };
  const rejectForBudget = (): never => {
    logger.warn(logMessage, {
      model,
      unknownIdentifiers: 1,
      validationBudgetExceeded: true,
    });
    throw new IdentifierValidationFailure();
  };
  for (const field of fields) {
    if (scheduler.shouldYield()) await scheduler.yield();
    const prepared = await prepareIdentifierOccurrences(
      field.outputText,
      field.supports,
      workBudget,
      scheduler,
      remainingOccurrences,
    );
    if (prepared.exceededBudget) {
      rejectForBudget();
    }
    remainingOccurrences -= prepared.occurrences.length;
    preparedFields.push({ field, prepared });
    for (const support of field.supports) {
      let candidates = candidatesBySupport.get(support);
      if (candidates === undefined) {
        candidates = new Set();
        candidatesBySupport.set(support, candidates);
      }
      for (const candidate of prepared.candidates) candidates.add(candidate);
    }
  }
  const oversizedMatches = new Map<IdentifierSupport, ReadonlySet<string>>();
  const nearMatches = new Map<IdentifierSupport, ReadonlySet<string>>();
  for (const [support, candidates] of candidatesBySupport) {
    if (scheduler.shouldYield()) await scheduler.yield();
    oversizedMatches.set(
      support,
      await oversizedIdentifierMatches(candidates, [support], scheduler),
    );
    nearMatches.set(
      support,
      await nearIdentifierMatches(candidates, support, workBudget, scheduler),
    );
    if (workBudget.exceeded) rejectForBudget();
  }
  for (const { field, prepared } of preparedFields) {
    if (scheduler.shouldYield()) await scheduler.yield();
    await validateCopiedIdentifiers(
      logger,
      scheduler,
      field,
      prepared,
      oversizedMatches,
      nearMatches,
      workBudget,
      logMessage,
      model,
    );
  }
}

async function validateCopiedIdentifiers(
  logger: IdentifierValidationLogger,
  scheduler: CooperativeScheduler,
  field: CopiedIdentifierValidationField,
  prepared: PreparedIdentifierOccurrences,
  oversizedMatches: ReadonlyMap<IdentifierSupport, ReadonlySet<string>>,
  nearMatches: ReadonlyMap<IdentifierSupport, ReadonlySet<string>>,
  workBudget: IdentifierValidationWorkBudget,
  logMessage: string,
  model: string,
): Promise<void> {
  const {
    outputText,
    supports,
    normalizedSkeletons,
    plainSkeletonBudget: existingPlainSkeletonBudget,
  } = field;
  const {
    enforceBareBang,
    enforceSingleCharacterComponents,
    allowProseComponents,
    allowNarrativeUriPunctuation,
    allowPlainComponentSupport,
  } = IDENTIFIER_FIELD_POLICIES[field.kind];
  if (!allowPlainComponentSupport) {
    for (const support of supports) {
      if (
        await supportContainsBoundedExactText(
          support,
          outputText,
          workBudget,
          scheduler,
        )
      ) {
        return;
      }
    }
  }
  if (workBudget.exceeded) {
    logger.warn(logMessage, {
      model,
      unknownIdentifiers: 1,
      validationBudgetExceeded: true,
    });
    throw new IdentifierValidationFailure();
  }
  const permitsPlainComponentSupport =
    allowPlainComponentSupport ||
    (enforceBareBang && /^[\p{L}\p{N}\p{M}\p{Cf}_]+!$/u.test(outputText));
  const outputSpans = copiedSourceTokenSpans(
    outputText,
    undefined,
    allowNarrativeUriPunctuation,
  );
  const unknownIdentifiers = outputSpans.filter(
    (span) =>
      !supportIncludes(supports, span.value) &&
      !normalizedSkeletonIncludes(normalizedSkeletons, span.value) &&
      !pathSegmentSupportIncludes(supports, span.value),
  );
  const exactBangSpans = [
    ...terminalBangTokenSpans(outputText),
    ...codeBangTokenSpans(outputText),
  ].filter(
    (span) =>
      supportIncludes(supports, span.value) ||
      normalizedSkeletonIncludes(normalizedSkeletons, span.value) ||
      pathSegmentSupportIncludes(supports, span.value),
  );
  const syntacticBangKeys = new Set(
    syntacticBangTokenSpans(outputText).map(
      (span) => `${span.start}:${span.end}`,
    ),
  );
  const bangCandidates = new Map<string, IdentifierTokenSpan>();
  for (const span of codeBangTokenSpans(outputText)) {
    bangCandidates.set(`${span.start}:${span.end}`, span);
  }
  if (enforceBareBang) {
    for (const span of terminalBangTokenSpans(outputText)) {
      bangCandidates.set(`${span.start}:${span.end}`, span);
    }
  }
  const unsupportedBangIdentifiers = [...bangCandidates.values()].filter(
    (span) => {
      if (
        supportIncludes(supports, span.value) ||
        normalizedSkeletonIncludes(normalizedSkeletons, span.value)
      ) {
        return false;
      }
      if (syntacticBangKeys.has(`${span.start}:${span.end}`)) return true;
      return (
        !permitsPlainComponentSupport ||
        !plainSupportIncludes(supports, span.value)
      );
    },
  );
  const groundedSpans = [...outputSpans, ...exactBangSpans].filter(
    (span) =>
      supportIncludes(supports, span.value) ||
      normalizedSkeletonIncludes(normalizedSkeletons, span.value),
  );
  const groundedSpanIndex = identifierSpanIndex(
    outputText.length,
    groundedSpans,
  );
  const clusterIndex = attachedTextClusterIndex(outputText);
  const unsupportedAttachments = unsupportedAttachedIdentifierWords(
    outputText,
    groundedSpans,
    groundedSpanIndex,
    clusterIndex,
    supports,
    normalizedSkeletons,
  );
  const unsupportedAffixes = unsupportedIdentifierAffixes(
    outputText,
    groundedSpans,
    clusterIndex,
    syntacticBangKeys,
  );
  const unsupportedSymbolicFragments = unsupportedSymbolicIdentifierFragments(
    outputText,
    groundedSpanIndex,
    supports,
  );
  const supportedOutputSpanIndex = identifierSpanIndex(
    outputText.length,
    outputSpans.filter(
      (span) =>
        supportIncludes(supports, span.value) ||
        normalizedSkeletonIncludes(normalizedSkeletons, span.value) ||
        pathSegmentSupportIncludes(supports, span.value),
    ),
  );
  const unsupportedSingleCharacterComponents: IdentifierSkeletonOccurrence[] =
    [];
  for (const occurrence of prepared.occurrences) {
    if (scheduler.shouldYield()) await scheduler.yield();
    if (codePointLength(occurrence.skeleton) !== 1) continue;
    if (
      !enforceSingleCharacterComponents &&
      outputText.trim() !== outputText.slice(occurrence.start, occurrence.end)
    ) {
      if (["a", "i"].includes(occurrence.skeleton)) continue;
      if (
        !supports.some((support) =>
          support.index.typoSensitiveSingleCharacterComponents.has(
            occurrence.skeleton,
          ),
        )
      ) {
        continue;
      }
    }
    if (
      permitsPlainComponentSupport &&
      plainSupportIncludes(supports, occurrence.skeleton)
    ) {
      continue;
    }
    if (
      spanIndexContains(
        supportedOutputSpanIndex,
        occurrence.start,
        occurrence.end,
      )
    ) {
      continue;
    }
    if (
      supports.some((support) =>
        componentIndexIncludes(
          support.index,
          occurrence.skeleton,
          true,
          workBudget,
        ),
      )
    ) {
      unsupportedSingleCharacterComponents.push(occurrence);
    }
  }
  if (workBudget.exceeded) {
    logger.warn(logMessage, {
      model,
      unknownIdentifiers: 1,
      validationBudgetExceeded: true,
    });
    throw new IdentifierValidationFailure();
  }
  const alteredSkeletons = await alteredIdentifierSkeletons(
    outputText,
    prepared,
    [...outputSpans, ...exactBangSpans],
    supports,
    oversizedMatches,
    nearMatches,
    existingPlainSkeletonBudget ??
      (permitsPlainComponentSupport
        ? plainSkeletonBudget(supports)
        : new Map()),
    scheduler,
    new Map(normalizedSkeletons),
    allowProseComponents,
  );
  if (
    unknownIdentifiers.length === 0 &&
    unsupportedBangIdentifiers.length === 0 &&
    unsupportedAttachments.length === 0 &&
    unsupportedAffixes.length === 0 &&
    unsupportedSymbolicFragments.length === 0 &&
    unsupportedSingleCharacterComponents.length === 0 &&
    alteredSkeletons === 0
  )
    return;
  logger.warn(logMessage, {
    model,
    unknownIdentifiers:
      unknownIdentifiers.length +
      unsupportedBangIdentifiers.length +
      unsupportedAttachments.length +
      unsupportedAffixes.length +
      unsupportedSymbolicFragments.length +
      unsupportedSingleCharacterComponents.length +
      alteredSkeletons,
  });
  throw new IdentifierValidationFailure();
}

export class IdentifierValidationSession {
  readonly #source: Awaited<ReturnType<typeof sourceIdentifierSupport>>;
  readonly #model: string;
  readonly #logger: IdentifierValidationLogger;
  readonly #scheduler: CooperativeScheduler;
  #support: IdentifierSupport | null = null;
  #predicateSkeletons: readonly ReadonlyMap<string, number>[] = [];
  #rawPredicateFields: readonly CopiedIdentifierValidationField[] = [];

  private constructor(
    source: Awaited<ReturnType<typeof sourceIdentifierSupport>>,
    model: string,
    logger: IdentifierValidationLogger,
    scheduler: CooperativeScheduler,
  ) {
    this.#source = source;
    this.#model = model;
    this.#logger = logger;
    this.#scheduler = scheduler;
  }

  static async create(
    request: SegmentCreate,
    model: string,
    logger: IdentifierValidationLogger,
  ): Promise<IdentifierValidationSession> {
    const scheduler = new CooperativeScheduler();
    try {
      return new IdentifierValidationSession(
        await sourceIdentifierSupport(request, scheduler),
        model,
        logger,
        scheduler,
      );
    } catch (error) {
      if (!(error instanceof SourceIdentifierBudgetError)) throw error;
      logger.warn("source identifier budget exceeded", {
        model,
        validationBudgetExceeded: true,
      });
      throw new TerminalExtractionValidationError(
        "source identifier validation budget exceeded",
      );
    }
  }

  async prepare(claims: readonly ExtractionWireClaim[]): Promise<void> {
    const sourceIdentifiers = this.#source.identifiers;
    const support = await identifierSupport(
      sourceIdentifiers,
      this.#scheduler,
      this.#source.plainSkeletons,
      this.#source.sourceTexts,
      this.#source.structuredToolKeys,
      this.#source.structuredToolKeyTranspositions,
    );
    const rawPredicateFields: CopiedIdentifierValidationField[] = [];
    for (const claim of claims) {
      if (this.#scheduler.shouldYield()) await this.#scheduler.yield();
      if (sourceIdentifiers.has(claim.predicate)) continue;
      const predicatePlainBudget = plainSkeletonBudget([support]);
      for (const component of claim.predicate.split(/[\s_]+/u)) {
        rawPredicateFields.push({
          outputText: component,
          supports: [support],
          kind: "predicate-component",
          plainSkeletonBudget: predicatePlainBudget,
        });
      }
    }
    this.#support = support;
    this.#predicateSkeletons = claims.map((claim) =>
      normalizedPredicateSkeletons(claim.predicate, sourceIdentifiers),
    );
    this.#rawPredicateFields = rawPredicateFields;
  }

  async normalizePaths(result: {
    summary: string;
    claims: readonly ExtractedClaim[];
  }): Promise<{
    result: { summary: string; claims: ExtractedClaim[] };
    normalizedPaths: number;
  }> {
    return normalizeExtractedPaths(
      result,
      this.#source.sourceTexts.map((source) => source.text),
      this.#source.identifiers,
      this.#scheduler,
    );
  }

  async validate(
    result: ExtractionResult,
  ): Promise<ValidatedExtractionResult | null> {
    if (this.#support === null) {
      throw new TypeError("identifier validation must be prepared first");
    }
    try {
      await validateSourceIdentifiers(
        this.#logger,
        this.#scheduler,
        this.#model,
        result,
        this.#support,
        this.#predicateSkeletons,
        this.#rawPredicateFields,
      );
      return result as ValidatedExtractionResult;
    } catch (error) {
      if (error instanceof IdentifierValidationFailure) return null;
      throw error;
    }
  }
}
