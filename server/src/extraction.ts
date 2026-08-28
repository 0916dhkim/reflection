import { type ExtractedClaim } from "@reflection/shared/contracts";
import {
  claimIdFor,
  equivalenceKey,
  newMentionEntityIdFor,
  normalizeName,
  type MentionContext,
  type PreparedClaim,
  type PreparedEntity,
  type PreparedSegment,
  type ValidatedResolutionPlan,
} from "@reflection/shared/domain";

import {
  MAX_EMBEDDING_INPUT_BYTES,
  EmbeddingClient,
  ModelClient,
} from "./clients.js";
import type { ClaimedJob, Database } from "./database.js";
import type { ValidatedExtractionResult } from "./extraction-validation.js";

const MAX_ENTITY_DESCRIPTION_CODE_POINTS = 2_000;

function truncateCodePoints(value: string, maximum: number): string {
  if ([...value].length <= maximum) return value;
  return [...value].slice(0, maximum).join("");
}

function truncateUtf8Bytes(value: string, maximum: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximum) return value;
  const retained: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximum) break;
    retained.push(character);
    bytes += characterBytes;
  }
  return retained.join("");
}

type ExtractionDatabase = Pick<Database, "priorSummaries" | "entityCandidates">;
type ExtractionModels = Pick<ModelClient, "extract" | "resolve">;
type ExtractionEmbeddings = Pick<EmbeddingClient, "embed">;

interface ContextSpec {
  mentionId: string;
  role: string;
  text: string;
  supportingClaim: string;
  claim: ExtractedClaim;
}

export class ExtractionEngine {
  readonly #database: ExtractionDatabase;
  readonly #models: ExtractionModels;
  readonly #embeddings: ExtractionEmbeddings;

  constructor(
    database: ExtractionDatabase,
    models: ExtractionModels,
    embeddings: ExtractionEmbeddings,
  ) {
    this.#database = database;
    this.#models = models;
    this.#embeddings = embeddings;
  }

