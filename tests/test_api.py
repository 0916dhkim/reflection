from datetime import UTC, datetime
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import httpx
import pytest

from reflection_service.app import create_app
from reflection_service.config import Settings
from reflection_service.models import JobResponse, JobStatus


def settings() -> Settings:
    return Settings(
        database_url="postgresql://unused",
        reflection_api_key="test-key",
        openrouter_api_key="test",
        voyage_api_key="test",
    )


def job_response(status: JobStatus = JobStatus.PENDING) -> JobResponse:
    now = datetime.now(UTC)
    return JobResponse(
        id=1,
        segment_id=uuid4(),
        status=status,
        attempts=0,
        error=None,
        created_at=now,
        started_at=None,
        finished_at=None,
        next_attempt_at=now,
    )


@pytest.mark.asyncio
async def test_segment_api_accepts_empty_text_and_one_large_turn() -> None:
    app = create_app(settings())
    app.state.database.enqueue = AsyncMock(return_value=job_response())
    app.state.worker.wake = Mock()
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            empty = await client.post(
                "/v1/segments",
                headers={"X-Api-Key": "test-key"},
                json={
                    "session_id": "session",
                    "start_user_message_id": "start",
                    "end_user_message_id": "end",
                    "messages": [{"role": "assistant", "text": ""}],
                },
            )
            large = await client.post(
                "/v1/segments",
                headers={"X-Api-Key": "test-key"},
                json={
                    "session_id": "session",
                    "start_user_message_id": "large",
                    "end_user_message_id": "large-end",
                    "messages": [{"role": "user", "text": "x" * 1_000_000}],
                },
            )
    finally:
        await app.state.http_client.aclose()

    assert empty.status_code == 202
    assert large.status_code == 202


@pytest.mark.asyncio
async def test_segment_api_rejects_aggregate_text_over_limit() -> None:
    app = create_app(settings())
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/v1/segments",
                headers={"X-Api-Key": "test-key"},
                json={
                    "session_id": "session",
                    "start_user_message_id": "start",
                    "end_user_message_id": "end",
                    "messages": [
                        {"role": "user", "text": "x" * 700_000},
                        {"role": "assistant", "text": "y" * 700_000},
                        {"role": "user", "text": "z" * 700_001},
                    ],
                },
            )
    finally:
        await app.state.http_client.aclose()

    assert response.status_code == 422
    assert "combined message text" in response.text


@pytest.mark.asyncio
async def test_retry_endpoint_is_authenticated_and_wakes_worker() -> None:
    app = create_app(settings())
    retried = job_response()
    app.state.database.retry_failed_job = AsyncMock(return_value=retried)
    app.state.worker.wake = Mock()
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            unauthorized = await client.post("/v1/jobs/1/retry")
            response = await client.post("/v1/jobs/1/retry", headers={"X-Api-Key": "test-key"})
    finally:
        await app.state.http_client.aclose()

    assert unauthorized.status_code == 401
    assert response.status_code == 202
    app.state.worker.wake.assert_called_once()
