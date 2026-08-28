import { codePointLength } from "@reflection/shared/contracts";

import {
  IDENTIFIER_VALIDATION_CHECK_INTERVAL,
  type CooperativeScheduler,
} from "./identifier-validation-scheduler.js";

export const ABSOLUTE_PATH_PATTERN =
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_/:])\/(?!\/)[\p{L}\p{N}\p{M}\p{Cf}._~!$&'()*+=:@%/-]+(?![\p{L}\p{N}\p{M}\p{Cf}_])/gu;
export const SOURCE_URI_PATTERN =
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_])(?:[A-Za-z][A-Za-z0-9+.-]{0,63}:|\/\/)[^\\\s<>"`\]]+/gu;
const WINDOWS_PATH_PATTERN =
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_])(?:[A-Za-z]:\\|\\\\)[^\s<>"`]+/gu;
const CONNECTED_IDENTIFIER_PATTERN =
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_@#$./／∕⁄\\:~%+&=?‐‑‒–—﹘﹣－-])(?:[_@#$./／∕⁄\\:~%+&=?‐‑‒–—﹘﹣－-]+)?[\p{L}\p{N}\p{M}\p{Cf}]+(?:[_@#$./／∕⁄\\:~%+&=?‐‑‒–—﹘﹣－-]+[\p{L}\p{N}\p{M}\p{Cf}]+)+(?![\p{L}\p{N}\p{M}\p{Cf}_@#$/／∕⁄\\:~%+&=?‐‑‒–—﹘﹣－-])/gu;
export const DISTINCTIVE_IDENTIFIER_SYMBOL_PATTERN = /\+\+|[#@$]|_+/gu;
const COPIED_TOKEN_PATTERNS = [
  WINDOWS_PATH_PATTERN,
  ABSOLUTE_PATH_PATTERN,
  CONNECTED_IDENTIFIER_PATTERN,
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_])[A-Za-z][A-Za-z0-9]*(?:\+\+|#)(?![\p{L}\p{N}\p{M}\p{Cf}_+#])/gu,
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_])[\p{L}_][\p{L}\p{N}\p{M}\p{Cf}_]*!(?=[([{])/gu,
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_.])\.[\p{L}][\p{L}\p{N}\p{M}\p{Cf}_-]*(?![\p{L}\p{N}\p{M}\p{Cf}_])/gu,
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_#@$])(?:#[0-9][\p{L}\p{N}\p{M}\p{Cf}_-]*|[$@_]+[\p{L}][\p{L}\p{N}\p{M}\p{Cf}_$]*)(?![\p{L}\p{N}\p{M}\p{Cf}_$])/gu,
  /(?<![\p{L}\p{N}\p{M}\p{Cf}-])(?=[0-9a-f]{7,64}(?![\p{L}\p{N}\p{M}\p{Cf}-]))(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}(?![\p{L}\p{N}\p{M}\p{Cf}-])/giu,
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_])\p{Ll}+\p{Lu}[\p{L}\p{N}\p{M}\p{Cf}]*(?![\p{L}\p{N}\p{M}\p{Cf}_])/gu,
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_])\p{Lu}[\p{Ll}\p{N}\p{M}\p{Cf}]+(?:\p{Lu}[\p{L}\p{N}\p{M}\p{Cf}]*)+(?![\p{L}\p{N}\p{M}\p{Cf}_])/gu,
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_])\p{Lu}{2,}\p{Ll}[\p{L}\p{N}\p{M}\p{Cf}]*(?![\p{L}\p{N}\p{M}\p{Cf}_])/gu,
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_])\p{Lu}{2,}(?:_[\p{Lu}\p{N}]+)*(?![\p{L}\p{N}\p{M}\p{Cf}_])/gu,
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_])(?=[\p{L}\p{N}\p{M}\p{Cf}]*\p{L})(?=[\p{L}\p{N}\p{M}\p{Cf}]*\p{N})[\p{L}\p{N}\p{M}\p{Cf}]+(?![\p{L}\p{N}\p{M}\p{Cf}_])/gu,
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_])[\p{L}][\p{L}\p{N}\p{M}\p{Cf}_]*(?:[．。․][\p{L}\p{N}\p{M}\p{Cf}_]+)+(?![\p{L}\p{N}\p{M}\p{Cf}_])/gu,
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_])(?:README|CHANGELOG|LICENSE|NOTICE|Makefile|Dockerfile|Brewfile|Gemfile|Procfile|Rakefile|Justfile)(?![\p{L}\p{N}\p{M}\p{Cf}_])/gu,
] as const;
export const SOURCE_CODE_FILENAME_PATTERN =
  /(?<!`)\x60([A-Za-z0-9._~!$&'()*+=:@%-]+)\x60(?!`)/gu;
