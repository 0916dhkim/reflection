import json
from collections.abc import Sequence
from typing import Any

import httpx
from pydantic import BaseModel, ValidationError

from reflection_service.config import Settings
from reflection_service.domain import MentionContext, TerminalExtractionValidationError
from reflection_service.models import ExtractionResult, ResolutionResult, SegmentCreate


class UpstreamResponseError(RuntimeError):
    pass


class UpstreamValidationError(UpstreamResponseError):
    pass


MAX_EMBEDDING_INPUT_BYTES = 30_000
MAX_EMBEDDING_BATCH_BYTES = 100_000
MAX_EMBEDDING_BATCH_ITEMS = 128


def partition_embedding_inputs(texts: Sequence[str]) -> list[list[str]]:
    batches: list[list[str]] = []
    batch: list[str] = []
    batch_bytes = 0
    for text in texts:
        text_bytes = len(text.encode("utf-8"))
        if text_bytes > MAX_EMBEDDING_INPUT_BYTES:
            raise TerminalExtractionValidationError(
                "generated embedding input is "
                f"{text_bytes} UTF-8 bytes; maximum is {MAX_EMBEDDING_INPUT_BYTES}"
            )
        if batch and (
            len(batch) >= MAX_EMBEDDING_BATCH_ITEMS
            or batch_bytes + text_bytes > MAX_EMBEDDING_BATCH_BYTES
        ):
            batches.append(batch)
            batch = []
            batch_bytes = 0
        batch.append(text)
        batch_bytes += text_bytes
    if batch:
        batches.append(batch)
    return batches


def strict_json_schema(model: type[BaseModel]) -> dict[str, Any]:
    schema = model.model_json_schema()

    def require_all_properties(node: Any) -> None:
        if isinstance(node, dict):
            properties = node.get("properties")
            if isinstance(properties, dict):
                node["required"] = list(properties)
            for value in node.values():
                require_all_properties(value)
        elif isinstance(node, list):
            for value in node:
                require_all_properties(value)

    require_all_properties(schema)
    return schema


class ModelClient:
    def __init__(self, client: httpx.AsyncClient, settings: Settings) -> None:
        self._client = client
        self._settings = settings

    async def extract(
        self, request: SegmentCreate, prior_summaries: Sequence[str]
    ) -> ExtractionResult:
        system = (
            "Extract durable, source-grounded memory from the source messages. "
            "Prior summaries are context only: every claim must be supported by the current source "
            "messages to the best of your ability. Do not return evidence quotes. Use concise "
            "entity names and predicates. Every claim subject is an entity. Set exactly one of "
            "object_entity or object_value; use object_value for literal strings, numbers, dates, "
            "settings, and other values. Give every claim a calibrated confidence from 0 to 1. "
            "The summary must be at most 1000 characters."
        )
        user = {
            "prior_session_segment_summaries": list(prior_summaries),
            "source_messages": [message.model_dump() for message in request.messages],
        }
        return await self._structured_call(
            model=self._settings.extraction_model,
            reasoning_effort="low",
            system=system,
            user=user,
            response_model=ExtractionResult,
            schema_name="reflection_extraction",
        )

    async def resolve(self, summary: str, mentions: Sequence[MentionContext]) -> ResolutionResult:
        system = (
            "Resolve every entity endpoint occurrence using its supporting claim and segment "
            "summary. Resolve to one supplied candidate or a new canonical entity, and return "
            "every mention_id exactly once. Identical mention text may refer to different entities "
            "in different claims. Select a candidate only when its description identifies the same "
            "real entity. For a new entity, provide a concise source-grounded description. For an "
            "existing candidate, preserve its canonical name and description. Keep useful aliases."
            " Different real entities must have distinguishable canonical names, such as "
            "Apple (company) and Apple (fruit)."
        )
        user = {
            "segment_summary": summary,
            "mentions": [
                {
                    "mention_id": mention.mention_id,
                    "role": mention.role,
                    "text": mention.text,
                    "supporting_claim": mention.supporting_claim,
                    "candidates": [
                        {
                            "entity_id": str(candidate.id),
                            "canonical_name": candidate.canonical_name,
                            "description": candidate.description,
                            "aliases": list(candidate.aliases),
                        }
                        for candidate in mention.candidates
                    ],
                }
                for mention in mentions
            ],
        }
        return await self._structured_call(
            model=self._settings.resolution_model,
            reasoning_effort="high",
            system=system,
            user=user,
            response_model=ResolutionResult,
            schema_name="entity_resolution",
        )

    async def _structured_call[T: BaseModel](
        self,
        *,
        model: str,
        reasoning_effort: str,
        system: str,
        user: dict[str, Any],
        response_model: type[T],
        schema_name: str,
    ) -> T:
        response = await self._client.post(
            f"{self._settings.openrouter_base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {self._settings.openrouter_api_key.get_secret_value()}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "reasoning": {"effort": reasoning_effort},
                "provider": {
                    "require_parameters": True,
                    "data_collection": "deny",
                    "zdr": True,
                },
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": json.dumps(user, separators=(",", ":"))},
                ],
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {
                        "name": schema_name,
                        "strict": True,
                        "schema": strict_json_schema(response_model),
                    },
                },
            },
        )
        response.raise_for_status()
        try:
            content = response.json()["choices"][0]["message"]["content"]
            if not isinstance(content, str):
                raise TypeError("message content is not a string")
            return response_model.model_validate_json(content)
        except (KeyError, IndexError, TypeError, ValueError, ValidationError) as exc:
            raise UpstreamValidationError("invalid structured model response") from exc


class EmbeddingClient:
    def __init__(self, client: httpx.AsyncClient, settings: Settings) -> None:
        self._client = client
        self._settings = settings

    async def embed(self, texts: Sequence[str], *, input_type: str) -> list[tuple[float, ...]]:
        if not texts:
            return []
        embeddings: list[tuple[float, ...]] = []
        for batch in partition_embedding_inputs(texts):
            embeddings.extend(await self._embed_batch(batch, input_type))
        return embeddings

    async def _embed_batch(self, texts: Sequence[str], input_type: str) -> list[tuple[float, ...]]:
        response = await self._client.post(
            f"{self._settings.voyage_base_url}/embeddings",
            headers={
                "Authorization": f"Bearer {self._settings.voyage_api_key.get_secret_value()}",
                "Content-Type": "application/json",
            },
            json={
                "model": self._settings.embedding_model,
                "input": list(texts),
                "input_type": input_type,
                "output_dimension": self._settings.embedding_dimensions,
                "truncation": False,
            },
        )
        response.raise_for_status()
        try:
            rows = sorted(response.json()["data"], key=lambda row: row["index"])
            embeddings = [tuple(float(value) for value in row["embedding"]) for row in rows]
        except (KeyError, TypeError, ValueError) as exc:
            raise UpstreamResponseError("invalid Voyage embedding response") from exc
        if len(embeddings) != len(texts) or any(
            len(embedding) != self._settings.embedding_dimensions for embedding in embeddings
        ):
            raise UpstreamResponseError("Voyage returned the wrong embedding shape")
        return embeddings
