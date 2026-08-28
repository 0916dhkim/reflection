import { createHash } from "node:crypto";

import { caseFold } from "unicode-case-folding";
import { v5 as uuidv5 } from "uuid";

import type {
  ExtractedClaim,
  Resolution,
  ResolutionResult,
  SearchClaim,
  SegmentCreate,
} from "./contracts.js";

export const SEGMENT_NAMESPACE = "b14d5f2c-4cce-4f37-9e32-ea30c1fd1b42";
export const ENTITY_NAMESPACE = "966769b5-ab08-4b02-8948-7db052586124";
export const CLAIM_NAMESPACE = "194eb982-5e16-4011-bdcb-f13a86934da4";

export class ExtractionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionValidationError";
  }
}

export class TerminalExtractionValidationError extends ExtractionValidationError {
  constructor(message: string) {
    super(message);
    this.name = "TerminalExtractionValidationError";
  }
}

export function normalizeName(value: string): string {
  return caseFold(value)
    .split(/[\p{White_Space}\u001c-\u001f]+/u)
    .filter(Boolean)
    .join(" ");
}

export function segmentIdFor(
  sessionId: string,
  startUserMessageId: string,
): string {
  return uuidv5(`${sessionId}\0${startUserMessageId}`, SEGMENT_NAMESPACE);
}

