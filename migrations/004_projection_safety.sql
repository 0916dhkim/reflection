ALTER TABLE extraction_jobs
    ADD COLUMN IF NOT EXISTS projection_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE segments
    ADD COLUMN IF NOT EXISTS projection_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE segments
    ADD COLUMN IF NOT EXISTS projection_commit_fingerprint CHAR(64);

CREATE OR REPLACE FUNCTION reflection_projection_fingerprint(
    segment_id UUID,
    end_user_message_id TEXT,
    summary TEXT,
    projection_version INTEGER
) RETURNS CHAR(64)
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT encode(
        sha256(
            convert_to(
                segment_id::TEXT || ':' ||
                length(end_user_message_id)::TEXT || ':' || end_user_message_id || ':' ||
                length(summary)::TEXT || ':' || summary || ':' || projection_version::TEXT,
                'UTF8'
            )
        ),
        'hex'
    )::CHAR(64)
$$;

UPDATE segments
SET projection_commit_fingerprint = reflection_projection_fingerprint(
    id,
    end_user_message_id,
    summary,
    projection_version
)
WHERE projection_commit_fingerprint IS NULL;

CREATE TABLE IF NOT EXISTS segment_targets (
    segment_id UUID PRIMARY KEY,
    job_id BIGINT NOT NULL,
    end_user_message_id TEXT NOT NULL,
    projection_version INTEGER NOT NULL,
    payload JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
