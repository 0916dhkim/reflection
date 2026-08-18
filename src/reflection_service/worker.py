import asyncio
import logging
from contextlib import suppress
from typing import Any

from psycopg import AsyncConnection

from reflection_service.config import Settings
from reflection_service.db import ClaimedJob, Database
from reflection_service.domain import TerminalExtractionValidationError
from reflection_service.extraction import ExtractionEngine

logger = logging.getLogger(__name__)


class ExtractionWorker:
    def __init__(self, database: Database, engine: ExtractionEngine, settings: Settings) -> None:
        self._database = database
        self._engine = engine
        self._settings = settings
        self._stop = asyncio.Event()
        self._wake = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="reflection-extraction-worker")

    async def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._task is not None:
            await self._task

    def wake(self) -> None:
        self._wake.set()

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                async with self._database.pool.connection() as connection:
                    acquired = await self._try_lock(connection)
                    if not acquired:
                        await self._wait_for_work()
                        continue
                    try:
                        recovered = await self._database.recover_running_jobs(connection)
                        if recovered:
                            logger.warning("recovered %d interrupted extraction jobs", recovered)
                        await self._work_loop(connection)
                    finally:
                        with suppress(Exception):
                            await connection.execute(
                                "SELECT pg_advisory_unlock(%s)",
                                (self._settings.worker_lock_id,),
                            )
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("worker loop failed; retrying")
                await self._wait_for_work()

    async def _work_loop(self, connection: AsyncConnection[Any]) -> None:
        while not self._stop.is_set():
            job = await self._database.claim_oldest_job(connection)
            if job is None:
                await self._wait_for_work()
                continue
            await self._process(job)

    async def _process(self, job: ClaimedJob) -> None:
        try:
            prepared = await self._engine.prepare(job)
            await self._database.commit_extraction(job, prepared)
        except asyncio.CancelledError:
            raise
        except TerminalExtractionValidationError as exc:
            logger.exception("extraction job %d has invalid deterministic input", job.id)
            updated = await self._database.finish_failed_attempt(
                job,
                f"{type(exc).__name__}: {exc}",
                retry_after_seconds=None,
            )
            if not updated:
                logger.info("ignored deterministic failure from stale lease for job %d", job.id)
        except Exception as exc:
            should_retry = job.attempts < self._settings.worker_max_attempts
            logger.exception(
                "extraction job %d attempt %d failed%s",
                job.id,
                job.attempts,
                "; retrying" if should_retry else "",
            )
            updated = await self._database.finish_failed_attempt(
                job,
                f"{type(exc).__name__}: {exc}",
                retry_after_seconds=(
                    self._settings.worker_retry_backoff_seconds if should_retry else None
                ),
            )
            if not updated:
                logger.info("ignored failure from stale lease for job %d", job.id)

    async def _try_lock(self, connection: AsyncConnection[Any]) -> bool:
        cursor = await connection.execute(
            "SELECT pg_try_advisory_lock(%s) AS acquired",
            (self._settings.worker_lock_id,),
        )
        row = await cursor.fetchone()
        return bool(row and row["acquired"])

    async def _wait_for_work(self) -> None:
        try:
            await asyncio.wait_for(self._wake.wait(), timeout=self._settings.worker_poll_seconds)
        except TimeoutError:
            pass
        finally:
            self._wake.clear()
