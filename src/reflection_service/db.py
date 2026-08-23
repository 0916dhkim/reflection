import asyncio
import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from pgvector import Vector
from pgvector.psycopg import register_vector_async
from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool
from pydantic import ValidationError

from reflection_service.config import Settings
from reflection_service.domain import (
    ClaimSupport,
    EntityCandidate,
    PreparedSegment,
    RecallCandidate,
    normalize_name,
    projection_fingerprint,
    segment_id_for,
    source_fingerprint,
    union_candidates,
)
from reflection_service.models import (
    PROJECTION_SAFE_VERSION,
    JobResponse,
    SegmentBoundary,
    SegmentCreate,
    SegmentResponse,
    SegmentSummary,
    SegmentTargetBoundary,
)

_SEGMENT_ELIGIBILITY_SQL = """
    s.projection_commit_fingerprint = reflection_projection_fingerprint(
        s.id,
        s.end_user_message_id,
        s.summary,
        s.projection_version
    )
    AND (t.segment_id IS NULL OR t.source_fingerprint = s.source_fingerprint)
"""


class JobNotRetryableError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ClaimedJob:
    id: int
    segment_id: UUID
    lease_id: UUID
    source_generation: int
    source_fingerprint: str
    attempts: int
    request: SegmentCreate


async def _configure_connection(connection: AsyncConnection[Any]) -> None:
    await register_vector_async(connection)


