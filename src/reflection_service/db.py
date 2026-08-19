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
    union_candidates,
)
from reflection_service.models import (
    PROJECTION_SAFE_VERSION,
    JobResponse,
    SegmentCreate,
    SegmentResponse,
    SegmentSummary,
)


class JobNotRetryableError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ClaimedJob:
    id: int
    segment_id: UUID
    lease_id: UUID
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

    async def enqueue(self, request: SegmentCreate) -> JobResponse:
        segment_id = segment_id_for(request.session_id, request.start_user_message_id)
        async with self.pool.connection() as connection, connection.transaction():
            cursor = await connection.execute(
                """
                INSERT INTO extraction_jobs (
                    segment_id, session_id, start_user_message_id, end_user_message_id,
                    projection_version, payload
                )
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (session_id, start_user_message_id, end_user_message_id)
                DO UPDATE SET session_id = EXCLUDED.session_id
                RETURNING id, segment_id, projection_version, status, attempts, error,
                          created_at, started_at, finished_at, next_attempt_at
                """,
                (
                    segment_id,
                    request.session_id,
                    request.start_user_message_id,
                    request.end_user_message_id,
                    request.projection_version,
                    Jsonb(request.model_dump(mode="json")),
                ),
            )
            row = await cursor.fetchone()
            if row is None:
                raise RuntimeError("job insert did not return a row")
            jobs_cursor = await connection.execute(
                """
                SELECT id, status, projection_version
                FROM extraction_jobs
                WHERE segment_id = %s
                FOR UPDATE
                """,
                (segment_id,),
            )
            jobs = await jobs_cursor.fetchall()
            state = next((item for item in jobs if item["id"] == row["id"]), None)
            if state is None:
                raise RuntimeError("job state disappeared during enqueue")
            segment_cursor = await connection.execute(
                """
                SELECT s.end_user_message_id, s.projection_version,
                       s.projection_commit_fingerprint = reflection_projection_fingerprint(
                           s.id,
                           s.end_user_message_id,
                           s.summary,
                           s.projection_version
                       ) AS projection_safe
                FROM segments s
                WHERE s.id = %s
                """,
                (segment_id,),
            )
            current_segment = await segment_cursor.fetchone()
            await connection.execute(
                """
                INSERT INTO segment_targets (
                    segment_id, job_id, end_user_message_id, projection_version, payload
                )
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (segment_id) DO UPDATE
                SET job_id = EXCLUDED.job_id,
                    end_user_message_id = EXCLUDED.end_user_message_id,
                    projection_version = EXCLUDED.projection_version,
                    payload = EXCLUDED.payload,
                    updated_at = now()
                """,
                (
                    segment_id,
                    row["id"],
                    request.end_user_message_id,
                    request.projection_version,
                    Jsonb(request.model_dump(mode="json")),
                ),
            )
            superseded_ids = [
                item["id"]
                for item in jobs
                if item["id"] > row["id"] and item["status"] in {"pending", "failed"}
            ]
            if superseded_ids:
                await connection.execute(
                    "DELETE FROM extraction_jobs WHERE id = ANY(%s)",
                    (superseded_ids,),
                )
            other_running = any(
                item["id"] != row["id"] and item["status"] == "running" for item in jobs
            )
            current_matches = (
                current_segment is not None
                and current_segment["end_user_message_id"] == request.end_user_message_id
                and current_segment["projection_version"] == request.projection_version
                and (
                    request.projection_version < PROJECTION_SAFE_VERSION
                    or current_segment["projection_safe"]
                )
            )
            lower_version = request.projection_version < state["projection_version"] or (
                current_segment is not None
                and request.projection_version < current_segment["projection_version"]
            )
            can_queue = state["status"] != "running" and not other_running
            settled = current_matches and state["status"] != "running" and not other_running
            if lower_version or settled:
                await connection.execute(
                    "DELETE FROM segment_targets WHERE segment_id = %s",
                    (segment_id,),
                )
            elif can_queue:
                await connection.execute(
                    """
                    UPDATE extraction_jobs
                    SET projection_version = %s, payload = %s, status = 'pending',
                        attempts = 0, lease_id = NULL, error = NULL, started_at = NULL,
                        finished_at = NULL, next_attempt_at = now()
                    WHERE id = %s
                    """,
                    (
                        request.projection_version,
                        Jsonb(request.model_dump(mode="json")),
                        row["id"],
                    ),
                )
                row = await self._job_row(connection, row["id"])
                if row is None:
                    raise RuntimeError("requeued job disappeared during enqueue")
        return self._job_response(row)

    async def get_job(self, job_id: int) -> JobResponse | None:
        async with self.pool.connection() as connection:
            row = await self._job_row(connection, job_id)
        return self._job_response(row) if row is not None else None

    async def retry_failed_job(self, job_id: int) -> JobResponse | None:
        async with self.pool.connection() as connection, connection.transaction():
            target_cursor = await connection.execute(
                """
                SELECT id, segment_id, status, lease_id
                FROM extraction_jobs
                WHERE id = %s
                FOR UPDATE
                """,
                (job_id,),
            )
            target = await target_cursor.fetchone()
            if target is None:
                return None
            if target["status"] != "failed" or target["lease_id"] is not None:
                raise JobNotRetryableError("only terminal failed jobs can be retried")
            newer_cursor = await connection.execute(
                """
                SELECT 1
                FROM extraction_jobs
                WHERE segment_id = %s AND id > %s
                LIMIT 1
                """,
                (target["segment_id"], target["id"]),
            )
            if await newer_cursor.fetchone() is not None:
                raise JobNotRetryableError(
                    "job cannot be retried because a newer snapshot exists for the segment"
                )
            cursor = await connection.execute(
                """
                UPDATE extraction_jobs
                SET status = 'pending', attempts = 0, error = NULL, lease_id = NULL,
                    started_at = NULL, finished_at = NULL, next_attempt_at = now()
                WHERE id = %s AND status = 'failed' AND lease_id IS NULL
                RETURNING id, segment_id, projection_version, status, attempts, error,
                          created_at, started_at, finished_at, next_attempt_at
                """,
                (job_id,),
            )
            row = await cursor.fetchone()
            if row is None:
                raise RuntimeError("failed job changed while retrying")
            return self._job_response(row)

    async def recover_running_jobs(self, connection: AsyncConnection[Any]) -> int:
        cursor = await connection.execute(
            """
            UPDATE extraction_jobs
            SET status = 'pending', lease_id = NULL, started_at = NULL,
                next_attempt_at = now(), error = 'worker stopped before completing the job'
            WHERE status = 'running'
            """
        )
        return cursor.rowcount

    async def claim_oldest_job(self, connection: AsyncConnection[Any]) -> ClaimedJob | None:
        async with connection.transaction():
            cursor = await connection.execute(
                """
                SELECT id, segment_id, payload, next_attempt_at <= now() AS ready
                FROM extraction_jobs
                WHERE status = 'pending'
                ORDER BY id
                LIMIT 1
                FOR UPDATE
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
                      AND s.end_user_message_id = t.end_user_message_id
                      AND s.projection_version = t.projection_version
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

    async def prior_summaries(self, session_id: str, current_segment_id: UUID) -> list[str]:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                """
                SELECT summary
                FROM segments
                WHERE session_id = %s AND id <> %s
                ORDER BY created_at, id
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
        async with self.pool.connection() as connection, connection.transaction():
            version_cursor = await connection.execute(
                "SELECT projection_version FROM segments WHERE id = %s FOR UPDATE",
                (prepared.id,),
            )
            existing = await version_cursor.fetchone()
            if (
                existing is not None
                and existing["projection_version"] > prepared.projection_version
            ):
                await self._finish_or_requeue_target(connection, job, prepared)
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
                    projection_version, projection_commit_fingerprint
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE
                SET end_user_message_id = EXCLUDED.end_user_message_id,
                    summary = EXCLUDED.summary,
                    projection_version = EXCLUDED.projection_version,
                    projection_commit_fingerprint = EXCLUDED.projection_commit_fingerprint,
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
            await self._finish_or_requeue_target(connection, job, prepared)
        return True

    async def _finish_or_requeue_target(
        self,
        connection: AsyncConnection[Any],
        job: ClaimedJob,
        prepared: PreparedSegment,
    ) -> None:
        target_cursor = await connection.execute(
            """
            SELECT job_id, end_user_message_id, projection_version, payload
            FROM segment_targets
            WHERE segment_id = %s
            FOR UPDATE
            """,
            (prepared.id,),
        )
        target = await target_cursor.fetchone()
        target_matches = target is not None and (
            target["end_user_message_id"] == prepared.end_user_message_id
            and target["projection_version"] == prepared.projection_version
        )
        if target is None or target_matches:
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
            if target_matches:
                await connection.execute(
                    "DELETE FROM segment_targets WHERE segment_id = %s",
                    (prepared.id,),
                )
            return

        if target["job_id"] != job.id:
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

        cursor = await connection.execute(
            """
            UPDATE extraction_jobs
            SET projection_version = %s, payload = %s, status = 'pending',
                attempts = 0, lease_id = NULL, error = NULL, started_at = NULL,
                finished_at = NULL, next_attempt_at = now()
            WHERE id = %s AND status <> 'running'
            """
            if target["job_id"] != job.id
            else """
            UPDATE extraction_jobs
            SET projection_version = %s, payload = %s, status = 'pending',
                attempts = 0, lease_id = NULL, error = NULL, started_at = NULL,
                finished_at = NULL, next_attempt_at = now()
            WHERE id = %s AND status = 'running' AND lease_id = %s
            """,
            (
                target["projection_version"],
                Jsonb(target["payload"]),
                target["job_id"],
                *(() if target["job_id"] != job.id else (job.lease_id,)),
            ),
        )
        if cursor.rowcount != 1:
            raise RuntimeError("target job could not be requeued")

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
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                """
                SELECT s.id, s.start_user_message_id, s.end_user_message_id,
                       s.projection_version, s.summary
                FROM segments s
                WHERE s.session_id = %s
                  AND s.projection_commit_fingerprint = reflection_projection_fingerprint(
                      s.id,
                      s.end_user_message_id,
                      s.summary,
                      s.projection_version
                  )
                ORDER BY s.created_at, s.id
                """,
                (session_id,),
            )
            rows = await cursor.fetchall()
        return [SegmentSummary.model_validate(row) for row in rows]

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
