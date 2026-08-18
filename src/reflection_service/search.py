import asyncio
from uuid import UUID

from reflection_service.clients import EmbeddingClient
from reflection_service.db import Database
from reflection_service.domain import RecallCandidate, rank_and_group_claims
from reflection_service.models import SearchResponse


class SearchService:
    def __init__(self, database: Database, embeddings: EmbeddingClient) -> None:
        self._database = database
        self._embeddings = embeddings

    async def search(self, query: str) -> SearchResponse:
        embedding = (await self._embeddings.embed([query], input_type="query"))[0]
        direct = await self._database.direct_claims(embedding, limit=10)
        entity_scores: dict[UUID, float] = {}
        for claim in direct:
            entity_ids = [claim.subject_entity_id]
            if claim.object_entity_id is not None:
                entity_ids.append(claim.object_entity_id)
            for entity_id in entity_ids:
                entity_scores[entity_id] = max(entity_scores.get(entity_id, 0.0), claim.similarity)
        neighbor_groups = await asyncio.gather(
            *(
                self._database.neighboring_claims(entity_id, embedding, score, limit=10)
                for entity_id, score in entity_scores.items()
            )
        )
        all_candidates: list[RecallCandidate] = [*direct]
        for neighbors in neighbor_groups:
            all_candidates.extend(neighbors)
        keys = list({candidate.equivalence_key for candidate in all_candidates})
        support = await self._database.support_for_equivalence_keys(keys)
        return SearchResponse(claims=rank_and_group_claims(all_candidates, support, limit=20))
