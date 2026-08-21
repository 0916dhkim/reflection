from collections.abc import Sequence
from uuid import uuid4

import pytest

from reflection_service.db import ClaimedJob
from reflection_service.domain import MentionContext, segment_id_for, source_fingerprint
from reflection_service.extraction import ExtractionEngine
from reflection_service.models import (
    ExtractedClaim,
    ExtractionResult,
    Resolution,
    ResolutionResult,
    SegmentCreate,
)


class FakeDatabase:
    def __init__(self) -> None:
        self.candidate_mentions: list[str] = []

    async def prior_summaries(self, _session_id: str, _segment_id: object) -> list[str]:
        return ["prior one", "prior two"]

    async def entity_candidates(self, mention: str, _embedding: tuple[float, ...]) -> tuple[()]:
        self.candidate_mentions.append(mention)
        return ()


class FakeModels:
    def __init__(self) -> None:
        self.contexts: tuple[MentionContext, ...] = ()
        self.priors: list[str] = []
        self.request: SegmentCreate | None = None

    async def extract(self, request: SegmentCreate, prior_summaries: list[str]) -> ExtractionResult:
        self.request = request
        self.priors = prior_summaries
        return ExtractionResult(
            summary="Contextual summary",
            claims=[
                {
                    "subject": "Alex",
                    "predicate": "likes",
                    "confidence": 0.9,
                    "object_entity": "Jordan",
                    "object_value": None,
                },
                {
                    "subject": "Alex",
                    "predicate": "has age",
                    "confidence": 0.7,
                    "object_entity": None,
                    "object_value": "30 years",
                },
            ],
        )

    async def resolve(
        self,
        summary: str,
        claims: Sequence[ExtractedClaim],
        contexts: tuple[MentionContext, ...],
    ) -> ResolutionResult:
        assert summary == "Contextual summary"
        self.contexts = contexts
        canonical = {
            "c0.subject": "Alex One",
            "c0.object": "Jordan",
            "c1.subject": "Alex Two",
        }
        return ResolutionResult(
            claims=[
                {
                    "claim_id": f"c{index}",
                    "action": "keep",
                }
                for index, _claim in enumerate(claims)
            ],
            resolutions=[
                Resolution(
                    mention_id=context.mention_id,
                    candidate_entity_id=None,
                    canonical_name=canonical[context.mention_id],
                    description=f"Description for {canonical[context.mention_id]}",
                    aliases=[],
                )
                for context in contexts
            ],
        )


class TriagingModels(FakeModels):
    async def extract(
        self, _request: SegmentCreate, _prior_summaries: list[str]
    ) -> ExtractionResult:
        return ExtractionResult(
            summary="PR-specific deployment discussion",
            claims=[
                {
                    "subject": "log-consumer",
                    "predicate": "blocks deployment of",
                    "confidence": 1,
                    "object_entity": "sampling-coordinator",
                    "object_value": None,
                },
                {
                    "subject": "Current discussion",
                    "predicate": "has temporary note",
                    "confidence": 0.6,
                    "object_entity": None,
                    "object_value": "recheck later",
                },
                {
                    "subject": "PR #14330 deployment order",
                    "predicate": "is",
                    "confidence": 0.95,
                    "object_entity": None,
                    "object_value": "log-consumer before sampling-coordinator",
                },
            ],
        )

    async def resolve(
        self,
        summary: str,
        claims: Sequence[ExtractedClaim],
        contexts: tuple[MentionContext, ...],
    ) -> ResolutionResult:
        assert summary == "PR-specific deployment discussion"
        assert claims[0].subject == "log-consumer"
        self.contexts = contexts
        return ResolutionResult(
            claims=[
                {
                    "claim_id": "c0",
                    "action": "drop",
                },
                {
                    "claim_id": "c1",
                    "action": "drop",
                },
                {
                    "claim_id": "c2",
                    "action": "keep",
                },
            ],
            resolutions=[
                Resolution(
                    mention_id="c2.subject",
                    candidate_entity_id=None,
                    canonical_name="PR #14330 deployment order",
                    description="The required service rollout order for PR #14330",
                    aliases=[],
                )
            ],
        )


class FakeEmbeddings:
    def __init__(self) -> None:
        self.calls: list[tuple[list[str], str]] = []

    async def embed(self, texts: list[str], *, input_type: str) -> list[tuple[float, ...]]:
        self.calls.append((texts, input_type))
        return [(0.01,) * 1024 for _ in texts]


@pytest.mark.asyncio
async def test_prepare_resolves_occurrences_but_not_literals_with_claim_context() -> None:
    database = FakeDatabase()
    models = FakeModels()
    embeddings = FakeEmbeddings()
    request = SegmentCreate(
        session_id="session",
        start_user_message_id="start",
        end_user_message_id="end",
        messages=[{"role": "user", "text": "source"}],
    )
    job = ClaimedJob(
        id=1,
        segment_id=segment_id_for("session", "start"),
        lease_id=uuid4(),
        source_generation=1,
        source_fingerprint=source_fingerprint(request),
        attempts=1,
        request=request,
    )
    engine = ExtractionEngine(database, models, embeddings)  # type: ignore[arg-type]

    prepared = await engine.prepare(job)

    assert models.request is request
    assert models.priors == ["prior one", "prior two"]
    assert [context.mention_id for context in models.contexts] == [
        "c0.subject",
        "c0.object",
        "c1.subject",
    ]
    assert database.candidate_mentions == ["Alex", "Jordan", "Alex"]
    assert "Alex | likes | Jordan" in embeddings.calls[0][0][0]
    assert "Contextual summary" in embeddings.calls[0][0][0]
    assert prepared.claims[0].object_entity_id is not None
    assert prepared.claims[0].confidence == 0.9
    assert prepared.claims[0].object_value is None
    assert prepared.claims[1].object_entity_id is None
    assert prepared.claims[1].object_value == "30 years"
    assert prepared.claims[0].subject_entity_id != prepared.claims[1].subject_entity_id
    assert {entity.description for entity in prepared.entities} == {
        "Description for Alex One",
        "Description for Alex Two",
        "Description for Jordan",
    }


@pytest.mark.asyncio
async def test_prepare_stores_only_contextualized_kept_claims() -> None:
    database = FakeDatabase()
    models = TriagingModels()
    embeddings = FakeEmbeddings()
    request = SegmentCreate(
        session_id="session",
        start_user_message_id="start",
        end_user_message_id="end",
        messages=[{"role": "user", "text": "source"}],
    )
    job = ClaimedJob(
        id=1,
        segment_id=segment_id_for("session", "start"),
        lease_id=uuid4(),
        source_generation=1,
        source_fingerprint=source_fingerprint(request),
        attempts=1,
        request=request,
    )

    prepared = await ExtractionEngine(database, models, embeddings).prepare(job)  # type: ignore[arg-type]

    assert [context.mention_id for context in models.contexts] == [
        "c0.subject",
        "c0.object",
        "c1.subject",
        "c2.subject",
    ]
    assert len(prepared.claims) == 1
    assert prepared.claims[0].subject == "PR #14330 deployment order"
    assert prepared.claims[0].predicate == "is"
    assert prepared.claims[0].object_value == "log-consumer before sampling-coordinator"
    assert prepared.claims[0].object_entity_id is None
    assert [entity.canonical_name for entity in prepared.entities] == ["PR #14330 deployment order"]
    document_inputs, input_type = embeddings.calls[1]
    assert input_type == "document"
    assert document_inputs[0] == (
        "PR #14330 deployment order | is | log-consumer before sampling-coordinator"
    )
    assert all("Current discussion" not in value for value in document_inputs)
