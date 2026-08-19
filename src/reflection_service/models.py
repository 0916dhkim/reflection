import re
from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
NaturalPredicate = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=500, pattern=r"^[^_]+$"),
]
Description = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)
]
LiteralText = Annotated[str, StringConstraints(min_length=1, max_length=10_000)]
Identifier = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
MAX_MESSAGE_TEXT_CHARS = 1_000_000
MAX_SEGMENT_TEXT_CHARS = 2_000_000


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SourceMessage(StrictModel):
    role: Literal["user", "assistant"]
    text: Annotated[str, StringConstraints(max_length=MAX_MESSAGE_TEXT_CHARS)]


class SegmentCreate(StrictModel):
    session_id: Identifier
    start_user_message_id: Identifier
    end_user_message_id: Identifier
    messages: Annotated[list[SourceMessage], Field(min_length=1, max_length=10_000)]

    @model_validator(mode="after")
    def validate_aggregate_text_size(self) -> "SegmentCreate":
        if sum(len(message.text) for message in self.messages) > MAX_SEGMENT_TEXT_CHARS:
            raise ValueError(
                f"combined message text cannot exceed {MAX_SEGMENT_TEXT_CHARS} characters"
            )
        return self


class JobStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class JobResponse(StrictModel):
    id: int
    segment_id: UUID
    status: JobStatus
    attempts: int
    error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    next_attempt_at: datetime


class ClaimData(StrictModel):
    subject: str
    subject_entity_id: UUID
    predicate: str
    confidence: Annotated[float, Field(ge=0, le=1)]
    object_entity: str | None
    object_entity_id: UUID | None
    object_value: str | None

    @model_validator(mode="after")
    def validate_object(self) -> "ClaimData":
        has_entity = self.object_entity is not None and self.object_entity_id is not None
        has_partial_entity = (self.object_entity is None) != (self.object_entity_id is None)
        has_literal = self.object_value is not None
        if has_partial_entity or has_entity == has_literal:
            raise ValueError("claim must have exactly one complete entity object or literal value")
        return self


class SegmentResponse(StrictModel):
    id: UUID
    session_id: str
    start_user_message_id: str
    end_user_message_id: str
    summary: str
    claims: list[ClaimData]
    created_at: datetime
    updated_at: datetime


class SearchRequest(StrictModel):
    query: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=10_000)]


class SearchClaim(ClaimData):
    segment_ids: list[UUID]
    support_count: int
    session_count: int
    score: float


class SearchResponse(StrictModel):
    claims: list[SearchClaim]


class ExtractedClaim(StrictModel):
    subject: ShortText
    predicate: NaturalPredicate
    confidence: Annotated[float, Field(ge=0, le=1)]
    object_entity: ShortText | None
    object_value: LiteralText | None

    @field_validator("predicate")
    @classmethod
    def require_natural_predicate(cls, value: str) -> str:
        if re.search(r"[a-z][A-Z]", value):
            raise ValueError("predicate must use natural-language words separated by spaces")
        return value

    @model_validator(mode="after")
    def validate_object(self) -> "ExtractedClaim":
        if (self.object_entity is None) == (self.object_value is None):
            raise ValueError("claim must have exactly one entity object or literal value")
        return self


class ExtractionResult(StrictModel):
    summary: Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)]
    claims: Annotated[list[ExtractedClaim], Field(max_length=50)]


class Resolution(StrictModel):
    mention_id: str
    candidate_entity_id: UUID | None
    canonical_name: ShortText
    description: Description
    aliases: Annotated[list[ShortText], Field(max_length=20)]


class ResolutionResult(StrictModel):
    resolutions: Annotated[list[Resolution], Field(max_length=1000)]
