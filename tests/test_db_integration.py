import os
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from psycopg import AsyncConnection
from psycopg.rows import dict_row

from reflection_service.config import Settings
from reflection_service.db import ClaimedJob, Database, JobNotRetryableError
from reflection_service.domain import (
    PreparedClaim,
    PreparedEntity,
    PreparedSegment,
    equivalence_key,
)
from reflection_service.models import JobStatus, SegmentCreate

EMBEDDING = (0.01,) * 1024
OPPOSITE_EMBEDDING = (-0.01,) * 1024


def prepared_segment(
    claimed: ClaimedJob,
    *,
    end_id: str,
    summary: str,
    subject_id: UUID,
    object_id: UUID,
    entities_are_new: bool,
) -> PreparedSegment:
    return PreparedSegment(
        id=claimed.segment_id,
        session_id=claimed.request.session_id,
        start_user_message_id=claimed.request.start_user_message_id,
        end_user_message_id=end_id,
        summary=summary,
        entities=(
            PreparedEntity(
                id=subject_id,
                canonical_name="Reflection",
                normalized_name="reflection",
                description="A memory extraction service",
                aliases=("Reflection",),
                embedding=EMBEDDING if entities_are_new else None,
                is_new=entities_are_new,
            ),
            PreparedEntity(
                id=object_id,
                canonical_name="PostgreSQL",
                normalized_name="postgresql",
                description="A relational database",
                aliases=("Postgres",),
                embedding=EMBEDDING if entities_are_new else None,
                is_new=entities_are_new,
            ),
        ),
        claims=(
            PreparedClaim(
                id=uuid4(),
                subject="Reflection",
                subject_entity_id=subject_id,
                predicate="uses",
                confidence=0.9,
                object_entity="PostgreSQL",
                object_entity_id=object_id,
                object_value=None,
                equivalence_key=equivalence_key(
                    subject_id,
                    "uses",
                    object_entity_id=object_id,
                    object_value=None,
                ),
                embedding=EMBEDDING,
            ),
            PreparedClaim(
                id=uuid4(),
                subject="Reflection",
                subject_entity_id=subject_id,
                predicate="has timeout",
                confidence=0.4,
                object_entity=None,
                object_entity_id=None,
                object_value="120 seconds",
                equivalence_key=equivalence_key(
                    subject_id,
                    "has timeout",
                    object_entity_id=None,
                    object_value="120 seconds",
                ),
                embedding=OPPOSITE_EMBEDDING,
            ),
        ),
        projection_version=claimed.request.projection_version,
    )