function utf8Frame(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

export function segmentIdForRequest(
  request: Pick<
    SegmentCreate,
    | "session_id"
    | "start_user_message_id"
    | "source_boundary_version"
    | "start_source_message_id"
  >,
): string {
  if (request.source_boundary_version === 1) {
    return segmentIdFor(request.session_id, request.start_user_message_id);
  }
  if (request.start_source_message_id === null) {
    throw new Error("V2 segment identity requires a start source cursor");
  }
  return uuidv5(
    `reflection-segment-v2:${utf8Frame(request.session_id)}${utf8Frame(request.start_source_message_id)}`,
    SEGMENT_NAMESPACE,
  );
}

export function sourceFingerprint(request: SegmentCreate): string {
  const messageFrames =
    `${request.messages.length}:` +
    request.messages
      .map((message) => utf8Frame(message.role) + utf8Frame(message.text))
      .join("");
  const source =
    request.source_boundary_version === 1
      ? "reflection-source-v1:" +
        utf8Frame(request.session_id) +
        utf8Frame(request.start_user_message_id) +
        utf8Frame(request.end_user_message_id) +
        messageFrames
      : "reflection-source-v2:" +
        utf8Frame(request.session_id) +
        utf8Frame(request.start_user_message_id) +
        utf8Frame(request.end_user_message_id) +
        utf8Frame(String(request.source_boundary_version)) +
        utf8Frame(request.start_source_message_id) +
        utf8Frame(request.end_source_message_id) +
        messageFrames;
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function projectionFingerprint(
  segmentId: string,
  endUserMessageId: string,
  summary: string,
  projectionVersion: number,
): string {
  const length = (value: string) => [...value].length;
  const source = `${segmentId}:${length(endUserMessageId)}:${endUserMessageId}:${length(summary)}:${summary}:${projectionVersion}`;
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export type ProjectionFingerprintBoundary =
  | {
      sourceBoundaryVersion: 1;
      endUserMessageId: string;
      endSourceMessageId: null;
    }
  | {
      sourceBoundaryVersion: 2;
      endUserMessageId: string;
      endSourceMessageId: string;
    };

export function projectionFingerprintForBoundary(
  segmentId: string,
  boundary: ProjectionFingerprintBoundary,
  summary: string,
  projectionVersion: number,
): string {
  if (boundary.sourceBoundaryVersion === 1) {
    return projectionFingerprint(
      segmentId,
      boundary.endUserMessageId,
      summary,
      projectionVersion,
    );
  }
  const source =
    "reflection-projection-v2:" +
    utf8Frame(segmentId) +
    utf8Frame(String(boundary.sourceBoundaryVersion)) +
    utf8Frame(boundary.endUserMessageId) +
    utf8Frame(boundary.endSourceMessageId) +
    utf8Frame(summary) +
    utf8Frame(String(projectionVersion));
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function newMentionEntityIdFor(
  segmentId: string,
  sourceFingerprint: string,
  mentionId: string,
  claim: Pick<
    ExtractedClaim,
    "subject" | "predicate" | "object_entity" | "object_value"
  >,
): string {
  if ((claim.object_entity === null) === (claim.object_value === null)) {
    throw new ExtractionValidationError(
      "new mention identity requires exactly one entity object or literal value",
    );
  }
  const objectKind = claim.object_entity === null ? "literal" : "entity";
  const objectText = claim.object_entity ?? claim.object_value!;
  return uuidv5(
    "reflection-new-mention-v1:" +
      utf8Frame(segmentId) +
      utf8Frame(sourceFingerprint) +
      utf8Frame(mentionId) +
      utf8Frame(claim.subject) +
      utf8Frame(claim.predicate) +
      utf8Frame(objectKind) +
      utf8Frame(objectText),
    ENTITY_NAMESPACE,
  );
}

export function claimIdFor(segmentId: string, index: number): string {
  return uuidv5(`${segmentId}\0${index}`, CLAIM_NAMESPACE);
}

export function equivalenceKey(
  subjectId: string,
  predicate: string,
  object: { objectEntityId: string | null; objectValue: string | null },
): string {
  if ((object.objectEntityId === null) === (object.objectValue === null)) {
    throw new ExtractionValidationError(
      "equivalence key requires exactly one entity object or literal value",
    );
  }
  const objectKey =
    object.objectEntityId !== null
      ? `entity:${object.objectEntityId}`
      : `literal:${normalizeName(object.objectValue ?? "")}`;
  return createHash("sha256")
    .update(`${subjectId}\0${normalizeName(predicate)}\0${objectKey}`, "utf8")
    .digest("hex");
}

export interface EntityCandidate {
  id: string;
  canonicalName: string;
  description: string;
  aliases: readonly string[];
}

export interface MentionContext {
  mentionId: string;
  role: string;
  text: string;
  supportingClaim: string;
  candidates: readonly EntityCandidate[];
}

export interface PreparedEntity {
  id: string;
  canonicalName: string;
  normalizedName: string;
  description: string;
  aliases: readonly string[];
  embedding: readonly number[] | null;
  isNew: boolean;
}

export interface PreparedClaim {
  id: string;
  subject: string;
  subjectEntityId: string;
  predicate: string;
  confidence: number;
  objectEntity: string | null;
  objectEntityId: string | null;
  objectValue: string | null;
  equivalenceKey: string;
  embedding: readonly number[];
}

export interface PreparedSegment {
  id: string;
  sessionId: string;
  startUserMessageId: string;
  endUserMessageId: string;
  sourceBoundaryVersion: 1 | 2;
  startSourceMessageId: string | null;
  endSourceMessageId: string | null;
  summary: string;
  entities: readonly PreparedEntity[];
  claims: readonly PreparedClaim[];
  projectionVersion: number;
}

export interface RecallCandidate {
  subject: string;
  subjectEntityId: string;
  predicate: string;
  confidence: number;
  objectEntity: string | null;
  objectEntityId: string | null;
  objectValue: string | null;
  equivalenceKey: string;
  segmentId: string;
  similarity: number;
  seedSimilarity: number | null;
  isDirect: boolean;
}

export interface ClaimSupport {
  segmentIds: string[];
  supportCount: number;
  sessionCount: number;
}

export function unionCandidates(
  trigram: readonly EntityCandidate[],
  vector: readonly EntityCandidate[],
): EntityCandidate[] {
  const byId = new Map<string, EntityCandidate>();
  for (const candidate of [...trigram.slice(0, 5), ...vector.slice(0, 5)]) {
    if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
  }
  return [...byId.values()];
}

export interface ValidatedClaimDecision {
  index: number;
  claim: ExtractedClaim;
}

export interface ValidatedMentionResolution {
  context: MentionContext;
  resolution: Resolution;
  selectedCandidate: EntityCandidate | null;
}

export interface ValidatedResolutionPlan {
  keptClaims: readonly ValidatedClaimDecision[];
  mentions: readonly ValidatedMentionResolution[];
}

function validateClaimDecisions(
  proposed: readonly ExtractedClaim[],
  result: ResolutionResult,
): ValidatedClaimDecision[] {
  const expected = new Set(proposed.map((_, index) => `c${index}`));
  const actual = new Map(
    result.claims.map((decision) => [decision.claim_id, decision]),
  );
  if (actual.size !== result.claims.length) {
    throw new ExtractionValidationError(
      "claim triage returned duplicate claim IDs",
    );
  }
  if (
    actual.size !== expected.size ||
    [...actual.keys()].some((id) => !expected.has(id))
  ) {
    throw new ExtractionValidationError(
      "claim triage must return every proposed claim exactly once",
    );
  }
  return proposed.flatMap((claim, index) =>
    actual.get(`c${index}`)!.action === "keep" ? [{ index, claim }] : [],
  );
}

export function validateResolutionResult(
  proposed: readonly ExtractedClaim[],
  contexts: readonly MentionContext[],
  result: ResolutionResult,
): ValidatedResolutionPlan {
  const keptClaims = validateClaimDecisions(proposed, result);
  const keptMentionIds = new Set<string>();
  for (const { index, claim } of keptClaims) {
    keptMentionIds.add(`c${index}.subject`);
    if (claim.object_entity !== null) keptMentionIds.add(`c${index}.object`);
  }
  const keptContexts = contexts.filter((context) =>
    keptMentionIds.has(context.mentionId),
  );
  const expected = new Map(
    keptContexts.map((context) => [context.mentionId, context]),
  );
  const contextIndexes = new Map(
    keptContexts.map((context, index) => [context.mentionId, index]),
  );
  const actual = new Map(
    result.resolutions.map((resolution) => [resolution.mention_id, resolution]),
  );
  if (actual.size !== result.resolutions.length) {
    throw new ExtractionValidationError(
      "entity resolution returned duplicate mention IDs",
    );
  }
  if (
    actual.size !== expected.size ||
    [...actual.keys()].some((mentionId) => !expected.has(mentionId))
  ) {
    throw new ExtractionValidationError(
      "entity resolution must return every mention exactly once",
    );
  }
  const mentions: ValidatedMentionResolution[] = [];
  for (const context of keptContexts) {
    const resolution = actual.get(context.mentionId)!;
    const selectedCandidate =
      resolution.candidate_entity_id === null
        ? null
        : (context.candidates.find(
            (candidate) => candidate.id === resolution.candidate_entity_id,
          ) ?? null);
    if (resolution.candidate_entity_id !== null && selectedCandidate === null) {
      throw new ExtractionValidationError(
        `entity resolution selected an unknown candidate for ${context.mentionId}`,
      );
    }
    if (resolution.same_new_entity_as !== null) {
      const groupedContext = expected.get(resolution.same_new_entity_as);
      const groupedResolution = actual.get(resolution.same_new_entity_as);
      if (
        resolution.candidate_entity_id !== null ||
        groupedContext === undefined ||
        groupedResolution === undefined ||
        groupedResolution.candidate_entity_id !== null ||
        groupedResolution.same_new_entity_as !== null ||
        contextIndexes.get(resolution.same_new_entity_as)! >=
          contextIndexes.get(context.mentionId)! ||
        normalizeName(groupedContext.text) !== normalizeName(context.text)
      ) {
        throw new ExtractionValidationError(
          `entity resolution returned an invalid new-entity group for ${context.mentionId}`,
        );
      }
    }
    mentions.push({ context, resolution, selectedCandidate });
  }
  return { keptClaims, mentions };
}

function clamp(value: number): number {
  return Number.isNaN(value) ? 0 : Math.min(1, Math.max(0, value));
}

export function rankAndGroupClaims(
  candidates: Iterable<RecallCandidate>,
  supportByKey: ReadonlyMap<string, ClaimSupport>,
  limit = 20,
): SearchClaim[] {
  const grouped = new Map<
    string,
    { candidate: RecallCandidate; score: number }
  >();
  for (const candidate of candidates) {
    const similarity = clamp(candidate.similarity);
    const confidence = clamp(candidate.confidence);
    const support = supportByKey.get(candidate.equivalenceKey);
    const sessionCount = support?.sessionCount ?? 1;
    const supportBoost = Math.min(0.1, 0.02 * Math.max(0, sessionCount - 1));
    const score = candidate.isDirect
      ? 1 + 0.8 * similarity + 0.2 * confidence + supportBoost
      : 0.8 *
          (0.5 * similarity +
            0.3 * clamp(candidate.seedSimilarity ?? 0) +
            0.2 * confidence) +
        supportBoost;
    const current = grouped.get(candidate.equivalenceKey);
    if (!current || score > current.score)
      grouped.set(candidate.equivalenceKey, { candidate, score });
  }
  return [...grouped.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ candidate, score }) => {
      const support = supportByKey.get(candidate.equivalenceKey);
      return {
        subject: candidate.subject,
        subject_entity_id: candidate.subjectEntityId,
        predicate: candidate.predicate,
        confidence: candidate.confidence,
        object_entity: candidate.objectEntity,
        object_entity_id: candidate.objectEntityId,
        object_value: candidate.objectValue,
        segment_ids: support?.segmentIds ?? [candidate.segmentId],
        support_count: support?.supportCount ?? 1,
        session_count: support?.sessionCount ?? 1,
        score,
      };
    });
}