  async extract(job: ClaimedJob): Promise<ValidatedExtractionResult> {
    const priorSummaries = await this.#database.priorSummaries(
      job.request.session_id,
      job.segmentId,
    );
    return this.#models.extract(job.request, priorSummaries);
  }

  async resolve(
    job: ClaimedJob,
    extracted: ValidatedExtractionResult,
  ): Promise<PreparedSegment> {
    const contextSpecs: ContextSpec[] = [];
    for (const [index, claim] of extracted.claims.entries()) {
      const supportingClaim = ExtractionEngine.#claimText(claim);
      contextSpecs.push({
        mentionId: `c${index}.subject`,
        role: "subject",
        text: claim.subject,
        supportingClaim,
        claim,
      });
      if (claim.object_entity !== null) {
        contextSpecs.push({
          mentionId: `c${index}.object`,
          role: "object",
          text: claim.object_entity,
          supportingClaim,
          claim,
        });
      }
    }

    const candidateInputs = contextSpecs.map(
      ({ role, text, supportingClaim }) =>
        truncateUtf8Bytes(
          `Entity mention: ${text}\nEndpoint role: ${role}\nSupporting claim: ${supportingClaim}\nSegment summary: ${extracted.summary}`,
          MAX_EMBEDDING_INPUT_BYTES,
        ),
    );
    const mentionEmbeddings = await this.#embeddings.embed(
      candidateInputs,
      "query",
    );
    if (mentionEmbeddings.length !== contextSpecs.length) {
      throw new Error("embedding response did not match entity mentions");
    }
    const candidateSets = await Promise.all(
      contextSpecs.map((spec, index) =>
        this.#database.entityCandidates(spec.text, mentionEmbeddings[index]!),
      ),
    );
    const contexts: MentionContext[] = contextSpecs.map((spec, index) => ({
      mentionId: spec.mentionId,
      role: spec.role,
      text: spec.text,
      supportingClaim: spec.supportingClaim,
      candidates: candidateSets[index]!,
    }));
    const claimsByMentionId = new Map(
      contextSpecs.map((spec) => [spec.mentionId, spec.claim]),
    );

    let plan: ValidatedResolutionPlan = { keptClaims: [], mentions: [] };
    if (contexts.length > 0) {
      plan = await this.#models.resolve(
        job.request,
        extracted.summary,
        extracted.claims,
        contexts,
      );
      console.info("claim triage completed", {
        proposed: extracted.claims.length,
        kept: plan.keptClaims.length,
        dropped: extracted.claims.length - plan.keptClaims.length,
      });
    }

    const entitiesById = new Map<string, PreparedEntity>();
    const occurrenceEntities = new Map<string, PreparedEntity>();
    for (const {
      context,
      resolution,
      selectedCandidate: candidate,
    } of plan.mentions) {
      let entityId: string;
      let canonicalName: string;
      let description: string;
      let aliases: readonly string[];
      let isNew: boolean;
      if (candidate === null) {
        if (resolution.same_new_entity_as === null) {
          canonicalName = context.text;
          description = truncateCodePoints(
            `Entity named ${canonicalName} in claim: ${context.supportingClaim}.`,
            MAX_ENTITY_DESCRIPTION_CODE_POINTS,
          );
          aliases = ExtractionEngine.#uniqueAliases(
            canonicalName,
            context.text,
          );
          entityId = newMentionEntityIdFor(
            job.segmentId,
            job.sourceFingerprint,
            context.mentionId,
            claimsByMentionId.get(context.mentionId)!,
          );
          isNew = true;
        } else {
          const groupedEntity = occurrenceEntities.get(
            resolution.same_new_entity_as,
          );
          if (groupedEntity === undefined) {
            throw new Error(
              `validated new-entity group missing for ${context.mentionId}`,
            );
          }
          entityId = groupedEntity.id;
          canonicalName = groupedEntity.canonicalName;
          description = groupedEntity.description;
          aliases = ExtractionEngine.#uniqueAliases(
            ...groupedEntity.aliases,
            context.text,
          );
          isNew = groupedEntity.isNew;
        }
      } else {
        entityId = candidate.id;
        canonicalName = candidate.canonicalName;
        description = candidate.description;
        aliases = ExtractionEngine.#uniqueAliases(
          canonicalName,
          ...candidate.aliases,
          context.text,
        );
        isNew = false;
      }

      const previous = entitiesById.get(entityId);
      const entity: PreparedEntity =
        previous === undefined
          ? {
              id: entityId,
              canonicalName,
              normalizedName: normalizeName(canonicalName),
              description,
              aliases,
              embedding: null,
              isNew,
            }
          : {
              ...previous,
              aliases: ExtractionEngine.#uniqueAliases(
                ...previous.aliases,
                ...aliases,
              ),
            };
      entitiesById.set(entityId, entity);
      occurrenceEntities.set(context.mentionId, entity);
    }

    let entities = [...entitiesById.values()];
    const newEntities = entities.filter((entity) => entity.isNew);
    const claimTexts = plan.keptClaims.map(({ claim }) =>
      truncateUtf8Bytes(
        ExtractionEngine.#claimText(claim),
        MAX_EMBEDDING_INPUT_BYTES,
      ),
    );
    const entityTexts = newEntities.map((entity) =>
      truncateUtf8Bytes(
        `${entity.canonicalName}: ${entity.description}`,
        MAX_EMBEDDING_INPUT_BYTES,
      ),
    );
    const documentEmbeddings = await this.#embeddings.embed(
      [...claimTexts, ...entityTexts],
      "document",
    );
    if (
      documentEmbeddings.length !==
      plan.keptClaims.length + newEntities.length
    ) {
      throw new Error("embedding response did not match prepared documents");
    }
    const claimEmbeddings = documentEmbeddings.slice(0, plan.keptClaims.length);
    const entityEmbeddings = documentEmbeddings.slice(plan.keptClaims.length);
    const embeddingByEntity = new Map(
      newEntities.map((entity, index) => [entity.id, entityEmbeddings[index]!]),
    );
    entities = entities.map((entity) => ({
      ...entity,
      embedding: embeddingByEntity.get(entity.id) ?? null,
    }));

    const claims: PreparedClaim[] = plan.keptClaims.map(
      ({ index, claim }, embeddingIndex) => {
        const subjectEntity = occurrenceEntities.get(`c${index}.subject`);
        if (subjectEntity === undefined) {
          throw new Error(`missing subject entity for c${index}`);
        }
        const objectEntity =
          claim.object_entity === null
            ? null
            : occurrenceEntities.get(`c${index}.object`);
        if (claim.object_entity !== null && objectEntity === undefined) {
          throw new Error(`missing object entity for c${index}`);
        }
        const objectEntityId = objectEntity?.id ?? null;
        return {
          id: claimIdFor(job.segmentId, index),
          subject: claim.subject,
          subjectEntityId: subjectEntity.id,
          predicate: claim.predicate,
          confidence: claim.confidence,
          objectEntity: claim.object_entity,
          objectEntityId,
          objectValue: claim.object_value,
          equivalenceKey: equivalenceKey(subjectEntity.id, claim.predicate, {
            objectEntityId,
            objectValue: claim.object_value,
          }),
          embedding: claimEmbeddings[embeddingIndex]!,
        };
      },
    );

    return {
      id: job.segmentId,
      sessionId: job.request.session_id,
      startUserMessageId: job.request.start_user_message_id,
      endUserMessageId: job.request.end_user_message_id,
      sourceBoundaryVersion: job.request.source_boundary_version,
      startSourceMessageId: job.request.start_source_message_id,
      endSourceMessageId: job.request.end_source_message_id,
      summary: extracted.summary,
      entities,
      claims,
      projectionVersion: job.request.projection_version,
    };
  }

  static #claimText(claim: ExtractedClaim): string {
    const objectText = claim.object_entity ?? claim.object_value;
    if (objectText === null) {
      throw new Error("extracted claim has no object");
    }
    return `${claim.subject} | ${claim.predicate} | ${objectText}`;
  }

  static #uniqueAliases(...aliases: readonly string[]): string[] {
    const unique = new Map<string, string>();
    for (const alias of aliases) {
      const key = normalizeName(alias);
      if (!unique.has(key)) unique.set(key, alias.trim());
    }
    return [...unique.values()];
  }
}