class Database:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self.pool = AsyncConnectionPool(
            conninfo=settings.database_url.get_secret_value(),
            min_size=settings.database_pool_min_size,
            max_size=settings.database_pool_max_size,
            kwargs={"autocommit": True, "row_factory": dict_row},
            configure=_configure_connection,
            open=False,
        )

    async def open(self) -> None:
        await self.apply_migrations(self._settings.migrations_dir)
        await self.pool.open(wait=True)

    async def close(self) -> None:
        await self.pool.close()

    async def apply_migrations(self, directory: Path) -> None:
        migration_paths = await asyncio.to_thread(lambda: sorted(directory.glob("*.sql")))
        if not migration_paths:
            raise RuntimeError(f"no SQL migrations found in {directory}")
        connection = await AsyncConnection.connect(
            self._settings.database_url.get_secret_value(), autocommit=True
        )
        async with connection:
            for path in migration_paths:
                sql = await asyncio.to_thread(path.read_text)
                async with connection.transaction():
                    await connection.execute(
                        "SELECT pg_advisory_xact_lock(%s)",
                        (self._settings.migration_lock_id,),
                    )
                    await connection.execute(sql)

    async def healthcheck(self) -> None:
        async with self.pool.connection() as connection:
            await connection.execute("SELECT 1")

    @staticmethod
    async def _lock_segment(connection: AsyncConnection[Any], segment_id: UUID) -> None:
        """Serialize job, target, then segment mutations for one deterministic segment."""
        await connection.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            (str(segment_id),),
        )

    async def enqueue(self, request: SegmentCreate) -> JobResponse:
        segment_id = segment_id_for(request.session_id, request.start_user_message_id)
        fingerprint = source_fingerprint(request)
        payload = Jsonb(request.model_dump(mode="json"))
        async with self.pool.connection() as connection, connection.transaction():
            await self._lock_segment(connection, segment_id)
            jobs_cursor = await connection.execute(
                """
                SELECT id, status, projection_version, source_generation, source_fingerprint,
                       end_user_message_id
                FROM extraction_jobs
                WHERE segment_id = %s
                FOR UPDATE
                """,
                (segment_id,),
            )
            jobs = await jobs_cursor.fetchall()
            target_cursor = await connection.execute(
                """
                SELECT job_id, projection_version, payload, source_generation,
                       source_fingerprint
                FROM segment_targets
                WHERE segment_id = %s
                FOR UPDATE
                """,
                (segment_id,),
            )
            target = await target_cursor.fetchone()
            segment_cursor = await connection.execute(
                """
                SELECT s.end_user_message_id, s.projection_version, s.source_generation,
                       s.source_fingerprint,
                       s.projection_commit_fingerprint = reflection_projection_fingerprint(
                           s.id,
                           s.end_user_message_id,
                           s.summary,
                           s.projection_version
                       ) AS projection_safe
                FROM segments s
                WHERE s.id = %s
                FOR UPDATE
                """,
                (segment_id,),
            )
            current_segment = await segment_cursor.fetchone()
            boundary_job = next(
                (
                    item
                    for item in jobs
                    if item["end_user_message_id"] == request.end_user_message_id
                ),
                None,
            )

            lower_version = (
                (
                    current_segment is not None
                    and request.projection_version < current_segment["projection_version"]
                )
                or (
                    target is not None and request.projection_version < target["projection_version"]
                )
                or (
                    boundary_job is not None
                    and request.projection_version < boundary_job["projection_version"]
                )
            )
            if lower_version:
                if boundary_job is None:
                    ignored_cursor = await connection.execute(
                        """
                        INSERT INTO extraction_jobs (
                            segment_id, session_id, start_user_message_id,
                            end_user_message_id, projection_version, payload, status,
                            source_fingerprint, finished_at, error
                        )
                        VALUES (
                            %s, %s, %s, %s, %s, NULL, 'superseded', %s, now(),
                            'snapshot was superseded'
                        )
                        RETURNING id
                        """,
                        (
                            segment_id,
                            request.session_id,
                            request.start_user_message_id,
                            request.end_user_message_id,
                            request.projection_version,
                            fingerprint,
                        ),
                    )
                    ignored = await ignored_cursor.fetchone()
                    if ignored is None:
                        raise RuntimeError("ignored job insert did not return a row")
                    job_id = ignored["id"]
                else:
                    job_id = boundary_job["id"]
                row = await self._job_row(connection, job_id)
                if row is None:
                    raise RuntimeError("ignored job disappeared during enqueue")
                return self._job_response(row)

            if target is not None and (
                target["source_fingerprint"] == fingerprint
                and target["projection_version"] == request.projection_version
            ):
                if not any(
                    item["status"] == "running" and item["id"] != target["job_id"] for item in jobs
                ):
                    await connection.execute(
                        """
                        UPDATE extraction_jobs
                        SET projection_version = %s, payload = %s, source_generation = %s,
                            source_fingerprint = %s, status = 'pending', attempts = 0,
                            lease_id = NULL, error = NULL, started_at = NULL,
                            finished_at = NULL, next_attempt_at = now()
                        WHERE id = %s AND status <> 'running'
                        """,
                        (
                            target["projection_version"],
                            Jsonb(target["payload"]),
                            target["source_generation"],
                            target["source_fingerprint"],
                            target["job_id"],
                        ),
                    )
                row = await self._job_row(connection, target["job_id"])
                if row is None:
                    raise RuntimeError("target job disappeared during enqueue")
                return self._job_response(row)

            if (
                current_segment is not None
                and target is None
                and current_segment["source_fingerprint"] == fingerprint
                and current_segment["projection_version"] == request.projection_version
                and (
                    request.projection_version < PROJECTION_SAFE_VERSION
                    or current_segment["projection_safe"]
                )
            ):
                if boundary_job is None:
                    settled_cursor = await connection.execute(
                        """
                        INSERT INTO extraction_jobs (
                            segment_id, session_id, start_user_message_id,
                            end_user_message_id, projection_version, payload, status,
                            source_generation, source_fingerprint, finished_at
                        )
                        VALUES (%s, %s, %s, %s, %s, NULL, 'succeeded', %s, %s, now())
                        RETURNING id
                        """,
                        (
                            segment_id,
                            request.session_id,
                            request.start_user_message_id,
                            request.end_user_message_id,
                            request.projection_version,
                            current_segment["source_generation"],
                            fingerprint,
                        ),
                    )
                    settled = await settled_cursor.fetchone()
                    if settled is None:
                        raise RuntimeError("settled job insert did not return a row")
                    job_id = settled["id"]
                else:
                    job_id = boundary_job["id"]
                    await connection.execute(
                        """
                        UPDATE extraction_jobs
                        SET status = 'succeeded', lease_id = NULL, payload = NULL,
                            projection_version = %s, source_generation = %s,
                            source_fingerprint = %s, error = NULL, started_at = NULL,
                            finished_at = COALESCE(finished_at, now())
                        WHERE id = %s AND status <> 'running'
                        """,
                        (
                            request.projection_version,
                            current_segment["source_generation"],
                            fingerprint,
                            job_id,
                        ),
                    )
                row = await self._job_row(connection, job_id)
                if row is None:
                    raise RuntimeError("settled job disappeared during enqueue")
                return self._job_response(row)

            generation = (
                max(
                    [
                        current_segment["source_generation"] if current_segment else 0,
                        target["source_generation"] if target else 0,
                        *(item["source_generation"] for item in jobs),
                    ]
                )
                + 1
            )
            job_cursor = await connection.execute(
                """
                INSERT INTO extraction_jobs (
                    segment_id, session_id, start_user_message_id, end_user_message_id,
                    projection_version, payload, source_generation, source_fingerprint
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (session_id, start_user_message_id, end_user_message_id)
                DO UPDATE SET
                    projection_version = EXCLUDED.projection_version,
                    payload = EXCLUDED.payload,
                    source_generation = EXCLUDED.source_generation,
                    source_fingerprint = EXCLUDED.source_fingerprint,
                    status = 'pending', attempts = 0, lease_id = NULL, error = NULL,
                    started_at = NULL, finished_at = NULL, next_attempt_at = now()
                WHERE extraction_jobs.status <> 'running'
                RETURNING id
                """,
                (
                    segment_id,
                    request.session_id,
                    request.start_user_message_id,
                    request.end_user_message_id,
                    request.projection_version,
                    payload,
                    generation,
                    fingerprint,
                ),
            )
            job = await job_cursor.fetchone()
            if job is not None:
                job_id = job["id"]
            elif boundary_job is not None:
                job_id = boundary_job["id"]
            else:
                raise RuntimeError("running boundary job disappeared during enqueue")
            await connection.execute(
                """
                INSERT INTO segment_targets (
                    segment_id, job_id, end_user_message_id, projection_version, payload,
                    source_generation, source_fingerprint
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (segment_id) DO UPDATE
                SET job_id = EXCLUDED.job_id,
                    end_user_message_id = EXCLUDED.end_user_message_id,
                    projection_version = EXCLUDED.projection_version,
                    payload = EXCLUDED.payload,
                    source_generation = EXCLUDED.source_generation,
                    source_fingerprint = EXCLUDED.source_fingerprint,
                    updated_at = now()
                """,
                (
                    segment_id,
                    job_id,
                    request.end_user_message_id,
                    request.projection_version,
                    payload,
                    generation,
                    fingerprint,
                ),
            )
            superseded_ids = [
                item["id"]
                for item in jobs
                if item["id"] != job_id and item["status"] in {"pending", "failed"}
            ]
            if superseded_ids:
                await connection.execute(
                    """
                    UPDATE extraction_jobs
                    SET status = 'superseded', payload = NULL, lease_id = NULL,
                        error = 'snapshot was superseded', started_at = NULL,
                        finished_at = now()
                    WHERE id = ANY(%s)
                    """,
                    (superseded_ids,),
                )
            row = await self._job_row(connection, job_id)
            if row is None:
                raise RuntimeError("target job disappeared during enqueue")
        return self._job_response(row)

    async def get_job(self, job_id: int) -> JobResponse | None:
        async with self.pool.connection() as connection:
            row = await self._job_row(connection, job_id)
        return self._job_response(row) if row is not None else None

    async def retry_failed_job(self, job_id: int) -> JobResponse | None:
        async with self.pool.connection() as connection, connection.transaction():
            segment_cursor = await connection.execute(
                "SELECT segment_id FROM extraction_jobs WHERE id = %s",
                (job_id,),
            )
            segment = await segment_cursor.fetchone()
            if segment is None:
                return None
            await self._lock_segment(connection, segment["segment_id"])
            job_cursor = await connection.execute(
                """
                SELECT id, segment_id, status, lease_id, source_generation, source_fingerprint
                FROM extraction_jobs
                WHERE id = %s
                FOR UPDATE
                """,
                (job_id,),
            )
            job = await job_cursor.fetchone()
            if job is None:
                return None
            target_cursor = await connection.execute(
                """
                SELECT job_id, projection_version, payload,
                       source_generation, source_fingerprint
                FROM segment_targets
                WHERE segment_id = %s
                FOR UPDATE
                """,
                (job["segment_id"],),
            )
            target = await target_cursor.fetchone()
            if job["status"] != "failed" or job["lease_id"] is not None:
                raise JobNotRetryableError("only terminal failed jobs can be retried")
            if target is None or (
                target["job_id"] != job["id"]
                or target["source_generation"] != job["source_generation"]
                or target["source_fingerprint"] != job["source_fingerprint"]
            ):
                raise JobNotRetryableError(
                    "job cannot be retried because a newer snapshot exists for the segment"
                )
            cursor = await connection.execute(
                """
                UPDATE extraction_jobs
                SET projection_version = %s, payload = %s, source_generation = %s,
                    source_fingerprint = %s, status = 'pending', attempts = 0,
                    error = NULL, lease_id = NULL, started_at = NULL,
                    finished_at = NULL, next_attempt_at = now()
                WHERE id = %s AND status = 'failed' AND lease_id IS NULL
                RETURNING id, segment_id, projection_version, status, attempts, error,
                          created_at, started_at, finished_at, next_attempt_at
                """,
                (
                    target["projection_version"],
                    Jsonb(target["payload"]),
                    target["source_generation"],
                    target["source_fingerprint"],
                    job_id,
                ),
            )
            row = await cursor.fetchone()
            if row is None:
                raise RuntimeError("failed job changed while retrying")
            return self._job_response(row)

    async def recover_running_jobs(self, connection: AsyncConnection[Any]) -> int:
        async with connection.transaction():
            segments_cursor = await connection.execute(
                """
                SELECT segment_id
                FROM extraction_jobs
                WHERE status = 'running'
                ORDER BY segment_id, id
                """
            )
            segment_ids = list(
                dict.fromkeys(row["segment_id"] for row in await segments_cursor.fetchall())
            )
            if not segment_ids:
                return 0
            for segment_id in segment_ids:
                await self._lock_segment(connection, segment_id)

            cursor = await connection.execute(
                """
                WITH classified AS (
                    SELECT jobs.id,
                           targets.job_id = jobs.id AS is_target,
                           targets.projection_version AS target_projection_version,
                           targets.payload AS target_payload,
                           targets.source_generation AS target_generation,
                           targets.source_fingerprint AS target_fingerprint
                    FROM extraction_jobs AS jobs
                    LEFT JOIN segment_targets AS targets ON targets.segment_id = jobs.segment_id
                    WHERE jobs.status = 'running'
                      AND jobs.segment_id = ANY(%s)
                    FOR UPDATE OF jobs
                )
                UPDATE extraction_jobs AS jobs
                SET projection_version = CASE
                        WHEN classified.is_target
                        THEN classified.target_projection_version
                        ELSE jobs.projection_version
                    END,
                    payload = CASE
                        WHEN classified.is_target THEN classified.target_payload
                        ELSE NULL
                    END,
                    source_generation = CASE
                        WHEN classified.is_target THEN classified.target_generation
                        ELSE jobs.source_generation
                    END,
                    source_fingerprint = CASE
                        WHEN classified.is_target THEN classified.target_fingerprint
                        ELSE jobs.source_fingerprint
                    END,
                    status = CASE
                        WHEN classified.is_target THEN 'pending'
                        ELSE 'superseded'
                    END,
                    attempts = CASE
                        WHEN classified.is_target
                         AND (
                             classified.target_generation <> jobs.source_generation
                             OR classified.target_fingerprint
                                IS DISTINCT FROM jobs.source_fingerprint
                             OR classified.target_projection_version <> jobs.projection_version
                         )
                        THEN 0
                        ELSE jobs.attempts
                    END,
                    lease_id = NULL,
                    started_at = NULL,
                    finished_at = CASE WHEN classified.is_target THEN NULL ELSE now() END,
                    next_attempt_at = now(),
                    error = CASE
                        WHEN classified.is_target
                        THEN 'worker stopped before completing the job'
                        ELSE 'superseded while worker was stopped'
                    END
                FROM classified
                WHERE jobs.id = classified.id
                """,
                (segment_ids,),
            )
            return cursor.rowcount

    async def claim_oldest_job(self, connection: AsyncConnection[Any]) -> ClaimedJob | None:
        async with connection.transaction():
            cursor = await connection.execute(
                """
                SELECT jobs.id, jobs.segment_id, jobs.session_id,
                       jobs.start_user_message_id, jobs.end_user_message_id,
                       jobs.projection_version, jobs.payload, jobs.source_generation,
                       jobs.source_fingerprint, jobs.next_attempt_at <= now() AS ready
                FROM extraction_jobs AS jobs
                LEFT JOIN segment_targets AS targets
                  ON targets.segment_id = jobs.segment_id
                 AND targets.job_id = jobs.id
                 AND targets.source_generation = jobs.source_generation
                 AND targets.source_fingerprint = jobs.source_fingerprint
                 AND targets.projection_version = jobs.projection_version
                WHERE jobs.status = 'pending'
                  AND (targets.segment_id IS NOT NULL OR jobs.source_fingerprint IS NULL)
                  AND NOT EXISTS (
                      SELECT 1
                      FROM extraction_jobs AS running
                      WHERE running.segment_id = jobs.segment_id
                        AND running.status = 'running'
                  )
                ORDER BY targets.updated_at, jobs.id
                LIMIT 1
                FOR UPDATE OF jobs
                """
            )
            pending = await cursor.fetchone()
            if pending is None or not pending["ready"]:
                return None
            payload = pending["payload"]
            if payload is None:
                await connection.execute(
                    """
                    UPDATE extraction_jobs
                    SET status = 'failed', attempts = attempts + 1, lease_id = NULL,
                        error = 'invalid persisted payload: payload is null', finished_at = now()
                    WHERE id = %s AND status = 'pending'
                    """,
                    (pending["id"],),
                )
                return None
            if isinstance(payload, str):
                payload = json.loads(payload)
            try:
                request = SegmentCreate.model_validate(payload)
            except ValidationError as exc:
                await connection.execute(
                    """
                    UPDATE extraction_jobs
                    SET status = 'failed', attempts = attempts + 1, lease_id = NULL,
                        error = %s, finished_at = now()
                    WHERE id = %s AND status = 'pending'
                    """,
                    (f"invalid persisted payload: {exc}"[:4000], pending["id"]),
                )
                return None
            if (
                request.session_id != pending["session_id"]
                or request.start_user_message_id != pending["start_user_message_id"]
                or request.end_user_message_id != pending["end_user_message_id"]
                or request.projection_version != pending["projection_version"]
                or segment_id_for(request.session_id, request.start_user_message_id)
                != pending["segment_id"]
                or source_fingerprint(request) != pending["source_fingerprint"]
            ):
                await connection.execute(
                    """
                    UPDATE extraction_jobs
                    SET status = 'failed', attempts = attempts + 1, lease_id = NULL,
                        error = 'invalid persisted payload: source identity mismatch',
                        finished_at = now()
                    WHERE id = %s AND status = 'pending'
                    """,
                    (pending["id"],),
                )
                return None
            lease_id = uuid4()
            claimed_cursor = await connection.execute(
                """
                UPDATE extraction_jobs
                SET status = 'running', attempts = attempts + 1, lease_id = %s,
                    started_at = now(), finished_at = NULL, error = NULL
                WHERE id = %s AND status = 'pending'
                RETURNING attempts
                """,
                (lease_id, pending["id"]),
            )
            claimed = await claimed_cursor.fetchone()
            if claimed is None:
                raise RuntimeError("claimed job disappeared")
        return ClaimedJob(
            id=pending["id"],
            segment_id=pending["segment_id"],
            lease_id=lease_id,
            source_generation=pending["source_generation"],
            source_fingerprint=pending["source_fingerprint"],
            attempts=claimed["attempts"],
            request=request,
        )

    async def finish_failed_attempt(
        self,
        job: ClaimedJob,
        error: str,
        *,
        retry_after_seconds: float | None,
    ) -> bool:
        if retry_after_seconds is None:
            status = "failed"
            next_attempt_at = datetime.now(UTC)
            finished_at: datetime | None = datetime.now(UTC)
        else:
            status = "pending"
            next_attempt_at = datetime.now(UTC) + timedelta(seconds=retry_after_seconds)
            finished_at = None
        async with self.pool.connection() as connection, connection.transaction():
            await self._lock_segment(connection, job.segment_id)
            job_cursor = await connection.execute(
                """
                SELECT status, lease_id, source_generation, source_fingerprint
                FROM extraction_jobs
                WHERE id = %s
                FOR UPDATE
                """,
                (job.id,),
            )
            current = await job_cursor.fetchone()
            if (
                current is None
                or current["status"] != "running"
                or current["lease_id"] != job.lease_id
            ):
                return False
            target_cursor = await connection.execute(
                """
                SELECT job_id, projection_version, payload, source_generation,
                       source_fingerprint
                FROM segment_targets
                WHERE segment_id = %s
                FOR UPDATE
                """,
                (job.segment_id,),
            )
            target = await target_cursor.fetchone()
            target_matches = target is not None and (
                target["job_id"] == job.id
                and target["projection_version"] == job.request.projection_version
                and target["source_generation"] == job.source_generation
                and target["source_fingerprint"] == job.source_fingerprint
            )
            if not target_matches:
                await self._requeue_latest_target(connection, job, target)
                return True

            cursor = await connection.execute(
                """
                UPDATE extraction_jobs
                SET status = %s, lease_id = NULL, error = %s, started_at = NULL,
                    finished_at = %s, next_attempt_at = %s
                WHERE id = %s AND status = 'running' AND lease_id = %s
                """,
                (
                    status,
                    error[:4000],
                    finished_at,
                    next_attempt_at,
                    job.id,
                    job.lease_id,
                ),
            )
            if cursor.rowcount == 1 and retry_after_seconds is None:
                await connection.execute(
                    """
                    DELETE FROM segment_targets t
                    USING segments s
                    WHERE t.segment_id = %s
                      AND s.id = t.segment_id
                      AND s.source_fingerprint = t.source_fingerprint
                      AND s.end_user_message_id = t.end_user_message_id
                      AND s.projection_version >= t.projection_version
                      AND s.projection_commit_fingerprint = reflection_projection_fingerprint(
                          s.id,
                          s.end_user_message_id,
                          s.summary,
                          s.projection_version
                      )
                    """,
                    (job.segment_id,),
                )
        return cursor.rowcount == 1

    async def _requeue_latest_target(
        self,
        connection: AsyncConnection[Any],
        job: ClaimedJob,
        target: dict[str, Any] | None,
    ) -> None:
        if target is None:
            cursor = await connection.execute(
                """
                UPDATE extraction_jobs
                SET status = 'superseded', lease_id = NULL, payload = NULL,
                    started_at = NULL, finished_at = now(),
                    error = 'snapshot was superseded'
                WHERE id = %s AND status = 'running' AND lease_id = %s
                """,
                (job.id, job.lease_id),
            )
            if cursor.rowcount != 1:
                raise RuntimeError("job lease changed while superseding extraction")
            return

        if target["job_id"] == job.id:
            cursor = await connection.execute(
                """
                UPDATE extraction_jobs
                SET projection_version = %s, payload = %s, source_generation = %s,
                    source_fingerprint = %s, status = 'pending', attempts = 0,
                    lease_id = NULL, error = NULL, started_at = NULL,
                    finished_at = NULL, next_attempt_at = now()
                WHERE id = %s AND status = 'running' AND lease_id = %s
                """,
                (
                    target["projection_version"],
                    Jsonb(target["payload"]),
                    target["source_generation"],
                    target["source_fingerprint"],
                    job.id,
                    job.lease_id,
                ),
            )
            if cursor.rowcount != 1:
                raise RuntimeError("job lease changed while requeueing latest target")
            return

        cursor = await connection.execute(
            """
            UPDATE extraction_jobs
            SET status = 'superseded', lease_id = NULL, payload = NULL,
                error = 'snapshot was superseded', started_at = NULL,
                finished_at = now()
            WHERE id = %s AND status = 'running' AND lease_id = %s
            """,
            (job.id, job.lease_id),
        )
        if cursor.rowcount != 1:
            raise RuntimeError("job lease changed while superseding extraction")
        await connection.execute(
            """
            UPDATE extraction_jobs
            SET projection_version = %s, payload = %s, source_generation = %s,
                source_fingerprint = %s, status = 'pending', attempts = 0,
                lease_id = NULL, error = NULL, started_at = NULL,
                finished_at = NULL, next_attempt_at = now()
            WHERE id = %s AND status <> 'running'
            """,
            (
                target["projection_version"],
                Jsonb(target["payload"]),
                target["source_generation"],
                target["source_fingerprint"],
                target["job_id"],
            ),
        )

    async def prior_summaries(self, session_id: str, current_segment_id: UUID) -> list[str]:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                f"""
                SELECT s.summary
                FROM segments AS s
                LEFT JOIN segment_targets AS t ON t.segment_id = s.id
                WHERE s.session_id = %s
                  AND s.id <> %s
                  AND {_SEGMENT_ELIGIBILITY_SQL}
                ORDER BY s.created_at, s.id
                """,
                (session_id, current_segment_id),
            )
            rows = await cursor.fetchall()
        return [row["summary"] for row in rows]

    async def entity_candidates(
        self, mention: str, embedding: Sequence[float]
    ) -> tuple[EntityCandidate, ...]:
        query_vector = Vector(list(embedding))
        async with self.pool.connection() as connection:
            trigram_cursor = await connection.execute(
                """
                WITH matches AS (
                    SELECT id AS entity_id, similarity(canonical_name, %s) AS match_score
                    FROM entities
                    WHERE canonical_name %% %s
                    UNION ALL
                    SELECT entity_id, similarity(alias, %s) AS match_score
                    FROM entity_aliases
                    WHERE alias %% %s
                ), ranked AS (
                    SELECT entity_id, MAX(match_score) AS match_score
                    FROM matches
                    GROUP BY entity_id
                    ORDER BY match_score DESC
                    LIMIT 5
                )
                SELECT e.id, e.canonical_name, e.description,
                       ARRAY(
                           SELECT a.alias FROM entity_aliases a
                           WHERE a.entity_id = e.id ORDER BY a.normalized_alias
                       ) AS aliases
                FROM ranked r
                JOIN entities e ON e.id = r.entity_id
                ORDER BY r.match_score DESC
                """,
                (mention, mention, mention, mention),
            )
            trigram_rows = await trigram_cursor.fetchall()
            vector_cursor = await connection.execute(
                """
                WITH nearest AS (
                    SELECT id, canonical_name, description, embedding <=> %s AS distance
                    FROM entities
                    ORDER BY embedding <=> %s
                    LIMIT 5
                )
                SELECT n.id, n.canonical_name, n.description,
                       ARRAY(
                           SELECT a.alias FROM entity_aliases a
                           WHERE a.entity_id = n.id ORDER BY a.normalized_alias
                       ) AS aliases
                FROM nearest n
                ORDER BY n.distance
                """,
                (query_vector, query_vector),
            )
            vector_rows = await vector_cursor.fetchall()

        def convert(rows: Sequence[dict[str, Any]]) -> list[EntityCandidate]:
            return [
                EntityCandidate(
                    id=row["id"],
                    canonical_name=row["canonical_name"],
                    description=row["description"],
                    aliases=tuple(row["aliases"]),
                )
                for row in rows
            ]

        return union_candidates(convert(trigram_rows), convert(vector_rows))

    async def commit_extraction(self, job: ClaimedJob, prepared: PreparedSegment) -> bool:
        if (
            prepared.id != job.segment_id
            or prepared.session_id != job.request.session_id
            or prepared.start_user_message_id != job.request.start_user_message_id
            or prepared.end_user_message_id != job.request.end_user_message_id
            or prepared.projection_version != job.request.projection_version
        ):
            raise RuntimeError("prepared extraction does not match its claimed source")
        async with self.pool.connection() as connection, connection.transaction():
            await self._lock_segment(connection, job.segment_id)
            job_cursor = await connection.execute(
                """
                SELECT status, lease_id, source_generation, source_fingerprint
                FROM extraction_jobs
                WHERE id = %s
                FOR UPDATE
                """,
                (job.id,),
            )
            current_job = await job_cursor.fetchone()
            if (
                current_job is None
                or current_job["status"] != "running"
                or current_job["lease_id"] != job.lease_id
            ):
                raise RuntimeError("job lease changed before extraction committed")
            target_cursor = await connection.execute(
                """
                SELECT job_id, projection_version, payload, source_generation,
                       source_fingerprint
                FROM segment_targets
                WHERE segment_id = %s
                FOR UPDATE
                """,
                (job.segment_id,),
            )
            target = await target_cursor.fetchone()
            target_matches = target is not None and (
                target["job_id"] == job.id
                and target["projection_version"] == prepared.projection_version
                and target["source_generation"] == job.source_generation
                and target["source_fingerprint"] == job.source_fingerprint
                and current_job["source_generation"] == job.source_generation
                and current_job["source_fingerprint"] == job.source_fingerprint
            )
            if not target_matches:
                await self._requeue_latest_target(connection, job, target)
                return False
            version_cursor = await connection.execute(
                "SELECT projection_version FROM segments WHERE id = %s FOR UPDATE",
                (prepared.id,),
            )
            existing = await version_cursor.fetchone()
            if (
                existing is not None
                and existing["projection_version"] > prepared.projection_version
            ):
                cursor = await connection.execute(
                    """
                    UPDATE extraction_jobs
                    SET status = 'succeeded', lease_id = NULL, payload = NULL,
                        error = NULL, finished_at = now()
                    WHERE id = %s AND status = 'running' AND lease_id = %s
                    """,
                    (job.id, job.lease_id),
                )
                if cursor.rowcount != 1:
                    raise RuntimeError("job lease changed before extraction committed")
                await connection.execute(
                    """
                    DELETE FROM segment_targets
                    WHERE segment_id = %s AND job_id = %s AND source_generation = %s
                    """,
                    (job.segment_id, job.id, job.source_generation),
                )
                return True
            old_entity_cursor = await connection.execute(
                """
                SELECT subject_entity_id AS id
                FROM claims
                WHERE segment_id = %s
                UNION
                SELECT object_entity_id AS id
                FROM claims
                WHERE segment_id = %s AND object_entity_id IS NOT NULL
                """,
                (prepared.id, prepared.id),
            )
            old_entity_ids = [row["id"] for row in await old_entity_cursor.fetchall()]
            new_entities = [entity for entity in prepared.entities if entity.is_new]
            if new_entities:
                await connection.cursor().executemany(
                    """
                    INSERT INTO entities (
                        id, canonical_name, normalized_name, description, embedding
                    )
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE
                    SET canonical_name = EXCLUDED.canonical_name,
                        normalized_name = EXCLUDED.normalized_name,
                        description = EXCLUDED.description,
                        embedding = EXCLUDED.embedding,
                        updated_at = now()
                    """,
                    [
                        (
                            entity.id,
                            entity.canonical_name,
                            entity.normalized_name,
                            entity.description,
                            Vector(list(entity.embedding))
                            if entity.embedding is not None
                            else None,
                        )
                        for entity in new_entities
                    ],
                )
            aliases = [
                (entity.id, alias, normalize_name(alias))
                for entity in prepared.entities
                for alias in entity.aliases
            ]
            if aliases:
                await connection.cursor().executemany(
                    """
                    INSERT INTO entity_aliases (entity_id, alias, normalized_alias)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (entity_id, normalized_alias) DO UPDATE
                    SET alias = EXCLUDED.alias
                    """,
                    aliases,
                )
            await connection.execute(
                """
                INSERT INTO segments (
                    id, session_id, start_user_message_id, end_user_message_id, summary,
                    projection_version, projection_commit_fingerprint,
                    source_generation, source_fingerprint
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE
                SET end_user_message_id = EXCLUDED.end_user_message_id,
                    summary = EXCLUDED.summary,
                    projection_version = EXCLUDED.projection_version,
                    projection_commit_fingerprint = EXCLUDED.projection_commit_fingerprint,
                    source_generation = EXCLUDED.source_generation,
                    source_fingerprint = EXCLUDED.source_fingerprint,
                    updated_at = now()
                """,
                (
                    prepared.id,
                    prepared.session_id,
                    prepared.start_user_message_id,
                    prepared.end_user_message_id,
                    prepared.summary,
                    prepared.projection_version,
                    projection_fingerprint(
                        prepared.id,
                        prepared.end_user_message_id,
                        prepared.summary,
                        prepared.projection_version,
                    ),
                    job.source_generation,
                    job.source_fingerprint,
                ),
            )
            await connection.execute("DELETE FROM claims WHERE segment_id = %s", (prepared.id,))
            if prepared.claims:
                await connection.cursor().executemany(
                    """
                    INSERT INTO claims (
                        id, segment_id, subject_text, subject_entity_id, predicate,
                        confidence,
                        object_entity_text, object_entity_id, object_value,
                        equivalence_key, embedding
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    [
                        (
                            claim.id,
                            prepared.id,
                            claim.subject,
                            claim.subject_entity_id,
                            claim.predicate,
                            claim.confidence,
                            claim.object_entity,
                            claim.object_entity_id,
                            claim.object_value,
                            claim.equivalence_key,
                            Vector(list(claim.embedding)),
                        )
                        for claim in prepared.claims
                    ],
                )
            if old_entity_ids:
                await connection.execute(
                    """
                    DELETE FROM entities e
                    WHERE e.id = ANY(%s)
                      AND NOT EXISTS (
                          SELECT 1
                          FROM claims c
                          WHERE c.subject_entity_id = e.id OR c.object_entity_id = e.id
                      )
                    """,
                    (old_entity_ids,),
                )
            cursor = await connection.execute(
                """
                UPDATE extraction_jobs
                SET status = 'succeeded', lease_id = NULL, payload = NULL,
                    error = NULL, finished_at = now()
                WHERE id = %s AND status = 'running' AND lease_id = %s
                  AND source_generation = %s AND source_fingerprint = %s
                """,
                (job.id, job.lease_id, job.source_generation, job.source_fingerprint),
            )
            if cursor.rowcount != 1:
                raise RuntimeError("job lease changed before extraction committed")
            deleted = await connection.execute(
                """
                DELETE FROM segment_targets
                WHERE segment_id = %s AND job_id = %s AND source_generation = %s
                  AND source_fingerprint = %s
                """,
                (job.segment_id, job.id, job.source_generation, job.source_fingerprint),
            )
            if deleted.rowcount != 1:
                raise RuntimeError("latest target changed before extraction committed")
        return True

    async def get_segment(self, segment_id: UUID) -> SegmentResponse | None:
        async with self.pool.connection() as connection:
            segment_cursor = await connection.execute(
                """
                SELECT id, session_id, start_user_message_id, end_user_message_id, summary,
                       created_at, updated_at
                FROM segments
                WHERE id = %s
                """,
                (segment_id,),
            )
            segment = await segment_cursor.fetchone()
            if segment is None:
                return None
            claim_cursor = await connection.execute(
                """
                SELECT subject_text AS subject, subject_entity_id, predicate, confidence,
                       object_entity_text AS object_entity, object_entity_id, object_value
                FROM claims
                WHERE segment_id = %s
                ORDER BY id
                """,
                (segment_id,),
            )
            claims = await claim_cursor.fetchall()
        return SegmentResponse.model_validate({**segment, "claims": claims})

    async def segment_summaries(self, session_id: str) -> list[SegmentSummary]:
        summaries, _, _ = await self.session_segment_listing(session_id)
        return summaries

    async def session_segment_listing(
        self, session_id: str
    ) -> tuple[list[SegmentSummary], list[SegmentBoundary], list[SegmentTargetBoundary]]:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                f"""
                WITH committed AS (
                    SELECT 'committed' AS row_kind, s.id,
                           s.start_user_message_id, s.end_user_message_id,
                           s.projection_version,
                           COALESCE(({_SEGMENT_ELIGIBILITY_SQL}), FALSE) AS source_eligible,
                           s.source_fingerprint,
                           CASE
                               WHEN {_SEGMENT_ELIGIBILITY_SQL} THEN s.summary
                               ELSE NULL
                           END AS eligible_summary,
                           NULL::text AS status,
                           s.created_at AS ordered_at
                    FROM segments s
                    LEFT JOIN segment_targets t ON t.segment_id = s.id
                    WHERE s.session_id = %s
                ), desired AS (
                    SELECT 'target' AS row_kind, t.segment_id AS id,
                           t.payload->>'start_user_message_id' AS start_user_message_id,
                           t.end_user_message_id, t.projection_version,
                           FALSE AS source_eligible,
                           t.source_fingerprint,
                           NULL::text AS eligible_summary,
                           j.status::text AS status,
                           t.updated_at AS ordered_at
                    FROM segment_targets t
                    JOIN extraction_jobs j ON j.id = t.job_id
                    WHERE t.payload->>'session_id' = %s
                )
                SELECT * FROM committed
                UNION ALL
                SELECT * FROM desired
                ORDER BY ordered_at, id, row_kind
                """,
                (session_id, session_id),
            )
            rows = await cursor.fetchall()
        summaries = [
            SegmentSummary.model_validate(
                {
                    "id": row["id"],
                    "start_user_message_id": row["start_user_message_id"],
                    "end_user_message_id": row["end_user_message_id"],
                    "projection_version": row["projection_version"],
                    "summary": row["eligible_summary"],
                }
            )
            for row in rows
            if row["row_kind"] == "committed" and row["source_eligible"]
        ]
        boundaries = [
            SegmentBoundary.model_validate(
                {
                    "id": row["id"],
                    "start_user_message_id": row["start_user_message_id"],
                    "end_user_message_id": row["end_user_message_id"],
                    "projection_version": row["projection_version"],
                    "source_eligible": row["source_eligible"],
                    "source_fingerprint": row["source_fingerprint"],
                }
            )
            for row in rows
            if row["row_kind"] == "committed"
        ]
        targets = [
            SegmentTargetBoundary.model_validate(
                {
                    "id": row["id"],
                    "start_user_message_id": row["start_user_message_id"],
                    "end_user_message_id": row["end_user_message_id"],
                    "projection_version": row["projection_version"],
                    "status": row["status"],
                    "source_fingerprint": row["source_fingerprint"],
                }
            )
            for row in rows
            if row["row_kind"] == "target"
        ]
        return summaries, boundaries, targets

    async def direct_claims(
        self, embedding: Sequence[float], limit: int = 10
    ) -> list[RecallCandidate]:
        query_vector = Vector(list(embedding))
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                """
                SELECT subject_text, subject_entity_id, predicate, confidence,
                       object_entity_text, object_entity_id, object_value,
                       equivalence_key, segment_id, 1 - (embedding <=> %s) AS similarity
                FROM claims
                ORDER BY embedding <=> %s
                LIMIT %s
                """,
                (query_vector, query_vector, limit),
            )
            rows = await cursor.fetchall()
        return [self._recall_candidate(row, is_direct=True) for row in rows]

    async def neighboring_claims(
        self,
        entity_id: UUID,
        embedding: Sequence[float],
        seed_similarity: float,
        limit: int = 10,
    ) -> list[RecallCandidate]:
        query_vector = Vector(list(embedding))
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                """
                SELECT subject_text, subject_entity_id, predicate, confidence,
                       object_entity_text, object_entity_id, object_value,
                       equivalence_key, segment_id,
                       1 - (embedding <=> %s) AS similarity
                FROM claims
                WHERE subject_entity_id = %s OR object_entity_id = %s
                ORDER BY embedding <=> %s
                LIMIT %s
                """,
                (query_vector, entity_id, entity_id, query_vector, limit),
            )
            rows = await cursor.fetchall()
        return [
            self._recall_candidate({**row, "seed_similarity": seed_similarity}, is_direct=False)
            for row in rows
        ]

    async def support_for_equivalence_keys(self, keys: Sequence[str]) -> dict[str, ClaimSupport]:
        if not keys:
            return {}
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                """
                SELECT c.equivalence_key,
                       array_agg(DISTINCT c.segment_id ORDER BY c.segment_id) AS segment_ids,
                       count(DISTINCT c.segment_id) AS support_count,
                       count(DISTINCT s.session_id) AS session_count
                FROM claims c
                JOIN segments s ON s.id = c.segment_id
                WHERE c.equivalence_key = ANY(%s)
                GROUP BY c.equivalence_key
                """,
                (list(keys),),
            )
            rows = await cursor.fetchall()
        return {
            row["equivalence_key"]: ClaimSupport(
                segment_ids=list(row["segment_ids"]),
                support_count=row["support_count"],
                session_count=row["session_count"],
            )
            for row in rows
        }

    @staticmethod
    async def _job_row(connection: AsyncConnection[Any], job_id: int) -> dict[str, Any] | None:
        cursor = await connection.execute(
            """
            SELECT id, segment_id, status, attempts, error, created_at, started_at, finished_at,
                   next_attempt_at, projection_version
            FROM extraction_jobs
            WHERE id = %s
            """,
            (job_id,),
        )
        return await cursor.fetchone()

    @staticmethod
    def _job_response(row: dict[str, Any]) -> JobResponse:
        return JobResponse.model_validate(row)

    @staticmethod
    def _recall_candidate(row: dict[str, Any], *, is_direct: bool) -> RecallCandidate:
        return RecallCandidate(
            subject=row["subject_text"],
            subject_entity_id=row["subject_entity_id"],
            predicate=row["predicate"],
            confidence=float(row["confidence"]),
            object_entity=row["object_entity_text"],
            object_entity_id=row["object_entity_id"],
            object_value=row["object_value"],
            equivalence_key=row["equivalence_key"],
            segment_id=row["segment_id"],
            similarity=float(row["similarity"]),
            seed_similarity=(
                float(row["seed_similarity"]) if row.get("seed_similarity") is not None else None
            ),
            is_direct=is_direct,
        )
