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
EntityMention = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=500),
    Field(
        description=(
            "Self-contained entity name with enough owner or product context to identify it "
            "outside this source, such as 'Ideogram Pro plan' rather than 'Pro plan'."
        )
    ),
]
NaturalPredicate = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=500, pattern=r"^[^_]+$"),
    Field(
        description=(
            "Short user-facing natural-language verb phrase stored and displayed verbatim. "
            "Use lowercase words with spaces, never snake_case, camelCase, or database identifiers."
        )
    ),
]
Description = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)
]
LiteralText = Annotated[str, StringConstraints(min_length=1, max_length=10_000)]
Identifier = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
MAX_MESSAGE_TEXT_CHARS = 1_000_000
MAX_SEGMENT_TEXT_CHARS = 2_000_000
PROJECTION_SAFE_VERSION = 1


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SourceMessage(StrictModel):
    role: Literal["user", "assistant"]
    text: Annotated[str, StringConstraints(max_length=MAX_MESSAGE_TEXT_CHARS)]


class SegmentCreate(StrictModel):
    session_id: Identifier
    start_user_message_id: Identifier
    end_user_message_id: Identifier
    projection_version: Literal[0, 1] = 0
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
    projection_version: int
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


class SegmentSummary(StrictModel):
    id: UUID
    start_user_message_id: str
    end_user_message_id: str
    projection_version: int
    summary: str


class SegmentBoundary(StrictModel):
    id: UUID
    start_user_message_id: str
    end_user_message_id: str
    projection_version: int
    source_eligible: bool
    source_fingerprint: str | None


class SegmentTargetBoundary(StrictModel):
    id: UUID
    start_user_message_id: str
    end_user_message_id: str
    projection_version: int
    status: JobStatus
    source_fingerprint: str


class SessionSegmentsResponse(StrictModel):
    session_id: str
    segments: list[SegmentSummary]
    boundaries: list[SegmentBoundary]
    targets: list[SegmentTargetBoundary]


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
    subject: EntityMention
    predicate: NaturalPredicate
    confidence: Annotated[float, Field(ge=0, le=1)]
    object_entity: EntityMention | None
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
    claims: Annotated[list[ExtractedClaim], Field(max_length=25)]

    @model_validator(mode="before")
    @classmethod
    def normalize_claim_predicates(cls, value: object) -> object:
        if not isinstance(value, dict) or not isinstance(value.get("claims"), list):
            return value
        normalized_claims: list[object] = []
        for claim in value["claims"]:
            if not isinstance(claim, dict) or not isinstance(claim.get("predicate"), str):
                normalized_claims.append(claim)
                continue
            predicate = claim["predicate"].replace("_", " ")
            predicate = re.sub(r"([A-Z]{3,})([A-Z][a-z]{2,})", r"\1 \2", predicate)
            predicate = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", predicate)
            predicate = " ".join(predicate.lower().split())
            normalized_claims.append({**claim, "predicate": predicate})
        return {**value, "claims": normalized_claims}


class ExtractionObjectKind(StrEnum):
    ENTITY = "entity"
    LITERAL = "literal"


class ExtractionWireClaim(StrictModel):
    subject: EntityMention
    predicate: ShortText
    confidence: Annotated[float, Field(ge=0, le=1)]
    object_kind: ExtractionObjectKind
    object_text: LiteralText


class ExtractionWireResult(StrictModel):
    summary: Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)]
    claims: Annotated[list[ExtractionWireClaim], Field(max_length=25)]

    def to_extraction_result(self) -> ExtractionResult:
        return ExtractionResult.model_validate(
            {
                "summary": self.summary,
                "claims": [
                    {
                        "subject": claim.subject,
                        "predicate": claim.predicate,
                        "confidence": claim.confidence,
                        "object_entity": (
                            claim.object_text
                            if claim.object_kind is ExtractionObjectKind.ENTITY
                            else None
                        ),
                        "object_value": (
                            claim.object_text
                            if claim.object_kind is ExtractionObjectKind.LITERAL
                            else None
                        ),
                    }
                    for claim in self.claims
                ],
            }
        )


class ClaimDecision(StrictModel):
    claim_id: Annotated[str, StringConstraints(pattern=r"^c[0-9]+$")]
    action: Literal["keep", "drop", "review"]
    reason: Literal[
        "supported",
        "unstable_scope",
        "lifecycle_mismatch",
        "unsupported",
        "transient",
    ]

    @model_validator(mode="after")
    def require_reason_matching_action(self) -> "ClaimDecision":
        expected_action = (
            "keep"
            if self.reason == "supported"
            else "review"
            if self.reason == "unstable_scope"
            else "drop"
        )
        if self.action != expected_action:
            raise ValueError("claim action does not match its reason")
        return self


class Resolution(StrictModel):
    mention_id: str
    candidate_entity_id: Annotated[
        UUID | None,
        Field(
            description=(
                "Exact ID copied from this mention's supplied candidates, or null when creating a "
                "new entity. Always null when the candidate list is empty; never invent an ID."
            )
        ),
    ]
    canonical_name: ShortText
    description: Description
    aliases: Annotated[list[ShortText], Field(max_length=20)]


class ResolutionResult(StrictModel):
    claims: Annotated[list[ClaimDecision], Field(max_length=25)]
    resolutions: Annotated[list[Resolution], Field(max_length=1000)]
