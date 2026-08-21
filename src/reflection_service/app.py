import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Response, status
from fastapi.responses import JSONResponse

from reflection_service.auth import APIKeyAuth
from reflection_service.clients import EmbeddingClient, ModelClient, UpstreamResponseError
from reflection_service.config import Settings
from reflection_service.db import Database, JobNotRetryableError
from reflection_service.extraction import ExtractionEngine
from reflection_service.models import (
    JobResponse,
    SearchRequest,
    SearchResponse,
    SegmentCreate,
    SegmentResponse,
    SessionSegmentsResponse,
)
from reflection_service.search import SearchService
from reflection_service.worker import ExtractionWorker

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    configured = settings or Settings()  # type: ignore[call-arg]
    logging.basicConfig(level=configured.log_level)

    database = Database(configured)
    timeout = httpx.Timeout(configured.request_timeout_seconds)
    http_client = httpx.AsyncClient(timeout=timeout)
    model_client = ModelClient(http_client, configured)
    embedding_client = EmbeddingClient(http_client, configured)
    engine = ExtractionEngine(database, model_client, embedding_client)
    search_service = SearchService(database, embedding_client)
    worker = ExtractionWorker(database, engine, configured)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await database.open()
        worker.start()
        app.state.database = database
        app.state.worker = worker
        try:
            yield
        finally:
            await worker.stop()
            await http_client.aclose()
            await database.close()

    app = FastAPI(title="Reflection", version="0.1.0", lifespan=lifespan)
    app.state.database = database
    app.state.worker = worker
    app.state.http_client = http_client
    auth = APIKeyAuth(configured.reflection_api_key.get_secret_value())
    router = APIRouter(prefix="/v1", dependencies=[Depends(auth)])

    @app.exception_handler(UpstreamResponseError)
    async def handle_upstream_response_error(
        _request: Any, exception: UpstreamResponseError
    ) -> JSONResponse:
        logger.warning("upstream returned invalid data: %s", exception)
        return JSONResponse(status_code=502, content={"detail": "invalid upstream response"})

    @app.exception_handler(httpx.HTTPError)
    async def handle_upstream_http_error(_request: Any, exception: httpx.HTTPError) -> JSONResponse:
        logger.warning("upstream request failed: %s", exception)
        return JSONResponse(status_code=502, content={"detail": "upstream request failed"})

    @app.get("/healthz", include_in_schema=False)
    async def healthz(response: Response) -> dict[str, str]:
        try:
            await database.healthcheck()
        except Exception:
            logger.exception("database health check failed")
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
            return {"status": "unhealthy"}
        return {"status": "ok"}

    @router.post("/segments", response_model=JobResponse, status_code=202)
    async def enqueue_segment(request: SegmentCreate) -> JobResponse:
        job = await database.enqueue(request)
        worker.wake()
        return job

    @router.get("/jobs/{job_id}", response_model=JobResponse)
    async def get_job(job_id: int) -> JobResponse:
        job = await database.get_job(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        return job

    @router.post("/jobs/{job_id}/retry", response_model=JobResponse, status_code=202)
    async def retry_job(job_id: int) -> JobResponse:
        try:
            job = await database.retry_failed_job(job_id)
        except JobNotRetryableError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        worker.wake()
        return job

    @router.get("/segments/{segment_id}", response_model=SegmentResponse)
    async def get_segment(segment_id: UUID) -> SegmentResponse:
        segment = await database.get_segment(segment_id)
        if segment is None:
            raise HTTPException(status_code=404, detail="segment not found")
        return segment

    @router.get("/sessions/{session_id}/segments", response_model=SessionSegmentsResponse)
    async def get_session_segments(session_id: str) -> SessionSegmentsResponse:
        segments, boundaries, targets = await database.session_segment_listing(session_id)
        return SessionSegmentsResponse(
            session_id=session_id,
            segments=segments,
            boundaries=boundaries,
            targets=targets,
        )

    @router.post("/search", response_model=SearchResponse)
    async def search(request: SearchRequest) -> SearchResponse:
        return await search_service.search(request.query)

    app.include_router(router)
    return app