@pytest.mark.integration
@pytest.mark.asyncio
async def test_queue_fencing_replacement_retry_and_recall() -> None:
    database_url = os.getenv("REFLECTION_TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("REFLECTION_TEST_DATABASE_URL is not set")
    configured = Settings(
        database_url=database_url,
        reflection_api_key="test",
        openrouter_api_key="test",
        voyage_api_key="test",
        migrations_dir=Path(__file__).parents[1] / "migrations",
    )
    database = Database(configured)
    await database.open()
    try:
        async with database.pool.connection() as connection:
            await connection.execute(
                "TRUNCATE segment_targets, claims, entity_aliases, entities, segments, "
                "extraction_jobs "
                "RESTART IDENTITY CASCADE"
            )
        request = SegmentCreate(
            session_id="session",
            start_user_message_id="start",
            end_user_message_id="end-1",
            projection_version=1,
            messages=[{"role": "user", "text": "hello"}],
        )

        first = await database.enqueue(request)
        duplicate = await database.enqueue(
            request.model_copy(update={"messages": request.messages})
        )
        tail = await database.enqueue(request.model_copy(update={"end_user_message_id": "end-2"}))

        assert duplicate.id == first.id
        assert tail.id != first.id
        assert tail.segment_id == first.segment_id

        async with database.pool.connection() as connection:
            stale_claim = await database.claim_oldest_job(connection)
            assert stale_claim is not None
            assert await database.recover_running_jobs(connection) == 1
            current_claim = await database.claim_oldest_job(connection)
        assert current_claim is not None
        assert current_claim.id == first.id
        assert current_claim.lease_id != stale_claim.lease_id
        assert not await database.finish_failed_attempt(
            stale_claim, "stale failure", retry_after_seconds=0
        )

        subject_id = uuid4()
        object_id = uuid4()
        first_prepared = prepared_segment(
            current_claim,
            end_id="end-1",
            summary="First tail snapshot",
            subject_id=subject_id,
            object_id=object_id,
            entities_are_new=True,
        )
        with pytest.raises(RuntimeError, match="lease changed"):
            await database.commit_extraction(stale_claim, first_prepared)
        assert await database.get_segment(first.segment_id) is None

        await database.commit_extraction(current_claim, first_prepared)
        async with database.pool.connection() as connection:
            tail_claim = await database.claim_oldest_job(connection)
        assert tail_claim is not None
        assert tail_claim.id == tail.id
        await database.commit_extraction(
            tail_claim,
            prepared_segment(
                tail_claim,
                end_id="end-2",
                summary="Latest tail snapshot",
                subject_id=subject_id,
                object_id=object_id,
                entities_are_new=False,
            ),
        )

        segment = await database.get_segment(first.segment_id)
        candidates = await database.entity_candidates("Postgres", EMBEDDING)
        direct = await database.direct_claims(EMBEDDING)
        neighbors = await database.neighboring_claims(subject_id, EMBEDDING, seed_similarity=0.75)
        summaries = await database.prior_summaries("session", first.segment_id)
        segment_summaries = await database.segment_summaries("session")

        assert segment is not None
        assert segment.end_user_message_id == "end-2"
        assert segment.summary == "Latest tail snapshot"
        assert {claim.object_value for claim in segment.claims} == {None, "120 seconds"}
        assert {claim.confidence for claim in segment.claims} == {0.4, 0.9}
        assert object_id in {candidate.id for candidate in candidates}
        assert {candidate.description for candidate in candidates}
        assert {claim.segment_id for claim in direct} == {first.segment_id}
        assert neighbors[0].predicate == "uses"
        assert neighbors[0].similarity > neighbors[1].similarity
        assert neighbors[0].seed_similarity == 0.75
        assert summaries == []
        assert [item.id for item in segment_summaries] == [first.segment_id]
        assert segment_summaries[0].end_user_message_id == "end-2"
        assert segment_summaries[0].summary == "Latest tail snapshot"

        legacy_request = SegmentCreate(
            session_id="session",
            start_user_message_id="legacy-start",
            end_user_message_id="legacy-end",
            messages=[{"role": "user", "text": "legacy"}],
        )
        legacy_job = await database.enqueue(legacy_request)
        async with database.pool.connection() as connection:
            legacy_claim = await database.claim_oldest_job(connection)
        assert legacy_claim is not None
        await database.commit_extraction(
            legacy_claim,
            PreparedSegment(
                id=legacy_claim.segment_id,
                session_id="session",
                start_user_message_id="legacy-start",
                end_user_message_id="legacy-end",
                summary="Unsafe legacy summary",
                entities=(),
                claims=(),
            ),
        )
        mixed_summaries = await database.segment_summaries("session")
        assert {item.id for item in mixed_summaries} == {
            first.segment_id,
            legacy_job.segment_id,
        }
        assert {item.projection_version for item in mixed_summaries} == {0, 1}

        safe_job = await database.enqueue(
            legacy_request.model_copy(update={"projection_version": 1})
        )
        assert safe_job.id == legacy_job.id
        assert safe_job.status == JobStatus.PENDING
        assert {item.summary for item in await database.segment_summaries("session")} >= {
            "Unsafe legacy summary"
        }
        async with database.pool.connection() as connection:
            safe_claim = await database.claim_oldest_job(connection)
        assert safe_claim is not None
        assert await database.finish_failed_attempt(
            safe_claim,
            "terminal v1 failure",
            retry_after_seconds=None,
        )
        assert {item.summary for item in await database.segment_summaries("session")} >= {
            "Unsafe legacy summary"
        }
        safe_job = await database.enqueue(
            legacy_request.model_copy(update={"projection_version": 1})
        )
        assert safe_job.status == JobStatus.PENDING
        async with database.pool.connection() as connection:
            safe_claim = await database.claim_oldest_job(connection)
        assert safe_claim is not None
        await database.commit_extraction(
            safe_claim,
            PreparedSegment(
                id=safe_claim.segment_id,
                session_id="session",
                start_user_message_id="legacy-start",
                end_user_message_id="legacy-end",
                summary="Projection-safe summary",
                entities=(),
                claims=(),
                projection_version=1,
            ),
        )
        assert {item.summary for item in await database.segment_summaries("session")} == {
            "Latest tail snapshot",
            "Projection-safe summary",
        }
        downgrade_job = await database.enqueue(
            legacy_request.model_copy(update={"end_user_message_id": "legacy-end-2"})
        )
        async with database.pool.connection() as connection:
            downgrade_claim = await database.claim_oldest_job(connection)
        assert downgrade_claim is not None
        await database.commit_extraction(
            downgrade_claim,
            PreparedSegment(
                id=downgrade_claim.segment_id,
                session_id="session",
                start_user_message_id="legacy-start",
                end_user_message_id="legacy-end-2",
                summary="Unsafe downgrade",
                entities=(),
                claims=(),
            ),
        )
        preserved = await database.get_segment(safe_job.segment_id)
        assert preserved is not None
        assert preserved.summary == "Projection-safe summary"
        assert preserved.end_user_message_id == "legacy-end"

        forward_job = await database.enqueue(
            legacy_request.model_copy(
                update={"end_user_message_id": "legacy-end-2", "projection_version": 1}
            )
        )
        assert forward_job.id == downgrade_job.id
        assert forward_job.status == JobStatus.PENDING
        async with database.pool.connection() as connection:
            forward_claim = await database.claim_oldest_job(connection)
        assert forward_claim is not None
        await database.commit_extraction(
            forward_claim,
            PreparedSegment(
                id=forward_claim.segment_id,
                session_id="session",
                start_user_message_id="legacy-start",
                end_user_message_id="legacy-end-2",
                summary="Projection-safe forward snapshot",
                entities=(),
                claims=(),
                projection_version=1,
            ),
        )

        rewind_job = await database.enqueue(
            legacy_request.model_copy(update={"projection_version": 1})
        )
        assert rewind_job.id == safe_job.id
        assert rewind_job.status == JobStatus.PENDING
        async with database.pool.connection() as connection:
            rewind_claim = await database.claim_oldest_job(connection)
        assert rewind_claim is not None
        await database.commit_extraction(
            rewind_claim,
            PreparedSegment(
                id=rewind_claim.segment_id,
                session_id="session",
                start_user_message_id="legacy-start",
                end_user_message_id="legacy-end",
                summary="Projection-safe rewind snapshot",
                entities=(),
                claims=(),
                projection_version=1,
            ),
        )
        rewound = await database.get_segment(safe_job.segment_id)
        assert rewound is not None
        assert rewound.summary == "Projection-safe rewind snapshot"
        assert rewound.end_user_message_id == "legacy-end"

        pending_future = await database.enqueue(
            legacy_request.model_copy(
                update={"end_user_message_id": "legacy-end-3", "projection_version": 1}
            )
        )
        replay_current = await database.enqueue(
            legacy_request.model_copy(update={"projection_version": 1})
        )
        assert replay_current.status == JobStatus.SUCCEEDED
        assert await database.get_job(pending_future.id) is None

        pending_upgrade_request = SegmentCreate(
            session_id="session",
            start_user_message_id="pending-upgrade",
            end_user_message_id="pending-upgrade-end",
            messages=[{"role": "user", "text": "upgrade"}],
        )
        pending_legacy = await database.enqueue(pending_upgrade_request)
        pending_safe = await database.enqueue(
            pending_upgrade_request.model_copy(update={"projection_version": 1})
        )
        assert pending_safe.id == pending_legacy.id
        assert pending_safe.projection_version == 1
        async with database.pool.connection() as connection:
            pending_safe_claim = await database.claim_oldest_job(connection)
        assert pending_safe_claim is not None
        assert pending_safe_claim.request.projection_version == 1
        await database.commit_extraction(
            pending_safe_claim,
            PreparedSegment(
                id=pending_safe_claim.segment_id,
                session_id="session",
                start_user_message_id="pending-upgrade",
                end_user_message_id="pending-upgrade-end",
                summary="Safely upgraded while pending",
                entities=(),
                claims=(),
                projection_version=1,
            ),
        )

        support_request = SegmentCreate(
            session_id="other-session",
            start_user_message_id="support-start",
            end_user_message_id="support-end",
            messages=[{"role": "user", "text": "same claim"}],
        )
        support_job = await database.enqueue(support_request)
        async with database.pool.connection() as connection:
            support_claim = await database.claim_oldest_job(connection)
        assert support_claim is not None
        await database.commit_extraction(
            support_claim,
            prepared_segment(
                support_claim,
                end_id="support-end",
                summary="Independent support",
                subject_id=subject_id,
                object_id=object_id,
                entities_are_new=False,
            ),
        )
        uses_key = equivalence_key(
            subject_id,
            "uses",
            object_entity_id=object_id,
            object_value=None,
        )
        support = (await database.support_for_equivalence_keys([uses_key]))[uses_key]
        assert support.support_count == 2
        assert support.session_count == 2
        assert set(support.segment_ids) == {first.segment_id, support_job.segment_id}

        await database.enqueue(request.model_copy(update={"end_user_message_id": "end-3"}))
        async with database.pool.connection() as connection:
            empty_shared_claim = await database.claim_oldest_job(connection)
        assert empty_shared_claim is not None
        await database.commit_extraction(
            empty_shared_claim,
            PreparedSegment(
                id=empty_shared_claim.segment_id,
                session_id=empty_shared_claim.request.session_id,
                start_user_message_id=empty_shared_claim.request.start_user_message_id,
                end_user_message_id=empty_shared_claim.request.end_user_message_id,
                summary="No claims in this snapshot",
                entities=(),
                claims=(),
                projection_version=empty_shared_claim.request.projection_version,
            ),
        )
        async with database.pool.connection() as connection:
            shared_cursor = await connection.execute(
                "SELECT id FROM entities WHERE id = ANY(%s)",
                ([subject_id, object_id],),
            )
            shared_entities = await shared_cursor.fetchall()
        assert {row["id"] for row in shared_entities} == {subject_id, object_id}

        orphan_request = SegmentCreate(
            session_id="orphan-session",
            start_user_message_id="orphan-start",
            end_user_message_id="orphan-end-1",
            messages=[{"role": "user", "text": "temporary claim"}],
        )
        await database.enqueue(orphan_request)
        async with database.pool.connection() as connection:
            orphan_claim = await database.claim_oldest_job(connection)
        assert orphan_claim is not None
        orphan_subject_id = uuid4()
        orphan_object_id = uuid4()
        await database.commit_extraction(
            orphan_claim,
            prepared_segment(
                orphan_claim,
                end_id="orphan-end-1",
                summary="Temporary claims",
                subject_id=orphan_subject_id,
                object_id=orphan_object_id,
                entities_are_new=True,
            ),
        )
        await database.enqueue(
            orphan_request.model_copy(update={"end_user_message_id": "orphan-end-2"})
        )
        async with database.pool.connection() as connection:
            empty_claim = await database.claim_oldest_job(connection)
        assert empty_claim is not None
        await database.commit_extraction(
            empty_claim,
            PreparedSegment(
                id=empty_claim.segment_id,
                session_id=empty_claim.request.session_id,
                start_user_message_id=empty_claim.request.start_user_message_id,
                end_user_message_id=empty_claim.request.end_user_message_id,
                summary="No durable claims",
                entities=(),
                claims=(),
            ),
        )
        async with database.pool.connection() as connection:
            orphan_cursor = await connection.execute(
                "SELECT id FROM entities WHERE id = ANY(%s)",
                ([orphan_subject_id, orphan_object_id],),
            )
            orphan_entities = await orphan_cursor.fetchall()
        assert orphan_entities == []

        async with database.pool.connection() as connection:
            payload_cursor = await connection.execute(
                "SELECT id, payload FROM extraction_jobs WHERE id = ANY(%s)",
                ([first.id, tail.id, support_job.id],),
            )
            completed_payloads = await payload_cursor.fetchall()
        assert all(row["payload"] is None for row in completed_payloads)

        old_snapshot = await database.enqueue(
            request.model_copy(
                update={"start_user_message_id": "blocked-tail", "end_user_message_id": "old"}
            )
        )
        async with database.pool.connection() as connection:
            old_snapshot_claim = await database.claim_oldest_job(connection)
        assert old_snapshot_claim is not None
        assert await database.finish_failed_attempt(
            old_snapshot_claim, "terminal old snapshot", retry_after_seconds=None
        )
        newer_snapshot = await database.enqueue(
            request.model_copy(
                update={"start_user_message_id": "blocked-tail", "end_user_message_id": "new"}
            )
        )
        with pytest.raises(JobNotRetryableError, match="newer snapshot"):
            await database.retry_failed_job(old_snapshot.id)
        async with database.pool.connection() as connection:
            newer_snapshot_claim = await database.claim_oldest_job(connection)
        assert newer_snapshot_claim is not None
        assert newer_snapshot_claim.id == newer_snapshot.id
        assert await database.finish_failed_attempt(
            newer_snapshot_claim, "terminal newer snapshot", retry_after_seconds=None
        )

        async with database.pool.connection() as connection:
            failed_payload_cursor = await connection.execute(
                "SELECT payload FROM extraction_jobs WHERE id = ANY(%s)",
                ([old_snapshot.id, newer_snapshot.id],),
            )
            failed_payloads = await failed_payload_cursor.fetchall()
        assert all(row["payload"] is not None for row in failed_payloads)

        retry_request = request.model_copy(
            update={"start_user_message_id": "retry-start", "end_user_message_id": "retry-end"}
        )
        retry_job = await database.enqueue(retry_request)
        async with database.pool.connection() as connection:
            terminal_claim = await database.claim_oldest_job(connection)
        assert terminal_claim is not None
        assert await database.finish_failed_attempt(
            terminal_claim, "terminal", retry_after_seconds=None
        )
        retried = await database.retry_failed_job(retry_job.id)
        assert retried is not None
        assert retried.attempts == 0
        async with database.pool.connection() as connection:
            retried_claim = await database.claim_oldest_job(connection)
        assert retried_claim is not None
        assert retried_claim.lease_id != terminal_claim.lease_id
        await database.apply_migrations(configured.migrations_dir)
        still_running = await database.get_job(retried_claim.id)
        assert still_running is not None and still_running.status == "running"
        assert not await database.finish_failed_attempt(
            terminal_claim, "stale after explicit retry", retry_after_seconds=None
        )

        newer = await database.enqueue(
            request.model_copy(
                update={"start_user_message_id": "newer", "end_user_message_id": "newer-end"}
            )
        )
        assert await database.finish_failed_attempt(
            retried_claim, "transient", retry_after_seconds=60
        )
        async with database.pool.connection() as connection:
            assert await database.claim_oldest_job(connection) is None
        assert (await database.get_job(newer.id)) is not None
    finally:
        await database.close()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_running_targets_survive_recovery_and_upgrade() -> None:
    database_url = os.getenv("REFLECTION_TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("REFLECTION_TEST_DATABASE_URL is not set")
    configured = Settings(
        database_url=database_url,
        reflection_api_key="test",
        openrouter_api_key="test",
        voyage_api_key="test",
        migrations_dir=Path(__file__).parents[1] / "migrations",
    )
    database = Database(configured)
    await database.open()
    try:
        async with database.pool.connection() as connection:
            await connection.execute(
                "TRUNCATE segment_targets, claims, entity_aliases, entities, segments, "
                "extraction_jobs RESTART IDENTITY CASCADE"
            )

        first_request = SegmentCreate(
            session_id="running-session",
            start_user_message_id="start",
            end_user_message_id="A",
            projection_version=1,
            messages=[{"role": "user", "text": "A"}],
        )
        first_job = await database.enqueue(first_request)
        async with database.pool.connection() as connection:
            first_claim = await database.claim_oldest_job(connection)
        assert first_claim is not None
        await database.commit_extraction(
            first_claim,
            PreparedSegment(
                id=first_claim.segment_id,
                session_id="running-session",
                start_user_message_id="start",
                end_user_message_id="A",
                summary="A",
                entities=(),
                claims=(),
                projection_version=1,
            ),
        )

        second_job = await database.enqueue(
            first_request.model_copy(update={"end_user_message_id": "B"})
        )
        async with database.pool.connection() as connection:
            second_claim = await database.claim_oldest_job(connection)
        assert second_claim is not None and second_claim.id == second_job.id
        replay = await database.enqueue(first_request)
        assert replay.id == first_job.id
        assert replay.status == JobStatus.SUCCEEDED

        async with database.pool.connection() as connection:
            assert await database.recover_running_jobs(connection) == 1
            recovered_second = await database.claim_oldest_job(connection)
        assert recovered_second is not None and recovered_second.id == second_job.id
        await database.commit_extraction(
            recovered_second,
            PreparedSegment(
                id=recovered_second.segment_id,
                session_id="running-session",
                start_user_message_id="start",
                end_user_message_id="B",
                summary="B",
                entities=(),
                claims=(),
                projection_version=1,
            ),
        )
        async with database.pool.connection() as connection:
            replay_claim = await database.claim_oldest_job(connection)
        assert replay_claim is not None and replay_claim.id == first_job.id
        await database.commit_extraction(
            replay_claim,
            PreparedSegment(
                id=replay_claim.segment_id,
                session_id="running-session",
                start_user_message_id="start",
                end_user_message_id="A",
                summary="A after recovery",
                entities=(),
                claims=(),
                projection_version=1,
            ),
        )
        rewound = await database.get_segment(first_job.segment_id)
        assert rewound is not None
        assert rewound.end_user_message_id == "A"
        assert rewound.summary == "A after recovery"

        failing_job = await database.enqueue(
            first_request.model_copy(update={"end_user_message_id": "failing-B"})
        )
        async with database.pool.connection() as connection:
            failing_claim = await database.claim_oldest_job(connection)
        assert failing_claim is not None and failing_claim.id == failing_job.id
        await database.enqueue(first_request)
        assert await database.finish_failed_attempt(
            failing_claim,
            "terminal failure",
            retry_after_seconds=None,
        )
        async with database.pool.connection() as connection:
            target_cursor = await connection.execute(
                "SELECT count(*) AS count FROM segment_targets WHERE segment_id = %s",
                (first_job.segment_id,),
            )
            target_count = await target_cursor.fetchone()
        assert target_count is not None and target_count["count"] == 0

        upgrade_request = SegmentCreate(
            session_id="running-session",
            start_user_message_id="upgrade",
            end_user_message_id="upgrade-end",
            messages=[{"role": "user", "text": "upgrade"}],
        )
        upgrade_job = await database.enqueue(upgrade_request)
        async with database.pool.connection() as connection:
            legacy_claim = await database.claim_oldest_job(connection)
        assert legacy_claim is not None and legacy_claim.id == upgrade_job.id
        deferred_upgrade = await database.enqueue(
            upgrade_request.model_copy(update={"projection_version": 1})
        )
        assert deferred_upgrade.status == JobStatus.RUNNING
        assert deferred_upgrade.projection_version == 0
        await database.commit_extraction(
            legacy_claim,
            PreparedSegment(
                id=legacy_claim.segment_id,
                session_id="running-session",
                start_user_message_id="upgrade",
                end_user_message_id="upgrade-end",
                summary="Legacy",
                entities=(),
                claims=(),
            ),
        )
        upgraded_job = await database.get_job(upgrade_job.id)
        assert upgraded_job is not None
        assert upgraded_job.status == JobStatus.PENDING
        assert upgraded_job.projection_version == 1
        async with database.pool.connection() as connection:
            upgraded_claim = await database.claim_oldest_job(connection)
        assert upgraded_claim is not None
        assert upgraded_claim.request.projection_version == 1
        rollback_connection = await AsyncConnection.connect(
            database_url,
            row_factory=dict_row,
        )
        async with rollback_connection, rollback_connection.transaction():
            await rollback_connection.execute("SELECT now()")
            await database.commit_extraction(
                upgraded_claim,
                PreparedSegment(
                    id=upgraded_claim.segment_id,
                    session_id="running-session",
                    start_user_message_id="upgrade",
                    end_user_message_id="upgrade-end",
                    summary="Safe",
                    entities=(),
                    claims=(),
                    projection_version=1,
                ),
            )
            assert {
                item.summary for item in await database.segment_summaries("running-session")
            } == {
                "A after recovery",
                "Safe",
            }
            await rollback_connection.execute(
                """
                UPDATE segments
                SET summary = 'unsafe rollback write', updated_at = now()
                WHERE id = %s
                """,
                (upgrade_job.segment_id,),
            )
        assert {item.summary for item in await database.segment_summaries("running-session")} == {
            "A after recovery"
        }
        repaired = await database.enqueue(
            upgrade_request.model_copy(update={"projection_version": 1})
        )
        assert repaired.status == JobStatus.PENDING
    finally:
        await database.close()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_legacy_schema_migrates_in_place() -> None:
    database_url = os.getenv("REFLECTION_TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("REFLECTION_TEST_DATABASE_URL is not set")
    connection = await AsyncConnection.connect(database_url, autocommit=True, row_factory=dict_row)
    async with connection:
        await connection.execute(
            """
            DROP TABLE IF EXISTS segment_targets, claims, entity_aliases, entities,
                segments, extraction_jobs CASCADE;
            CREATE EXTENSION IF NOT EXISTS vector;
            CREATE EXTENSION IF NOT EXISTS pg_trgm;
            CREATE TABLE extraction_jobs (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                segment_id UUID NOT NULL UNIQUE,
                session_id TEXT NOT NULL,
                start_user_message_id TEXT NOT NULL,
                end_user_message_id TEXT NOT NULL,
                payload JSONB NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                started_at TIMESTAMPTZ,
                finished_at TIMESTAMPTZ,
                UNIQUE (session_id, start_user_message_id, end_user_message_id)
            );
            CREATE TABLE segments (
                id UUID PRIMARY KEY,
                session_id TEXT NOT NULL,
                start_user_message_id TEXT NOT NULL,
                end_user_message_id TEXT NOT NULL,
                summary VARCHAR(1000) NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE (session_id, start_user_message_id)
            );
            CREATE TABLE entities (
                id UUID PRIMARY KEY,
                canonical_name TEXT NOT NULL,
                normalized_name TEXT NOT NULL,
                embedding vector(1024) NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE TABLE entity_aliases (
                entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
                alias TEXT NOT NULL,
                normalized_alias TEXT NOT NULL,
                PRIMARY KEY (entity_id, normalized_alias)
            );
            CREATE TABLE claims (
                id UUID PRIMARY KEY,
                segment_id UUID NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
                subject_text TEXT NOT NULL,
                subject_entity_id UUID NOT NULL REFERENCES entities(id),
                predicate TEXT NOT NULL,
                object_text TEXT NOT NULL,
                object_entity_id UUID NOT NULL REFERENCES entities(id),
                equivalence_key CHAR(64) NOT NULL,
                embedding vector(1024) NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            INSERT INTO extraction_jobs (
                segment_id, session_id, start_user_message_id, end_user_message_id, payload,
                status, started_at
            ) VALUES (
                '00000000-0000-0000-0000-000000000001', 'legacy', 'start', 'end', '{}',
                'running', now()
            );
            INSERT INTO extraction_jobs (
                segment_id, session_id, start_user_message_id, end_user_message_id, payload,
                status, finished_at
            ) VALUES (
                '00000000-0000-0000-0000-000000000006',
                'legacy-succeeded', 'start', 'end', '{"messages":["private"]}',
                'succeeded', now()
            );
            INSERT INTO segments (
                id, session_id, start_user_message_id, end_user_message_id, summary
            ) VALUES (
                '00000000-0000-0000-0000-000000000002', 'legacy', 'start', 'end', 'summary'
            );
            INSERT INTO entities (id, canonical_name, normalized_name, embedding)
            VALUES
                (
                    '00000000-0000-0000-0000-000000000003', 'Subject', 'subject',
                    array_fill(0.01::real, ARRAY[1024])::vector
                ),
                (
                    '00000000-0000-0000-0000-000000000004', 'Object', 'object',
                    array_fill(0.01::real, ARRAY[1024])::vector
                );
            INSERT INTO claims (
                id, segment_id, subject_text, subject_entity_id, predicate, object_text,
                object_entity_id, equivalence_key, embedding
            ) VALUES (
                '00000000-0000-0000-0000-000000000005',
                '00000000-0000-0000-0000-000000000002',
                'Subject', '00000000-0000-0000-0000-000000000003', 'uses', 'Object',
                '00000000-0000-0000-0000-000000000004', repeat('a', 64),
                array_fill(0.01::real, ARRAY[1024])::vector
            );
            """
        )

    configured = Settings(
        database_url=database_url,
        reflection_api_key="test",
        openrouter_api_key="test",
        voyage_api_key="test",
        migrations_dir=Path(__file__).parents[1] / "migrations",
    )
    database = Database(configured)
    await database.open()
    try:
        async with database.pool.connection() as migrated:
            job_cursor = await migrated.execute(
                "SELECT status, lease_id, next_attempt_at FROM extraction_jobs WHERE id = 1"
            )
            succeeded_cursor = await migrated.execute(
                "SELECT payload FROM extraction_jobs WHERE status = 'succeeded'"
            )
            entity_cursor = await migrated.execute(
                "SELECT description FROM entities ORDER BY canonical_name"
            )
            claim_cursor = await migrated.execute(
                """
                SELECT object_entity_text, object_entity_id, object_value, confidence
                FROM claims
                """
            )
            column_cursor = await migrated.execute(
                """
                SELECT count(*) AS count
                FROM information_schema.columns
                WHERE table_name = 'claims' AND column_name = 'object_text'
                """
            )
            job = await job_cursor.fetchone()
            succeeded = await succeeded_cursor.fetchone()
            entities = await entity_cursor.fetchall()
            claim = await claim_cursor.fetchone()
            old_column = await column_cursor.fetchone()
            payload_column_cursor = await migrated.execute(
                """
                SELECT is_nullable
                FROM information_schema.columns
                WHERE table_name = 'extraction_jobs' AND column_name = 'payload'
                """
            )
            payload_column = await payload_column_cursor.fetchone()

        assert job is not None
        assert job["status"] == "pending"
        assert job["lease_id"] is None
        assert job["next_attempt_at"] is not None
        assert succeeded is not None and succeeded["payload"] is None
        assert {row["description"] for row in entities} == {
            "Entity: Object",
            "Entity: Subject",
        }
        assert claim is not None
        assert claim["object_entity_text"] == "Object"
        assert claim["object_entity_id"] is not None
        assert claim["object_value"] is None
        assert claim["confidence"] == 1
        assert old_column is not None and old_column["count"] == 0
        assert payload_column is not None and payload_column["is_nullable"] == "YES"

        async with database.pool.connection() as migrated:
            await migrated.execute("UPDATE extraction_jobs SET payload = NULL WHERE id = 1")
            assert await database.claim_oldest_job(migrated) is None
        invalid_payload_job = await database.get_job(1)
        assert invalid_payload_job is not None
        assert invalid_payload_job.status == "failed"
        assert invalid_payload_job.error == "invalid persisted payload: payload is null"

        async with database.pool.connection() as migrated:
            await migrated.execute(
                """
                INSERT INTO extraction_jobs (
                    segment_id, session_id, start_user_message_id, end_user_message_id, payload
                ) VALUES (
                    '00000000-0000-0000-0000-000000000001',
                    'legacy', 'start', 'new-end', '{}'
                )
                """
            )
            count_cursor = await migrated.execute(
                """
                SELECT count(*) AS count FROM extraction_jobs
                WHERE segment_id = '00000000-0000-0000-0000-000000000001'
                """
            )
            same_segment_count = await count_cursor.fetchone()
        assert same_segment_count is not None and same_segment_count["count"] == 2
    finally:
        await database.close()
