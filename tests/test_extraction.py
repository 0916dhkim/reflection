from uuid import uuid4

import pytest

from reflection_service.db import ClaimedJob
from reflection_service.domain import MentionContext, segment_id_for
from reflection_service.extraction import ExtractionEngine
from reflection_service.models import (
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

    async def extract(
        self, _request: SegmentCreate, prior_summaries: list[str]
    ) -> ExtractionResult:
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
                    "object_value": "30",
                },
            ],
        )

    async def resolve(self, summary: str, contexts: tuple[MentionContext, ...]) -> ResolutionResult:
        assert summary == "Contextual summary"
        self.contexts = contexts
        canonical = {
            "c0.subject": "Alex One",
            "c0.object": "Jordan",
            "c1.subject": "Alex Two",
        }
        return ResolutionResult(
            resolutions=[
                Resolution(
                    mention_id=context.mention_id,
                    candidate_entity_id=None,
                    canonical_name=canonical[context.mention_id],
                    description=f"Description for {canonical[context.mention_id]}",
                    aliases=[],
                )
                for context in contexts
            ]
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
        attempts=1,
        request=request,
    )
    engine = ExtractionEngine(database, models, embeddings)  # type: ignore[arg-type]

    prepared = await engine.prepare(job)

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
    assert prepared.claims[1].object_value == "30"
    assert prepared.claims[0].subject_entity_id != prepared.claims[1].subject_entity_id
    assert {entity.description for entity in prepared.entities} == {
        "Description for Alex One",
        "Description for Alex Two",
        "Description for Jordan",
    }
