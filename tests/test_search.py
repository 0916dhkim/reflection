from uuid import uuid4

import pytest

from reflection_service.domain import ClaimSupport, RecallCandidate
from reflection_service.search import SearchService

QUERY_EMBEDDING = (0.01,) * 1024


def recall_candidate(*, direct: bool, key: str, similarity: float) -> RecallCandidate:
    return RecallCandidate(
        subject="Reflection",
        subject_entity_id=uuid4(),
        predicate="uses",
        confidence=0.8,
        object_entity="PostgreSQL",
        object_entity_id=uuid4(),
        object_value=None,
        equivalence_key=key,
        segment_id=uuid4(),
        similarity=similarity,
        seed_similarity=None if direct else 0.7,
        is_direct=direct,
    )


class FakeEmbeddings:
    async def embed(self, texts: list[str], *, input_type: str) -> list[tuple[float, ...]]:
        assert texts == ["query"]
        assert input_type == "query"
        return [QUERY_EMBEDDING]


class FakeDatabase:
    def __init__(self) -> None:
        self.direct = recall_candidate(direct=True, key="direct", similarity=0.9)
        self.graph = recall_candidate(direct=False, key="graph", similarity=0.6)
        self.neighbor_calls: list[tuple[object, tuple[float, ...], float, int]] = []

    async def direct_claims(
        self, embedding: tuple[float, ...], limit: int
    ) -> list[RecallCandidate]:
        assert embedding == QUERY_EMBEDDING
        assert limit == 10
        return [self.direct]

    async def neighboring_claims(
        self,
        entity_id: object,
        embedding: tuple[float, ...],
        seed_similarity: float,
        limit: int,
    ) -> list[RecallCandidate]:
        self.neighbor_calls.append((entity_id, embedding, seed_similarity, limit))
        return [self.graph]

    async def support_for_equivalence_keys(self, keys: list[str]) -> dict[str, ClaimSupport]:
        assert set(keys) == {"direct", "graph"}
        return {
            "direct": ClaimSupport([self.direct.segment_id], 3, 2),
            "graph": ClaimSupport([self.graph.segment_id], 1, 1),
        }


@pytest.mark.asyncio
async def test_search_passes_query_embedding_to_each_neighbor_expansion() -> None:
    database = FakeDatabase()
    service = SearchService(database, FakeEmbeddings())  # type: ignore[arg-type]

    result = await service.search("query")

    assert len(database.neighbor_calls) == 2
    assert all(call[1] == QUERY_EMBEDDING for call in database.neighbor_calls)
    assert all(call[2:] == (0.9, 10) for call in database.neighbor_calls)
    assert result.claims[0].score > result.claims[1].score
    assert result.claims[0].support_count == 3
    assert result.claims[0].session_count == 2
