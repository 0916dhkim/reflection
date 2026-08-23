import {
  parseExtractionResult,
  type ExtractedClaim,
  type ExtractionResult,
  type Resolution,
} from "@reflection/shared/contracts";
import {
  claimIdFor,
  equivalenceKey,
  newEntityIdFor,
  normalizeName,
  validateClaimDecisions,
  validateResolutions,
  type EntityCandidate,
  type MentionContext,
  type PreparedClaim,
  type PreparedEntity,
  type PreparedSegment,
} from "@reflection/shared/domain";

import { EmbeddingClient, ModelClient } from "./clients.js";
import type { ClaimedJob, Database } from "./database.js";

type ExtractionDatabase = Pick<Database, "priorSummaries" | "entityCandidates">;
type ExtractionModels = Pick<ModelClient, "extract" | "resolve">;
type ExtractionEmbeddings = Pick<EmbeddingClient, "embed">;

interface ContextSpec {
  mentionId: string;
  role: string;
  text: string;
  supportingClaim: string;
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

  async extract(job: ClaimedJob): Promise<ExtractionResult> {
    const priorSummaries = await this.#database.priorSummaries(
      job.request.session_id,
      job.segmentId,
    );
    return parseExtractionResult(
      await this.#models.extract(job.request, priorSummaries),
    );
  }

  async resolve(
    job: ClaimedJob,
    extracted: ExtractionResult,
  ): Promise<PreparedSegment> {
    const contextSpecs: ContextSpec[] = [];
    for (const [index, claim] of extracted.claims.entries()) {
      const supportingClaim = ExtractionEngine.#claimText(claim);
      contextSpecs.push({
        mentionId: `c${index}.subject`,
        role: "subject",
        text: claim.subject,
        supportingClaim,
      });
      if (claim.object_entity !== null) {
        contextSpecs.push({
          mentionId: `c${index}.object`,
          role: "object",
          text: claim.object_entity,
          supportingClaim,
        });
      }
    }

    const candidateInputs = contextSpecs.map(
      ({ role, text, supportingClaim }) =>
        `Entity mention: ${text}\nEndpoint role: ${role}\nSupporting claim: ${supportingClaim}\nSegment summary: ${extracted.summary}`,
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

    let triagedClaims: Array<{ index: number; claim: ExtractedClaim }>;
    let keptContexts: MentionContext[];
    let validated: ReturnType<typeof validateResolutions>;
    if (contexts.length > 0) {
      const resolutionResult = await this.#models.resolve(
        job.request,
        extracted.summary,
        extracted.claims,
        contexts,
      );
      triagedClaims = validateClaimDecisions(
        extracted.claims,
        resolutionResult,
      );
      const keptContextIds = new Set<string>();
      for (const { index, claim } of triagedClaims) {
        keptContextIds.add(`c${index}.subject`);
        if (claim.object_entity !== null) {
          keptContextIds.add(`c${index}.object`);
        }
      }
      keptContexts = contexts.filter((context) =>
        keptContextIds.has(context.mentionId),
      );
      validated = validateResolutions(keptContexts, resolutionResult);
      console.info("claim triage completed", {
        proposed: extracted.claims.length,
        kept: triagedClaims.length,
        dropped: extracted.claims.length - triagedClaims.length,
      });
    } else {
      triagedClaims = [];
      keptContexts = [];
      validated = new Map();
    }

    const entitiesById = new Map<string, PreparedEntity>();
    const occurrenceEntities = new Map<string, PreparedEntity>();
    for (const context of keptContexts) {
      const validatedResolution = validated.get(context.mentionId);
      if (validatedResolution === undefined) {
        throw new Error(
          `missing validated resolution for ${context.mentionId}`,
        );
      }
      const resolution = validatedResolution.resolution;
      const candidate = ExtractionEngine.#selectedCandidate(
        context,
        resolution,
      );

      let entityId: string;
      let canonicalName: string;
      let description: string;
      let aliases: readonly string[];
      let isNew: boolean;
      if (candidate === null) {
        canonicalName = resolution.canonical_name;
        if (context.candidates.length > 0) {
          description = resolution.description;
          aliases = ExtractionEngine.#uniqueAliases(
            canonicalName,
            context.text,
            ...resolution.aliases,
          );
        } else {
          description = `Entity named ${canonicalName}.`;
          aliases = ExtractionEngine.#uniqueAliases(
            canonicalName,
            context.text,
          );
        }
        entityId = newEntityIdFor(job.segmentId, canonicalName);
        isNew = true;
      } else {
        entityId = candidate.id;
        canonicalName = candidate.canonicalName;
        description = candidate.description;
        aliases = ExtractionEngine.#uniqueAliases(
          canonicalName,
          context.text,
          ...resolution.aliases,
          ...candidate.aliases,
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
    const claimTexts = triagedClaims.map(({ claim }) =>
      ExtractionEngine.#claimText(claim),
    );
    const entityTexts = newEntities.map(
      (entity) => `${entity.canonicalName}: ${entity.description}`,
    );
    const documentEmbeddings = await this.#embeddings.embed(
      [...claimTexts, ...entityTexts],
      "document",
    );
    if (
      documentEmbeddings.length !==
      triagedClaims.length + newEntities.length
    ) {
      throw new Error("embedding response did not match prepared documents");
    }
    const claimEmbeddings = documentEmbeddings.slice(0, triagedClaims.length);
    const entityEmbeddings = documentEmbeddings.slice(triagedClaims.length);
    const embeddingByEntity = new Map(
      newEntities.map((entity, index) => [entity.id, entityEmbeddings[index]!]),
    );
    entities = entities.map((entity) => ({
      ...entity,
      embedding: embeddingByEntity.get(entity.id) ?? null,
    }));

    const claims: PreparedClaim[] = triagedClaims.map(
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

  static #selectedCandidate(
    context: MentionContext,
    resolution: Resolution,
  ): EntityCandidate | null {
    if (resolution.candidate_entity_id === null) return null;
    const candidate = context.candidates.find(
      (item) =>
        item.id.toLowerCase() === resolution.candidate_entity_id?.toLowerCase(),
    );
    if (candidate === undefined) {
      throw new Error(`validated candidate missing for ${context.mentionId}`);
    }
    return candidate;
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
