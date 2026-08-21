from dataclasses import dataclass, field
from uuid import uuid4

import pytest

from reflection_service.clients import UpstreamValidationError
from reflection_service.config import Settings
from reflection_service.db import ClaimedJob
from reflection_service.domain import (
    ExtractionValidationError,
    PreparedSegment,
    TerminalExtractionValidationError,
    source_fingerprint,
)
from reflection_service.models import SegmentCreate
from reflection_service.worker import ExtractionWorker


def settings() -> Settings:
    return Settings(
        database_url="postgresql://unused",
        reflection_api_key="test",
        openrouter_api_key="test",
        voyage_api_key="test",
        worker_max_attempts=3,
        worker_retry_backoff_seconds=0.25,
    )


def job(attempts: int) -> ClaimedJob:
    request = SegmentCreate(
        session_id="session",
        start_user_message_id="start",
        end_user_message_id="end",
        messages=[{"role": "user", "text": "text"}],
    )
    return ClaimedJob(
        id=1,
        segment_id=uuid4(),
        lease_id=uuid4(),
        source_generation=1,
        source_fingerprint=source_fingerprint(request),
        attempts=attempts,
        request=request,
    )


@dataclass
class FakeDatabase:
    failures: list[tuple[ClaimedJob, float | None]] = field(default_factory=list)

    async def finish_failed_attempt(
        self,
        claimed: ClaimedJob,
        _error: str,
        *,
        retry_after_seconds: float | None,
    ) -> bool:
        self.failures.append((claimed, retry_after_seconds))
        return True


class FailingEngine:
    def __init__(self, error: Exception) -> None:
        self.error = error

    async def prepare(self, _job: ClaimedJob) -> PreparedSegment:
        raise self.error


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("attempts", "error", "expected_backoff"),
    [
        (1, RuntimeError("transient"), 0.25),
        (3, RuntimeError("exhausted"), None),
        (1, ExtractionValidationError("invalid model output"), 0.25),
        (1, UpstreamValidationError("invalid schema output"), 0.25),
        (1, TerminalExtractionValidationError("embedding input too large"), None),
    ],
)
async def test_worker_retry_policy(
    attempts: int, error: Exception, expected_backoff: float | None
) -> None:
    database = FakeDatabase()
    worker = ExtractionWorker(database, FailingEngine(error), settings())  # type: ignore[arg-type]

    await worker._process(job(attempts))

    assert database.failures[0][1] == expected_backoff
