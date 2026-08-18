ALTER TABLE extraction_jobs
    DROP CONSTRAINT IF EXISTS extraction_jobs_segment_id_key;

ALTER TABLE extraction_jobs
    ADD COLUMN IF NOT EXISTS lease_id UUID,
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'extraction_jobs'::regclass
          AND conname = 'extraction_jobs_running_lease_check'
    ) THEN
        UPDATE extraction_jobs
        SET status = 'pending', lease_id = NULL, started_at = NULL, next_attempt_at = now(),
            error = 'worker stopped before completing the job'
        WHERE status = 'running';

        ALTER TABLE extraction_jobs
            ADD CONSTRAINT extraction_jobs_running_lease_check CHECK (
                (status = 'running') = (lease_id IS NOT NULL)
            );
    END IF;
END
$$;

ALTER TABLE entities
    ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';

UPDATE entities
SET description = 'Entity: ' || canonical_name
WHERE description = '';

ALTER TABLE entities
    ALTER COLUMN description DROP DEFAULT;

ALTER TABLE claims
    ADD COLUMN IF NOT EXISTS object_entity_text TEXT,
    ADD COLUMN IF NOT EXISTS object_value TEXT;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'claims'
          AND column_name = 'object_text'
    ) THEN
        EXECUTE 'UPDATE claims SET object_entity_text = object_text '
                'WHERE object_entity_text IS NULL';
        EXECUTE 'ALTER TABLE claims DROP COLUMN object_text';
    END IF;
END
$$;

ALTER TABLE claims
    ALTER COLUMN object_entity_id DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'claims'::regclass
          AND conname = 'claims_object_kind_check'
    ) THEN
        ALTER TABLE claims
            ADD CONSTRAINT claims_object_kind_check CHECK (
                (
                    object_entity_text IS NOT NULL
                    AND object_entity_id IS NOT NULL
                    AND object_value IS NULL
                )
                OR
                (
                    object_entity_text IS NULL
                    AND object_entity_id IS NULL
                    AND object_value IS NOT NULL
                )
            );
    END IF;
END
$$;
