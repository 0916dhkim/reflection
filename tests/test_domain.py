from uuid import UUID, uuid4

import pytest

from reflection_service.domain import (
    ClaimSupport,
    EntityCandidate,
    ExtractionValidationError,
    MentionContext,
    RecallCandidate,
    equivalence_key,
    new_entity_id_for,
    normalize_name,
    rank_and_group_claims,
    segment_id_for,
    union_candidates,
    validate_resolutions,
)
from reflection_service.models import ExtractedClaim, Resolution, ResolutionResult


def test_segment_and_new_entity_ids_are_deterministic() -> None:
    segment_id = segment_id_for("session", "start")

    assert segment_id == segment_id_for("session", "start")
    assert segment_id != segment_id_for("session", "other-start")
    assert new_entity_id_for(segment_id, " Example ") == new_entity_id_for(segment_id, "example")


def test_normalize_name_is_case_and_whitespace_insensitive() -> None:
    assert normalize_name("  DeepSeek\n V4  ") == "deepseek v4"


def entity_candidate(name: str) -> EntityCandidate:
    return EntityCandidate(uuid4(), name, f"Description of {name}", ())


def test_candidate_union_caps_each_source_and_deduplicates() -> None:
    candidates = [entity_candidate(f"entity-{index}") for index in range(12)]

    result = union_candidates(candidates[:7], [candidates[0], *candidates[7:]])

    assert result == tuple([*candidates[:5], *candidates[7:11]])


def mention(mention_id: str, candidates: tuple[EntityCandidate, ...] = ()) -> MentionContext:
    return MentionContext(mention_id, "subject", "mention", "mention | uses | value", candidates)


def resolution(mention_id: str, candidate_id: UUID | None = None) -> Resolution:
    return Resolution(
        mention_id=mention_id,
        candidate_entity_id=candidate_id,
        canonical_name="Canonical",
        description="A canonical entity",
        aliases=[],
    )


def test_resolution_must_select_supplied_candidate() -> None:
    allowed = entity_candidate("Allowed")
    result = ResolutionResult(resolutions=[resolution("c0.subject", uuid4())])

    with pytest.raises(ExtractionValidationError, match="unknown candidate"):
        validate_resolutions([mention("c0.subject", (allowed,))], result)


def test_resolution_must_cover_every_occurrence_once() -> None:
    contexts = [mention("c0.subject"), mention("c1.subject")]
    result = ResolutionResult(resolutions=[resolution("c0.subject")])

    with pytest.raises(ExtractionValidationError, match="every mention"):
        validate_resolutions(contexts, result)


def test_claim_requires_exactly_one_object_kind() -> None:
    with pytest.raises(ValueError, match="exactly one"):
        ExtractedClaim(
            subject="Reflection",
            predicate="uses",
            confidence=0.8,
            object_entity="PostgreSQL",
            object_value="literal",
        )

    literal = ExtractedClaim(
        subject="Reflection",
        predicate="has timeout",
        confidence=0.7,
        object_entity=None,
        object_value="120 seconds",
    )
    assert literal.object_value == "120 seconds"

    with pytest.raises(ValueError, match="less than or equal to 1"):
        ExtractedClaim(
            subject="Reflection",
            predicate="uses",
            confidence=1.1,
            object_entity="PostgreSQL",
            object_value=None,
        )


def test_claim_predicate_must_use_natural_language() -> None:
    with pytest.raises(ValueError, match="pattern"):
        ExtractedClaim(
            subject="Acme Pro plan",
            predicate="has_monthly_credit_grant",
            confidence=0.9,
            object_entity=None,
            object_value="7200 credits",
        )

    with pytest.raises(ValueError, match="natural-language"):
        ExtractedClaim(
            subject="Acme Pro plan",
            predicate="hasMonthlyCreditGrant",
            confidence=0.9,
            object_entity=None,
            object_value="7200 credits",
        )

    claim = ExtractedClaim(
        subject="Acme Pro plan",
        predicate="has monthly credit grant",
        confidence=0.9,
        object_entity=None,
        object_value="7200 credits",
    )
    assert claim.predicate == "has monthly credit grant"