const BACKTICK_IDENTIFIER_PATTERN = /(?<!`)`([^`\r\n\s]+)`(?!`)/gu;
const CLI_OPTION_PATTERN =
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_-])--?[\p{L}\p{N}\p{M}\p{Cf}_]+(?:[-_.:=][\p{L}\p{N}\p{M}\p{Cf}_]+)*(?![\p{L}\p{N}\p{M}\p{Cf}_-])/gu;
const TRAILING_PATH_SEPARATOR_PATTERN =
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_])[\p{L}_][\p{L}\p{N}\p{M}\p{Cf}_]*[\\/](?![\\/\p{L}\p{N}\p{M}\p{Cf}_])/gu;
export const IDENTIFIER_WORD_PATTERN = /[\p{L}\p{N}\p{M}\p{Cf}]+/gu;
const TERMINAL_BANG_IDENTIFIER_PATTERN =
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_])[\p{L}_][\p{L}\p{N}\p{M}\p{Cf}_]*!(?![\p{L}\p{N}\p{M}\p{Cf}_!])/gu;
const SPACED_BANG_INVOCATION_PATTERN =
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_])[\p{L}_][\p{L}\p{N}\p{M}\p{Cf}_]*\s+!(?=\s*[(\[{])/gu;
export const MAX_IDENTIFIER_SOURCE_CHARACTERS = 10_000;

export interface IdentifierTokenSpan {
  start: number;
  end: number;
  value: string;
}

export interface SourceIdentifierBudget {
  remaining: number;
}

export class SourceIdentifierBudgetError extends Error {
  constructor() {
    super("source identifier budget exceeded");
    this.name = "SourceIdentifierBudgetError";
  }
}

export function consumeSourceIdentifierUnit(
  budget?: SourceIdentifierBudget,
): void {
  if (budget === undefined) return;
  budget.remaining -= 1;
  if (budget.remaining < 0) throw new SourceIdentifierBudgetError();
}

interface IndexedRegExpMatchArray extends RegExpMatchArray {
  index: number;
}

type CandidateForMatch = (
  match: IndexedRegExpMatchArray,
) => IdentifierTokenSpan | null;

interface IdentifierTokenCandidateStream {
  matches: IterableIterator<IndexedRegExpMatchArray>;
  candidateForMatch: CandidateForMatch;
}

function identifierTokenCandidateStream(
  text: string,
  pattern: RegExp,
  candidateForMatch: CandidateForMatch,
): IdentifierTokenCandidateStream {
  return {
    matches: text.matchAll(
      pattern,
    ) as IterableIterator<IndexedRegExpMatchArray>,
    candidateForMatch,
  };
}

function fullMatchCandidate(
  match: IndexedRegExpMatchArray,
): IdentifierTokenSpan {
  return {
    start: match.index,
    end: match.index + match[0].length,
    value: match[0],
  };
}

function collectCandidateStream(
  stream: IdentifierTokenCandidateStream,
  sourceBudget?: SourceIdentifierBudget,
): IdentifierTokenSpan[] {
  const candidates: IdentifierTokenSpan[] = [];
  for (const match of stream.matches) {
    const candidate = stream.candidateForMatch(match);
    if (candidate === null) continue;
    consumeSourceIdentifierUnit(sourceBudget);
    candidates.push(candidate);
  }
  return candidates;
}

async function collectCandidateStreamCooperatively(
  textLength: number,
  stream: IdentifierTokenCandidateStream,
  scheduler: CooperativeScheduler,
  sourceBudget?: SourceIdentifierBudget,
): Promise<IdentifierTokenSpan[]> {
  const candidates: IdentifierTokenSpan[] = [];
  let scannedThrough = 0;
  for (const match of stream.matches) {
    const matchEnd = match.index + match[0].length;
    if (scheduler.shouldYield(Math.max(1, matchEnd - scannedThrough))) {
      await scheduler.yield();
    }
    scannedThrough = matchEnd;
    const candidate = stream.candidateForMatch(match);
    if (candidate !== null) {
      consumeSourceIdentifierUnit(sourceBudget);
      candidates.push(candidate);
    }
    if (scheduler.shouldYield(Math.max(1, match[0].length))) {
      await scheduler.yield();
    }
  }
  if (
    scheduler.shouldYield(
      Math.max(
        IDENTIFIER_VALIDATION_CHECK_INTERVAL,
        textLength - scannedThrough,
      ),
    )
  ) {
    await scheduler.yield();
  }
  return candidates;
}

function terminalBangCandidateStream(
  text: string,
): IdentifierTokenCandidateStream {
  return identifierTokenCandidateStream(
    text,
    TERMINAL_BANG_IDENTIFIER_PATTERN,
    fullMatchCandidate,
  );
}

function spacedBangCandidateStream(
  text: string,
): IdentifierTokenCandidateStream {
  return identifierTokenCandidateStream(
    text,
    SPACED_BANG_INVOCATION_PATTERN,
    fullMatchCandidate,
  );
}

function isSyntacticTerminalBang(
  text: string,
  span: IdentifierTokenSpan,
): boolean {
  return (
    (text[span.start - 1] === "`" && text[span.end] === "`") ||
    /^[(\[{]/u.test(text[span.end] ?? "")
  );
}

function syntacticBangTokenSpansFromScans(
  text: string,
  terminalSpans: readonly IdentifierTokenSpan[],
  spacedSpans: readonly IdentifierTokenSpan[],
): IdentifierTokenSpan[] {
  return [
    ...terminalSpans.filter((span) => isSyntacticTerminalBang(text, span)),
    ...spacedSpans,
  ];
}

export function terminalBangTokenSpans(text: string): IdentifierTokenSpan[] {
  return collectCandidateStream(terminalBangCandidateStream(text));
}

export function syntacticBangTokenSpans(text: string): IdentifierTokenSpan[] {
  return syntacticBangTokenSpansFromScans(
    text,
    terminalBangTokenSpans(text),
    collectCandidateStream(spacedBangCandidateStream(text)),
  );
}

export function codeBangTokenSpans(text: string): IdentifierTokenSpan[] {
  const terminalSpans = terminalBangTokenSpans(text);
  const spans = new Map<string, IdentifierTokenSpan>();
  for (const span of syntacticBangTokenSpansFromScans(
    text,
    terminalSpans,
    collectCandidateStream(spacedBangCandidateStream(text)),
  )) {
    spans.set(`${span.start}:${span.end}`, span);
  }
  for (const span of terminalSpans) {
    const completePrefix = text.slice(0, span.start);
    const clauseStart = Math.max(
      completePrefix.lastIndexOf("."),
      completePrefix.lastIndexOf("?"),
      completePrefix.lastIndexOf("!"),
      completePrefix.lastIndexOf("\n"),
    );
    const prefix = completePrefix.slice(clauseStart + 1);
    const suffix = text.slice(span.end);
    const suffixClause = suffix.split(/[.!?\n]/u, 1)[0] ?? "";
    const linkedSuffix =
      (/^\s*(?:is|was|remains|acts|serves|as)\b/u.test(suffixClause) &&
        /^\s*[^.!?\n]{0,80}\b(?:macro|function|command)s?\b/iu.test(
          suffixClause,
        )) ||
      /^\s*[,—:-]\s*[^.!?\n]{0,40}\b(?:macro|function|command)s?\b/iu.test(
        suffixClause,
      );
    if (
      /\b(?:macro|function|command)s?\b/iu.test(prefix) ||
      linkedSuffix ||
      (/^[\p{Ll}_]/u.test(span.value) &&
        /\b(?:macro|function|command)s?\b/iu.test(suffixClause))
    ) {
      spans.set(`${span.start}:${span.end}`, span);
    }
  }
  return [...spans.values()];
}

export function identifierBangTokenSpans(text: string): IdentifierTokenSpan[] {
  const terminalSpans = terminalBangTokenSpans(text);
  const spans = new Map<string, IdentifierTokenSpan>();
  for (const span of syntacticBangTokenSpansFromScans(
    text,
    terminalSpans,
    collectCandidateStream(spacedBangCandidateStream(text)),
  )) {
    spans.set(`${span.start}:${span.end}`, span);
  }
  for (const span of terminalSpans) {
    if (span.value.includes("_")) spans.set(`${span.start}:${span.end}`, span);
  }
  return [...spans.values()];
}

export async function cooperativeIdentifierBangTokenSpans(
  text: string,
  scheduler: CooperativeScheduler,
  sourceBudget?: SourceIdentifierBudget,
): Promise<IdentifierTokenSpan[]> {
  const terminalSpans = await collectCandidateStreamCooperatively(
    text.length,
    terminalBangCandidateStream(text),
    scheduler,
  );
  const spacedSpans = await collectCandidateStreamCooperatively(
    text.length,
    spacedBangCandidateStream(text),
    scheduler,
  );
  const spans = new Map<string, IdentifierTokenSpan>();
  for (const span of terminalSpans) {
    if (scheduler.shouldYield()) await scheduler.yield();
    if (isSyntacticTerminalBang(text, span)) {
      spans.set(`${span.start}:${span.end}`, span);
    }
  }
  for (const span of spacedSpans) {
    if (scheduler.shouldYield()) await scheduler.yield();
    spans.set(`${span.start}:${span.end}`, span);
  }
  for (const span of terminalSpans) {
    if (scheduler.shouldYield()) await scheduler.yield();
    if (span.value.includes("_")) spans.set(`${span.start}:${span.end}`, span);
  }
  const result = [...spans.values()];
  for (const _span of result) {
    if (scheduler.shouldYield()) await scheduler.yield();
    consumeSourceIdentifierUnit(sourceBudget);
  }
  return result;
}

function sourceUriCandidate(
  text: string,
  match: IndexedRegExpMatchArray,
  trimNarrativeUriPunctuation: boolean,
): IdentifierTokenSpan | null {
  const previous = text[match.index - 1];
  let uri = match[0];
  let literallyDelimited = false;
  for (const [opening, closing] of [
    ["'", "'"],
    ["‘", "’"],
    ["“", "”"],
  ] as const) {
    const punctuationStart = uri.search(/[.,]*$/u);
    if (
      previous === opening &&
      uri.slice(0, punctuationStart).endsWith(closing)
    ) {
      uri = uri.slice(0, punctuationStart - closing.length);
      literallyDelimited = true;
      break;
    }
  }
  const enclosingSuffix =
    previous === "("
      ? /\)[.,]*$/u.exec(uri)
      : previous === "{"
        ? /\}[.,]*$/u.exec(uri)
        : null;
  if (enclosingSuffix !== null) {
    uri = uri.slice(0, enclosingSuffix.index);
    literallyDelimited = true;
  }
  const following = text[match.index + match[0].length];
  literallyDelimited ||=
    (previous === '"' && following === '"') ||
    (previous === "`" && following === "`") ||
    (previous === "<" && following === ">") ||
    (previous === "[" && following === "]");
  const value =
    trimNarrativeUriPunctuation && !literallyDelimited
      ? trimNarrativeIdentifierPunctuation(uri)
      : uri;
  return value.length === 0
    ? null
    : {
        start: match.index,
        end: match.index + value.length,
        value,
      };
}

function copiedPatternCandidate(
  text: string,
  pattern: (typeof COPIED_TOKEN_PATTERNS)[number],
  match: IndexedRegExpMatchArray,
  trimNarrativeUriPunctuation: boolean,
): IdentifierTokenSpan | null {
  let value = match[0];
  if (
    trimNarrativeUriPunctuation &&
    (pattern === WINDOWS_PATH_PATTERN || pattern === ABSOLUTE_PATH_PATTERN)
  ) {
    const previous = text[match.index - 1];
    const following = text[match.index + value.length];
    const explicitlyDelimited =
      (previous === '"' && following === '"') ||
      (previous === "`" && following === "`") ||
      (previous === "<" && following === ">") ||
      (previous === "[" && following === "]");
    if (!explicitlyDelimited) {
      if (previous === "'" && value.endsWith("'")) {
        value = value.slice(0, -1);
      } else {
        value = trimNarrativeIdentifierPunctuation(value);
      }
    }
  }
  return value.length === 0
    ? null
    : {
        start: match.index,
        end: match.index + value.length,
        value,
      };
}

function backtickIdentifierCandidate(
  match: IndexedRegExpMatchArray,
): IdentifierTokenSpan {
  const value = match[1]!;
  return {
    start: match.index + 1,
    end: match.index + 1 + value.length,
    value,
  };
}

function copiedSourceCandidateStreams(
  text: string,
  trimNarrativeUriPunctuation: boolean,
): IdentifierTokenCandidateStream[] {
  return [
    identifierTokenCandidateStream(text, SOURCE_URI_PATTERN, (match) =>
      sourceUriCandidate(text, match, trimNarrativeUriPunctuation),
    ),
    ...COPIED_TOKEN_PATTERNS.map((pattern) =>
      identifierTokenCandidateStream(text, pattern, (match) =>
        copiedPatternCandidate(
          text,
          pattern,
          match,
          trimNarrativeUriPunctuation,
        ),
      ),
    ),
    identifierTokenCandidateStream(
      text,
      CLI_OPTION_PATTERN,
      fullMatchCandidate,
    ),
    identifierTokenCandidateStream(
      text,
      TRAILING_PATH_SEPARATOR_PATTERN,
      fullMatchCandidate,
    ),
    identifierTokenCandidateStream(
      text,
      BACKTICK_IDENTIFIER_PATTERN,
      backtickIdentifierCandidate,
    ),
  ];
}

export function compareIdentifierTokenSpans(
  left: IdentifierTokenSpan,
  right: IdentifierTokenSpan,
): number {
  return (
    left.start - right.start ||
    right.end - left.end ||
    left.value.localeCompare(right.value)
  );
}

function nonOverlappingTokenSpans(
  sortedCandidates: readonly IdentifierTokenSpan[],
): IdentifierTokenSpan[] {
  const spans: IdentifierTokenSpan[] = [];
  let coveredUntil = -1;
  for (const candidate of sortedCandidates) {
    if (candidate.start < coveredUntil) continue;
    spans.push(candidate);
    coveredUntil = candidate.end;
  }
  return spans;
}

export function copiedSourceTokenSpans(
  text: string,
  sourceBudget?: SourceIdentifierBudget,
  trimNarrativeUriPunctuation = true,
): IdentifierTokenSpan[] {
  const candidates: IdentifierTokenSpan[] = [];
  for (const stream of copiedSourceCandidateStreams(
    text,
    trimNarrativeUriPunctuation,
  )) {
    candidates.push(...collectCandidateStream(stream, sourceBudget));
  }
  candidates.sort(compareIdentifierTokenSpans);
  return nonOverlappingTokenSpans(candidates);
}

interface CandidateStreamCursor {
  streamIndex: number;
  candidateIndex: number;
  candidate: IdentifierTokenSpan;
}

function compareCandidateStreamCursors(
  left: CandidateStreamCursor,
  right: CandidateStreamCursor,
): number {
  return (
    compareIdentifierTokenSpans(left.candidate, right.candidate) ||
    left.streamIndex - right.streamIndex ||
    left.candidateIndex - right.candidateIndex
  );
}

function pushCandidateCursor(
  heap: CandidateStreamCursor[],
  cursor: CandidateStreamCursor,
): void {
  let index = heap.length;
  heap.push(cursor);
  while (index > 0) {
    const parent = (index - 1) >>> 1;
    if (compareCandidateStreamCursors(heap[parent]!, cursor) <= 0) break;
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = cursor;
}

function popCandidateCursor(
  heap: CandidateStreamCursor[],
): CandidateStreamCursor {
  const first = heap[0]!;
  const last = heap.pop()!;
  if (heap.length === 0) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child =
      right < heap.length &&
      compareCandidateStreamCursors(heap[right]!, heap[left]!) < 0
        ? right
        : left;
    if (compareCandidateStreamCursors(heap[child]!, last) >= 0) break;
    heap[index] = heap[child]!;
    index = child;
  }
  heap[index] = last;
  return first;
}

async function mergeCandidateStreamsCooperatively(
  streams: readonly (readonly IdentifierTokenSpan[])[],
  scheduler: CooperativeScheduler,
): Promise<IdentifierTokenSpan[]> {
  const heap: CandidateStreamCursor[] = [];
  for (const [streamIndex, stream] of streams.entries()) {
    const candidate = stream[0];
    if (candidate === undefined) continue;
    pushCandidateCursor(heap, { streamIndex, candidateIndex: 0, candidate });
  }
  const spans: IdentifierTokenSpan[] = [];
  let coveredUntil = -1;
  while (heap.length > 0) {
    if (scheduler.shouldYield(Math.max(1, heap.length))) {
      await scheduler.yield();
    }
    const cursor = popCandidateCursor(heap);
    if (cursor.candidate.start >= coveredUntil) {
      spans.push(cursor.candidate);
      coveredUntil = cursor.candidate.end;
    }
    const candidateIndex = cursor.candidateIndex + 1;
    const candidate = streams[cursor.streamIndex]![candidateIndex];
    if (candidate !== undefined) {
      pushCandidateCursor(heap, {
        streamIndex: cursor.streamIndex,
        candidateIndex,
        candidate,
      });
    }
  }
  return spans;
}

export async function cooperativeCopiedSourceTokenSpans(
  text: string,
  scheduler: CooperativeScheduler,
  sourceBudget?: SourceIdentifierBudget,
  trimNarrativeUriPunctuation = true,
): Promise<IdentifierTokenSpan[]> {
  const streams: IdentifierTokenSpan[][] = [];
  for (const stream of copiedSourceCandidateStreams(
    text,
    trimNarrativeUriPunctuation,
  )) {
    streams.push(
      await collectCandidateStreamCooperatively(
        text.length,
        stream,
        scheduler,
        sourceBudget,
      ),
    );
  }
  return mergeCandidateStreamsCooperatively(streams, scheduler);
}

export async function cooperativelySortIdentifierTokenSpans(
  spans: readonly IdentifierTokenSpan[],
  scheduler: CooperativeScheduler,
): Promise<IdentifierTokenSpan[]> {
  let source = [...spans];
  if (source.length <= 1) return source;
  if (scheduler.shouldYield(source.length)) await scheduler.yield();
  let destination = new Array<IdentifierTokenSpan>(source.length);
  for (let width = 1; width < source.length; width *= 2) {
    for (let start = 0; start < source.length; start += width * 2) {
      const middle = Math.min(start + width, source.length);
      const end = Math.min(start + width * 2, source.length);
      let left = start;
      let right = middle;
      for (let target = start; target < end; target += 1) {
        if (scheduler.shouldYield()) await scheduler.yield();
        if (
          right >= end ||
          (left < middle &&
            compareIdentifierTokenSpans(source[left]!, source[right]!) <= 0)
        ) {
          destination[target] = source[left]!;
          left += 1;
        } else {
          destination[target] = source[right]!;
          right += 1;
        }
      }
    }
    [source, destination] = [destination, source];
  }
  return source;
}

function trimExternalUriPunctuation(value: string): string {
  let openingParentheses = 0;
  let closingParentheses = 0;
  let openingBraces = 0;
  let closingBraces = 0;
  for (const character of value) {
    if (character === "(") openingParentheses += 1;
    if (character === ")") closingParentheses += 1;
    if (character === "{") openingBraces += 1;
    if (character === "}") closingBraces += 1;
  }
  let end = value.length;
  while (end > 0) {
    const suffix = value[end - 1];
    if (suffix === "." || suffix === ",") {
      end -= 1;
      continue;
    }
    if (suffix === ")" && closingParentheses > openingParentheses) {
      closingParentheses -= 1;
      end -= 1;
      continue;
    }
    if (suffix === "}" && closingBraces > openingBraces) {
      closingBraces -= 1;
      end -= 1;
      continue;
    }
    break;
  }
  return value.slice(0, end);
}

function trimNarrativeIdentifierPunctuation(value: string): string {
  const quoteIndex = value.search(/['’]/u);
  return trimExternalUriPunctuation(
    quoteIndex < 0 || quoteIndex === value.length - 1
      ? value
      : value.slice(0, quoteIndex),
  );
}

export function copiedSourceTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const span of copiedSourceTokenSpans(text)) tokens.add(span.value);
  for (const span of identifierBangTokenSpans(text)) tokens.add(span.value);
  return tokens;
}

export function foldIdentifierText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\p{M}\p{Cf}]/gu, "")
    .toUpperCase()
    .toLowerCase()
    .replace(/ς/gu, "σ")
    .normalize("NFKD")
    .replace(/[\p{M}\p{Cf}]/gu, "");
}

export function analyzeIdentifier(value: string): {
  skeleton: string | null;
  components: string[];
  oversized: boolean;
} {
  const normalizedParts: string[] = [];
  let sourceCharacters = 0;
  let oversized = false;
  for (const match of value.matchAll(IDENTIFIER_WORD_PATTERN)) {
    const retainedCodePoints: string[] = [];
    for (const codePoint of match[0]) {
      sourceCharacters += 1;
      if (sourceCharacters <= MAX_IDENTIFIER_SOURCE_CHARACTERS) {
        retainedCodePoints.push(codePoint);
      } else {
        oversized = true;
        break;
      }
    }
    if (retainedCodePoints.length > 0) {
      const normalized = retainedCodePoints
        .join("")
        .normalize("NFKC")
        .replace(/[\p{M}\p{Cf}]/gu, "");
      if (normalized.length > 0) normalizedParts.push(normalized);
    }
    if (oversized) break;
  }
  const skeleton = foldIdentifierText(normalizedParts.join(""));
  const components = normalizedParts.flatMap((part) =>
    [
      ...part.matchAll(
        /\p{Lu}+(?=\p{Lu}\p{Ll}|\p{N}|$)|\p{Lu}?\p{Ll}+|\p{N}+|\p{Lu}+|\p{Lo}+/gu,
      ),
    ].map((component) => foldIdentifierText(component[0])),
  );
  return {
    skeleton: skeleton.length >= 1 ? skeleton : null,
    components,
    oversized,
  };
}

export function identifierSkeleton(value: string): string | null {
  return analyzeIdentifier(value).skeleton;
}

export function addIdentifierSkeletons(
  target: Set<string>,
  token: string,
): void {
  const skeleton = identifierSkeleton(token);
  if (skeleton === null) return;
  target.add(skeleton);
  if (token.startsWith(".")) target.add(`dot${skeleton}`);
  if (token.endsWith("++")) target.add(`${skeleton}plusplus`);
  if (token.endsWith("#")) target.add(`${skeleton}sharp`);
}

export function addIdentifierComponentSkeletons(
  target: Set<string>,
  token: string,
): void {
  const { components } = analyzeIdentifier(token);
  if (components.length <= 1) return;
  for (const component of components) {
    if (codePointLength(component) >= 2) target.add(component);
  }
}
