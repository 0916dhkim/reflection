import {
  type ExtractedClaim,
  type ExtractionResult,
  type SourceMessage,
} from "@reflection/shared/contracts";
import {
  canonicalToolFallbackFrames,
  MAX_COMPLETE_TOOL_SOURCE_CHARS,
  toolFallbackFrameRanges,
} from "@reflection/shared/tool-source";

const ABSOLUTE_PATH_PATTERN =
  /(?<![\p{L}\p{N}\p{M}\p{Cf}_/:])\/(?!\/)[\p{L}\p{N}\p{M}\p{Cf}._~!$&'()*+=:@%/-]+(?![\p{L}\p{N}\p{M}\p{Cf}_])/gu;

const SOURCE_CODE_FILENAME_PATTERN =
  /(?<!`)\x60([A-Za-z0-9._~!$&'()*+=:@%-]+)\x60(?!`)/gu;

export interface NormalizedExtractedPaths {
  result: ExtractionResult;
  normalizedPaths: number;
}

function scanText(
  text: string,
  candidatePaths: ReadonlySet<string>,
  candidateBasenames: ReadonlySet<string>,
  seenExactPaths: Set<string>,
  seenBacktickedBasenames: Set<string>,
): void {
  for (const match of text.matchAll(ABSOLUTE_PATH_PATTERN)) {
    if (candidatePaths.has(match[0])) {
      seenExactPaths.add(match[0]);
    }
  }
  for (const match of text.matchAll(SOURCE_CODE_FILENAME_PATTERN)) {
    if (candidateBasenames.has(match[1]!)) {
      seenBacktickedBasenames.add(match[1]!);
    }
  }
}

function traverseToolState(
  value: unknown,
  candidatePaths: ReadonlySet<string>,
  candidateBasenames: ReadonlySet<string>,
  seenExactPaths: Set<string>,
  seenBacktickedBasenames: Set<string>,
): void {
  if (typeof value === "string") {
    scanText(
      value,
      candidatePaths,
      candidateBasenames,
      seenExactPaths,
      seenBacktickedBasenames,
    );
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    scanText(
      String(value),
      candidatePaths,
      candidateBasenames,
      seenExactPaths,
      seenBacktickedBasenames,
    );
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      traverseToolState(
        item,
        candidatePaths,
        candidateBasenames,
        seenExactPaths,
        seenBacktickedBasenames,
      );
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, val] of Object.entries(value)) {
      scanText(
        key,
        candidatePaths,
        candidateBasenames,
        seenExactPaths,
        seenBacktickedBasenames,
      );
      traverseToolState(
        val,
        candidatePaths,
        candidateBasenames,
        seenExactPaths,
        seenBacktickedBasenames,
      );
    }
  }
}

export function normalizeExtractedPaths(
  result: { summary: string; claims: readonly ExtractedClaim[] },
  messages: ReadonlyArray<SourceMessage | { role: string; text: string }>,
): NormalizedExtractedPaths {
  const candidatePaths = new Set<string>();
  const candidateBasenames = new Set<string>();

  const collectCandidates = (text: string): void => {
    for (const match of text.matchAll(ABSOLUTE_PATH_PATTERN)) {
      const path = match[0];
      candidatePaths.add(path);
      candidateBasenames.add(path.slice(path.lastIndexOf("/") + 1));
    }
  };

  collectCandidates(result.summary);
  for (const claim of result.claims) {
    collectCandidates(claim.subject);
    collectCandidates(claim.predicate);
    if (claim.object_entity !== null) {
      collectCandidates(claim.object_entity);
    }
    if (claim.object_value !== null) {
      collectCandidates(claim.object_value);
    }
  }

  if (candidatePaths.size === 0) {
    return {
      result: {
        summary: result.summary,
        claims: [...result.claims],
      },
      normalizedPaths: 0,
    };
  }

  const seenExactPaths = new Set<string>();
  const seenBacktickedBasenames = new Set<string>();

  let remainingToolChars = MAX_COMPLETE_TOOL_SOURCE_CHARS;
  let toolBudgetExhausted = false;

  for (const message of messages) {
    if (message.role !== "assistant") {
      scanText(
        message.text,
        candidatePaths,
        candidateBasenames,
        seenExactPaths,
        seenBacktickedBasenames,
      );
      continue;
    }

    const blocks = canonicalToolFallbackFrames(message.text);
    const blocksByStart = new Map(blocks.map((block) => [block.start, block]));
    const ranges = toolFallbackFrameRanges(message.text);
    let cursor = 0;

    for (const range of ranges) {
      const textBefore = message.text.slice(cursor, range.start);
      scanText(
        textBefore,
        candidatePaths,
        candidateBasenames,
        seenExactPaths,
        seenBacktickedBasenames,
      );

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
      scanText(
        block.name,
        candidatePaths,
        candidateBasenames,
        seenExactPaths,
        seenBacktickedBasenames,
      );
      traverseToolState(
        block.state,
        candidatePaths,
        candidateBasenames,
        seenExactPaths,
        seenBacktickedBasenames,
      );
      cursor = range.end;
    }

    const textAfter = message.text.slice(cursor);
    scanText(
      textAfter,
      candidatePaths,
      candidateBasenames,
      seenExactPaths,
      seenBacktickedBasenames,
    );
  }

  let normalizedPaths = 0;
  const normalize = (text: string): string =>
    text.replace(ABSOLUTE_PATH_PATTERN, (path) => {
      if (seenExactPaths.has(path)) {
        return path;
      }
      const filename = path.slice(path.lastIndexOf("/") + 1);
      if (!seenBacktickedBasenames.has(filename)) {
        return path;
      }
      normalizedPaths += 1;
      return filename;
    });

  const claims: ExtractedClaim[] = result.claims.map(
    (claim): ExtractedClaim => {
      const common = {
        subject: normalize(claim.subject),
        predicate: normalize(claim.predicate),
        confidence: claim.confidence,
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
    },
  );

  return {
    result: {
      summary: normalize(result.summary),
      claims,
    },
    normalizedPaths,
  };
}
