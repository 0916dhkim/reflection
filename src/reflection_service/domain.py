import hashlib
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from uuid import UUID, uuid5

from reflection_service.models import ExtractedClaim, Resolution, ResolutionResult, SearchClaim

SEGMENT_NAMESPACE = UUID("b14d5f2c-4cce-4f37-9e32-ea30c1fd1b42")
ENTITY_NAMESPACE = UUID("966769b5-ab08-4b02-8948-7db052586124")
CLAIM_NAMESPACE = UUID("194eb982-5e16-4011-bdcb-f13a86934da4")


class ExtractionValidationError(ValueError):
    pass


class TerminalExtractionValidationError(ExtractionValidationError):
    pass


def normalize_name(value: str) -> str:
    return " ".join(value.casefold().split())


def segment_id_for(session_id: str, start_user_message_id: str) -> UUID:
    return uuid5(SEGMENT_NAMESPACE, f"{session_id}\0{start_user_message_id}")


def new_entity_id_for(segment_id: UUID, canonical_name: str) -> UUID:
    return uuid5(ENTITY_NAMESPACE, f"{segment_id}\0{normalize_name(canonical_name)}")


def claim_id_for(segment_id: UUID, index: int) -> UUID:
    return uuid5(CLAIM_NAMESPACE, f"{segment_id}\0{index}")


def equivalence_key(
    subject_id: UUID,
    predicate: str,
    *,
    object_entity_id: UUID | None,
    object_value: str | None,
) -> str:
    if (object_entity_id is None) == (object_value is None):
        raise ExtractionValidationError(
            "equivalence key requires exactly one entity object or literal value"
        )
    object_key = (
        f"entity:{object_entity_id}"
        if object_entity_id is not None
        else f"literal:{normalize_name(object_value or '')}"
    )
    raw = f"{subject_id}\0{normalize_name(predicate)}\0{object_key}".encode()
    return hashlib.sha256(raw).hexdigest()


@dataclass(frozen=True, slots=True)
class EntityCandidate:
    id: UUID
    canonical_name: str
    description: str
    aliases: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class MentionContext:
    mention_id: str
    role: str
    text: str
    supporting_claim: str
    candidates: tuple[EntityCandidate, ...]


@dataclass(frozen=True, slots=True)
class PreparedEntity:
    id: UUID
    canonical_name: str
    normalized_name: str
    description: str
    aliases: tuple[str, ...]
    embedding: tuple[float, ...] | None
    is_new: bool


@dataclass(frozen=True, slots=True)
class PreparedClaim:
    id: UUID
    subject: str
    subject_entity_id: UUID
    predicate: str
    confidence: float
    object_entity: str | None
    object_entity_id: UUID | None
    object_value: str | None
    equivalence_key: str
    embedding: tuple[float, ...]


@dataclass(frozen=True, slots=True)
class PreparedSegment:
    id: UUID
    session_id: str
    start_user_message_id: str
    end_user_message_id: str
    summary: str
    entities: tuple[PreparedEntity, ...]
    claims: tuple[PreparedClaim, ...]


@dataclass(frozen=True, slots=True)
class RecallCandidate:
    subject: str
    subject_entity_id: UUID
    predicate: str
    confidence: float
    object_entity: str | None
    object_entity_id: UUID | None
    object_value: str | None
    equivalence_key: str
    segment_id: UUID
    similarity: float
    seed_similarity: float | None
    is_direct: bool


@dataclass(frozen=True, slots=True)
class ClaimSupport:
    segment_ids: list[UUID]
    support_count: int
    session_count: int


def union_candidates(
    trigram: Sequence[EntityCandidate], vector: Sequence[EntityCandidate]
) -> tuple[EntityCandidate, ...]:
    by_id: dict[UUID, EntityCandidate] = {}
    for candidate in (*trigram[:5], *vector[:5]):
        by_id.setdefault(candidate.id, candidate)
    return tuple(by_id.values())


def validate_resolutions(
    contexts: Sequence[MentionContext], result: ResolutionResult
) -> dict[str, tuple[MentionContext, Resolution]]:
    expected = {context.mention_id: context for context in contexts}
    actual = {resolution.mention_id: resolution for resolution in result.resolutions}
    if len(actual) != len(result.resolutions):
        raise ExtractionValidationError("entity resolution returned duplicate mention IDs")
    if actual.keys() != expected.keys():
        raise ExtractionValidationError("entity resolution must return every mention exactly once")
    validated: dict[str, tuple[MentionContext, Resolution]] = {}
    for mention_id, resolution in actual.items():
        allowed = {candidate.id for candidate in expected[mention_id].candidates}
        if (
            resolution.candidate_entity_id is not None
            and resolution.candidate_entity_id not in allowed
        ):
            raise ExtractionValidationError(
                f"entity resolution selected an unknown candidate for {mention_id}"
            )
        validated[mention_id] = (expected[mention_id], resolution)
    return validated


def validate_claim_decisions(
    proposed: Sequence[ExtractedClaim], result: ResolutionResult
) -> list[tuple[int, ExtractedClaim]]:
    expected = {f"c{index}" for index in range(len(proposed))}
    actual = {decision.claim_id: decision for decision in result.claims}
    if len(actual) != len(result.claims):
        raise ExtractionValidationError("claim triage returned duplicate claim IDs")
    if actual.keys() != expected:
        raise ExtractionValidationError(
            "claim triage must return every proposed claim exactly once"
        )

    kept: list[tuple[int, ExtractedClaim]] = []
    for index, claim in enumerate(proposed):
        decision = actual[f"c{index}"]
        if decision.action == "keep":
            kept.append((index, claim))
    return kept


def rank_and_group_claims(
    candidates: Iterable[RecallCandidate],
    support_by_key: dict[str, ClaimSupport],
    limit: int = 20,
) -> list[SearchClaim]:
    grouped: dict[str, tuple[RecallCandidate, float]] = {}
    for candidate in candidates:
        similarity = min(1.0, max(0.0, candidate.similarity))
        confidence = min(1.0, max(0.0, candidate.confidence))
        support = support_by_key.get(candidate.equivalence_key)
        session_count = support.session_count if support is not None else 1
        support_boost = min(0.1, 0.02 * max(0, session_count - 1))
        if candidate.is_direct:
            score = 1.0 + 0.8 * similarity + 0.2 * confidence + support_boost
        else:
            seed_similarity = min(1.0, max(0.0, candidate.seed_similarity or 0.0))
            relevance = 0.5 * similarity + 0.3 * seed_similarity + 0.2 * confidence
            score = 0.8 * relevance + support_boost
        current = grouped.get(candidate.equivalence_key)
        if current is None or score > current[1]:
            grouped[candidate.equivalence_key] = (candidate, score)

    ranked = sorted(grouped.values(), key=lambda item: item[1], reverse=True)[:limit]
    return [
        SearchClaim(
            subject=candidate.subject,
            subject_entity_id=candidate.subject_entity_id,
            predicate=candidate.predicate,
            confidence=candidate.confidence,
            object_entity=candidate.object_entity,
            object_entity_id=candidate.object_entity_id,
            object_value=candidate.object_value,
            segment_ids=(
                support_by_key[candidate.equivalence_key].segment_ids
                if candidate.equivalence_key in support_by_key
                else [candidate.segment_id]
            ),
            support_count=(
                support_by_key[candidate.equivalence_key].support_count
                if candidate.equivalence_key in support_by_key
                else 1
            ),
            session_count=(
                support_by_key[candidate.equivalence_key].session_count
                if candidate.equivalence_key in support_by_key
                else 1
            ),
            score=score,
        )
        for candidate, score in ranked
    ]
