ALTER TABLE extraction_jobs
    ADD COLUMN IF NOT EXISTS source_boundary_version SMALLINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS start_source_message_id TEXT,
    ADD COLUMN IF NOT EXISTS end_source_message_id TEXT,
    ADD COLUMN IF NOT EXISTS processing_priority INTEGER NOT NULL DEFAULT 0;

ALTER TABLE segments
    ADD COLUMN IF NOT EXISTS source_boundary_version SMALLINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS start_source_message_id TEXT,
    ADD COLUMN IF NOT EXISTS end_source_message_id TEXT;

ALTER TABLE segment_targets
    ADD COLUMN IF NOT EXISTS source_boundary_version SMALLINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS start_source_message_id TEXT,
    ADD COLUMN IF NOT EXISTS end_source_message_id TEXT,
    ADD COLUMN IF NOT EXISTS extraction_result JSONB,
    ADD COLUMN IF NOT EXISTS summary_commit_fingerprint CHAR(64),
    ADD COLUMN IF NOT EXISTS processing_priority INTEGER NOT NULL DEFAULT 0;

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    FOR constraint_name IN
        SELECT constraint_row.conname
        FROM pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = 'extraction_jobs'::regclass
          AND constraint_row.contype = 'u'
          AND (
              SELECT array_agg(attribute.attname::TEXT ORDER BY key_column.ordinality)
              FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = constraint_row.conrelid
               AND attribute.attnum = key_column.attnum
          ) = ARRAY['session_id', 'start_user_message_id', 'end_user_message_id']
    LOOP
        EXECUTE format('ALTER TABLE extraction_jobs DROP CONSTRAINT %I', constraint_name);
    END LOOP;

    FOR constraint_name IN
        SELECT constraint_row.conname
        FROM pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = 'segments'::regclass
          AND constraint_row.contype = 'u'
          AND (
              SELECT array_agg(attribute.attname::TEXT ORDER BY key_column.ordinality)
              FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = constraint_row.conrelid
               AND attribute.attnum = key_column.attnum
          ) = ARRAY['session_id', 'start_user_message_id']
    LOOP
        EXECUTE format('ALTER TABLE segments DROP CONSTRAINT %I', constraint_name);
    END LOOP;
END
$$;

ALTER TABLE extraction_jobs
    DROP CONSTRAINT IF EXISTS extraction_jobs_source_boundary_check,
    DROP CONSTRAINT IF EXISTS extraction_jobs_processing_priority_check;
ALTER TABLE extraction_jobs
    ADD CONSTRAINT extraction_jobs_source_boundary_check CHECK (
        (
            source_boundary_version = 1
            AND start_source_message_id IS NULL
            AND end_source_message_id IS NULL
            AND COALESCE(payload->>'source_boundary_version', '1') = '1'
            AND payload->>'start_source_message_id' IS NULL
            AND payload->>'end_source_message_id' IS NULL
        )
        OR
        (
            source_boundary_version = 2
            AND start_user_message_id = end_user_message_id
            AND start_source_message_id IS NOT NULL
            AND start_source_message_id <> ''
            AND end_source_message_id IS NOT NULL
            AND end_source_message_id <> ''
        )
    ),
    ADD CONSTRAINT extraction_jobs_processing_priority_check CHECK (
        processing_priority BETWEEN 0 AND 100
    );

ALTER TABLE segments
    DROP CONSTRAINT IF EXISTS segments_source_boundary_check;
ALTER TABLE segments
    ADD CONSTRAINT segments_source_boundary_check CHECK (
        (
            source_boundary_version = 1
            AND start_source_message_id IS NULL
            AND end_source_message_id IS NULL
        )
        OR
        (
            source_boundary_version = 2
            AND start_user_message_id = end_user_message_id
            AND start_source_message_id IS NOT NULL
            AND start_source_message_id <> ''
            AND end_source_message_id IS NOT NULL
            AND end_source_message_id <> ''
        )
    );

ALTER TABLE segment_targets
    DROP CONSTRAINT IF EXISTS segment_targets_source_boundary_check,
    DROP CONSTRAINT IF EXISTS segment_targets_staged_result_check,
    DROP CONSTRAINT IF EXISTS segment_targets_processing_priority_check;
ALTER TABLE segment_targets
    ADD CONSTRAINT segment_targets_source_boundary_check CHECK (
        (
            source_boundary_version = 1
            AND start_source_message_id IS NULL
            AND end_source_message_id IS NULL
            AND COALESCE(payload->>'source_boundary_version', '1') = '1'
            AND payload->>'start_source_message_id' IS NULL
            AND payload->>'end_source_message_id' IS NULL
        )
        OR
        (
            source_boundary_version = 2
            AND start_source_message_id IS NOT NULL
            AND start_source_message_id <> ''
            AND end_source_message_id IS NOT NULL
            AND end_source_message_id <> ''
            AND payload->>'source_boundary_version' IS NOT DISTINCT FROM '2'
            AND payload->>'start_user_message_id' IS NOT NULL
            AND payload->>'start_user_message_id'
                IS NOT DISTINCT FROM payload->>'end_user_message_id'
            AND payload->>'end_user_message_id'
                IS NOT DISTINCT FROM end_user_message_id
            AND payload->>'start_source_message_id'
                IS NOT DISTINCT FROM start_source_message_id
            AND payload->>'end_source_message_id'
                IS NOT DISTINCT FROM end_source_message_id
        )
    ),
    ADD CONSTRAINT segment_targets_staged_result_check CHECK (
        (extraction_result IS NULL) = (summary_commit_fingerprint IS NULL)
    ),
    ADD CONSTRAINT segment_targets_processing_priority_check CHECK (
        processing_priority BETWEEN 0 AND 100
    );