def test_literal_and_entity_equivalence_keys_are_distinct() -> None:
    subject_id = uuid4()
    object_id = uuid4()

    entity_key = equivalence_key(subject_id, "uses", object_entity_id=object_id, object_value=None)
    literal_key = equivalence_key(
        subject_id, "uses", object_entity_id=None, object_value=str(object_id)
    )

    assert entity_key != literal_key


def candidate(
    *,
    key: str,
    direct: bool,
    similarity: float,
    segment_id: UUID | None = None,
    literal: bool = False,
    confidence: float = 0.8,
    seed_similarity: float | None = None,
) -> RecallCandidate:
    return RecallCandidate(
        subject="Subject",
        subject_entity_id=uuid4(),
        predicate="uses",
        confidence=confidence,
        object_entity=None if literal else "Object",
        object_entity_id=None if literal else uuid4(),
        object_value="literal" if literal else None,
        equivalence_key=key,
        segment_id=segment_id or uuid4(),
        similarity=similarity,
        seed_similarity=seed_similarity,
        is_direct=direct,
    )


def test_recall_ranks_direct_ahead_of_graph_and_groups_equivalents() -> None:
    direct_segment = uuid4()
    equivalent_segment = uuid4()
    rows = [
        candidate(key="direct", direct=True, similarity=-0.2, segment_id=direct_segment),
        candidate(
            key="graph",
            direct=False,
            similarity=1.0,
            literal=True,
            seed_similarity=0.9,
        ),
        candidate(
            key="direct",
            direct=False,
            similarity=1.0,
            segment_id=equivalent_segment,
            seed_similarity=1.0,
        ),
    ]

    result = rank_and_group_claims(
        rows,
        {
            "direct": ClaimSupport(
                segment_ids=[direct_segment, equivalent_segment],
                support_count=2,
                session_count=3,
            ),
            "graph": ClaimSupport(
                segment_ids=[rows[1].segment_id], support_count=1, session_count=1
            ),
        },
    )

    assert result[0].score > result[1].score
    assert result[0].segment_ids == [direct_segment, equivalent_segment]
    assert result[0].support_count == 2
    assert result[0].session_count == 3
    assert result[1].object_value == "literal"


def test_distinct_session_support_boost_is_capped() -> None:
    row = candidate(key="claim", direct=True, similarity=0.5, confidence=0.5)
    low = rank_and_group_claims(
        [row],
        {"claim": ClaimSupport([row.segment_id], support_count=1, session_count=1)},
    )[0]
    high = rank_and_group_claims(
        [row],
        {"claim": ClaimSupport([row.segment_id], support_count=20, session_count=20)},
    )[0]

    assert high.score - low.score == pytest.approx(0.1)


def test_graph_score_combines_own_seed_similarity_and_confidence() -> None:
    baseline = candidate(
        key="baseline",
        direct=False,
        similarity=0.5,
        seed_similarity=0.1,
        confidence=0.1,
    )
    stronger_seed = candidate(
        key="seed",
        direct=False,
        similarity=0.5,
        seed_similarity=0.9,
        confidence=0.1,
    )
    stronger_confidence = candidate(
        key="confidence",
        direct=False,
        similarity=0.5,
        seed_similarity=0.1,
        confidence=0.9,
    )
    support = {
        row.equivalence_key: ClaimSupport([row.segment_id], 1, 1)
        for row in (baseline, stronger_seed, stronger_confidence)
    }

    ranked = rank_and_group_claims([baseline, stronger_seed, stronger_confidence], support)
    scores = {claim.segment_ids[0]: claim.score for claim in ranked}

    assert scores[stronger_seed.segment_id] > scores[baseline.segment_id]
    assert scores[stronger_confidence.segment_id] > scores[baseline.segment_id]
