import asyncio
import logging
from dataclasses import replace
from uuid import UUID

from reflection_service.clients import EmbeddingClient, ModelClient
from reflection_service.db import ClaimedJob, Database
from reflection_service.domain import (
    EntityCandidate,
    MentionContext,
    PreparedClaim,
    PreparedEntity,
    PreparedSegment,
    claim_id_for,
    equivalence_key,
    new_entity_id_for,
    normalize_name,
    validate_claim_decisions,
    validate_resolutions,
)
from reflection_service.models import ExtractedClaim, Resolution

logger = logging.getLogger(__name__)


class ExtractionEngine:
    def __init__(
        self, database: Database, models: ModelClient, embeddings: EmbeddingClient
    ) -> None:
        self._database = database
        self._models = models
        self._embeddings = embeddings

    async def prepare(self, job: ClaimedJob) -> PreparedSegment:
        prior_summaries = await self._database.prior_summaries(
            job.request.session_id, job.segment_id
        )
        extracted = await self._models.extract(job.request, prior_summaries)

        context_specs: list[tuple[str, str, str, str]] = []
        for index, claim in enumerate(extracted.claims):
            supporting_claim = self._claim_text(claim)
            context_specs.append((f"c{index}.subject", "subject", claim.subject, supporting_claim))
            if claim.object_entity is not None:
                context_specs.append(
                    (f"c{index}.object", "object", claim.object_entity, supporting_claim)
                )

        candidate_inputs = [
            (
                f"Entity mention: {text}\nEndpoint role: {role}\n"
                f"Supporting claim: {supporting_claim}\nSegment summary: {extracted.summary}"
            )
            for _, role, text, supporting_claim in context_specs
        ]
        mention_embeddings = await self._embeddings.embed(candidate_inputs, input_type="query")
        candidate_sets = await asyncio.gather(
            *(
                self._database.entity_candidates(text, embedding)
                for (_, _, text, _), embedding in zip(
                    context_specs, mention_embeddings, strict=True
                )
            )
        )
        contexts = tuple(
            MentionContext(
                mention_id=mention_id,
                role=role,
                text=text,
                supporting_claim=supporting_claim,
                candidates=candidates,
            )
            for (mention_id, role, text, supporting_claim), candidates in zip(
                context_specs, candidate_sets, strict=True
            )
        )
        if contexts:
            resolution_result = await self._models.resolve(
                extracted.summary, extracted.claims, contexts
            )
            triaged_claims = validate_claim_decisions(extracted.claims, resolution_result)
            kept_context_ids = {f"c{index}.subject" for index, _ in triaged_claims}
            kept_context_ids.update(
                f"c{index}.object"
                for index, claim in triaged_claims
                if claim.object_entity is not None
            )
            kept_contexts = tuple(
                context for context in contexts if context.mention_id in kept_context_ids
            )
            validated = validate_resolutions(kept_contexts, resolution_result)
            logger.info(
                "claim triage completed proposed=%d kept=%d dropped=%d",
                len(extracted.claims),
                len(triaged_claims),
                len(extracted.claims) - len(triaged_claims),
            )
        else:
            triaged_claims = []
            kept_contexts = ()
            validated = {}

        entities_by_id: dict[UUID, PreparedEntity] = {}
        occurrence_entities: dict[str, PreparedEntity] = {}
        for context in kept_contexts:
            _, resolution = validated[context.mention_id]
            candidate = self._selected_candidate(context, resolution)
            if candidate is None:
                entity_id = new_entity_id_for(job.segment_id, resolution.canonical_name)
                canonical_name = resolution.canonical_name
                description = resolution.description
                is_new = True
            else:
                entity_id = candidate.id
                canonical_name = candidate.canonical_name
                description = candidate.description
                is_new = False
            aliases = self._unique_aliases(
                canonical_name,
                context.text,
                *resolution.aliases,
                *(candidate.aliases if candidate else ()),
            )
            previous = entities_by_id.get(entity_id)
            if previous is not None:
                entity = replace(
                    previous,
                    aliases=self._unique_aliases(*previous.aliases, *aliases),
                )
            else:
                entity = PreparedEntity(
                    id=entity_id,
                    canonical_name=canonical_name,
                    normalized_name=normalize_name(canonical_name),
                    description=description,
                    aliases=aliases,
                    embedding=None,
                    is_new=is_new,
                )
            entities_by_id[entity_id] = entity
            occurrence_entities[context.mention_id] = entity

        entities = list(entities_by_id.values())
        new_entities = [entity for entity in entities if entity.is_new]
        claim_texts = [self._claim_text(claim) for _, claim in triaged_claims]
        entity_texts = [f"{entity.canonical_name}: {entity.description}" for entity in new_entities]
        document_embeddings = await self._embeddings.embed(
            [*claim_texts, *entity_texts], input_type="document"
        )
        claim_embeddings = document_embeddings[: len(triaged_claims)]
        entity_embeddings = document_embeddings[len(triaged_claims) :]
        embedding_by_entity = {
            entity.id: embedding
            for entity, embedding in zip(new_entities, entity_embeddings, strict=True)
        }
        entities = [
            replace(entity, embedding=embedding_by_entity.get(entity.id)) for entity in entities
        ]

        claims: list[PreparedClaim] = []
        for (index, claim), embedding in zip(triaged_claims, claim_embeddings, strict=True):
            subject_entity = occurrence_entities[f"c{index}.subject"]
            object_entity = (
                occurrence_entities[f"c{index}.object"] if claim.object_entity is not None else None
            )
            claims.append(
                PreparedClaim(
                    id=claim_id_for(job.segment_id, index),
                    subject=claim.subject,
                    subject_entity_id=subject_entity.id,
                    predicate=claim.predicate,
                    confidence=claim.confidence,
                    object_entity=claim.object_entity,
                    object_entity_id=object_entity.id if object_entity is not None else None,
                    object_value=claim.object_value,
                    equivalence_key=equivalence_key(
                        subject_entity.id,
                        claim.predicate,
                        object_entity_id=(object_entity.id if object_entity is not None else None),
                        object_value=claim.object_value,
                    ),
                    embedding=embedding,
                )
            )
        return PreparedSegment(
            id=job.segment_id,
            session_id=job.request.session_id,
            start_user_message_id=job.request.start_user_message_id,
            end_user_message_id=job.request.end_user_message_id,
            summary=extracted.summary,
            entities=tuple(entities),
            claims=tuple(claims),
            projection_version=job.request.projection_version,
        )

    @staticmethod
    def _selected_candidate(
        context: MentionContext, resolution: Resolution
    ) -> EntityCandidate | None:
        if resolution.candidate_entity_id is None:
            return None
        return next(
            candidate
            for candidate in context.candidates
            if candidate.id == resolution.candidate_entity_id
        )

    @staticmethod
    def _claim_text(claim: ExtractedClaim) -> str:
        object_text = claim.object_entity or claim.object_value
        return f"{claim.subject} | {claim.predicate} | {object_text}"

    @staticmethod
    def _unique_aliases(*aliases: str) -> tuple[str, ...]:
        unique: dict[str, str] = {}
        for alias in aliases:
            unique.setdefault(normalize_name(alias), alias.strip())
        return tuple(unique.values())