CREATE UNIQUE INDEX IF NOT EXISTS extraction_jobs_v1_boundary_key
    ON extraction_jobs (session_id, start_user_message_id, end_user_message_id)
    WHERE source_boundary_version = 1;
CREATE UNIQUE INDEX IF NOT EXISTS extraction_jobs_v2_boundary_key
    ON extraction_jobs (session_id, start_source_message_id, end_source_message_id)
    WHERE source_boundary_version = 2;
CREATE UNIQUE INDEX IF NOT EXISTS segments_v1_start_key
    ON segments (session_id, start_user_message_id)
    WHERE source_boundary_version = 1;
CREATE UNIQUE INDEX IF NOT EXISTS segments_v2_start_key
    ON segments (session_id, start_source_message_id)
    WHERE source_boundary_version = 2;
CREATE INDEX IF NOT EXISTS extraction_jobs_priority_idx
    ON extraction_jobs (processing_priority DESC, id)
    WHERE status = 'pending';

CREATE OR REPLACE FUNCTION reflection_projection_fingerprint(
    segment_id UUID,
    source_boundary_version INTEGER,
    end_user_message_id TEXT,
    end_source_message_id TEXT,
    summary TEXT,
    projection_version INTEGER
) RETURNS CHAR(64)
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
    fingerprint_input TEXT;
BEGIN
    IF source_boundary_version = 1 THEN
        IF end_source_message_id IS NOT NULL THEN
            RETURN NULL;
        END IF;
        RETURN reflection_projection_fingerprint(
            segment_id,
            end_user_message_id,
            summary,
            projection_version
        );
    END IF;
    IF source_boundary_version <> 2 OR end_source_message_id IS NULL THEN
        RETURN NULL;
    END IF;

    fingerprint_input :=
        'reflection-projection-v2:' ||
        octet_length(segment_id::TEXT)::TEXT || ':' || segment_id::TEXT ||
        octet_length(source_boundary_version::TEXT)::TEXT || ':' || source_boundary_version::TEXT ||
        octet_length(end_user_message_id)::TEXT || ':' || end_user_message_id ||
        octet_length(end_source_message_id)::TEXT || ':' || end_source_message_id ||
        octet_length(summary)::TEXT || ':' || summary ||
        octet_length(projection_version::TEXT)::TEXT || ':' || projection_version::TEXT;

    RETURN encode(sha256(convert_to(fingerprint_input, 'UTF8')), 'hex')::CHAR(64);
END
$$;

CREATE OR REPLACE FUNCTION reflection_source_fingerprint(
    session_id TEXT,
    start_user_message_id TEXT,
    end_user_message_id TEXT,
    source_boundary_version INTEGER,
    start_source_message_id TEXT,
    end_source_message_id TEXT,
    payload JSONB
) RETURNS CHAR(64)
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
    messages JSONB;
    message_count INTEGER;
    message_frames TEXT;
    fingerprint_input TEXT;
BEGIN
    IF source_boundary_version = 1 THEN
        IF start_source_message_id IS NOT NULL OR end_source_message_id IS NOT NULL THEN
            RETURN NULL;
        END IF;
        RETURN reflection_source_fingerprint(
            session_id,
            start_user_message_id,
            end_user_message_id,
            payload
        );
    END IF;
    IF source_boundary_version <> 2
       OR start_source_message_id IS NULL
       OR end_source_message_id IS NULL THEN
        RETURN NULL;
    END IF;

    messages := payload -> 'messages';
    IF jsonb_typeof(messages) <> 'array' THEN
        RETURN NULL;
    END IF;
    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(messages) AS message
        WHERE jsonb_typeof(message) <> 'object'
           OR jsonb_typeof(message -> 'role') <> 'string'
           OR jsonb_typeof(message -> 'text') <> 'string'
    ) THEN
        RETURN NULL;
    END IF;

    message_count := jsonb_array_length(messages);
    SELECT COALESCE(
        string_agg(
            octet_length(message ->> 'role')::TEXT || ':' || (message ->> 'role') ||
            octet_length(message ->> 'text')::TEXT || ':' || (message ->> 'text'),
            '' ORDER BY ordinal
        ),
        ''
    )
    INTO message_frames
    FROM jsonb_array_elements(messages) WITH ORDINALITY AS source(message, ordinal);

    fingerprint_input :=
        'reflection-source-v2:' ||
        octet_length(session_id)::TEXT || ':' || session_id ||
        octet_length(start_user_message_id)::TEXT || ':' || start_user_message_id ||
        octet_length(end_user_message_id)::TEXT || ':' || end_user_message_id ||
        octet_length(source_boundary_version::TEXT)::TEXT || ':' || source_boundary_version::TEXT ||
        octet_length(start_source_message_id)::TEXT || ':' || start_source_message_id ||
        octet_length(end_source_message_id)::TEXT || ':' || end_source_message_id ||
        message_count::TEXT || ':' || message_frames;

    RETURN encode(sha256(convert_to(fingerprint_input, 'UTF8')), 'hex')::CHAR(64);
END
$$;
