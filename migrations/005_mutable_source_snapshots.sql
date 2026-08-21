CREATE OR REPLACE FUNCTION reflection_source_fingerprint(
    session_id TEXT,
    start_user_message_id TEXT,
    end_user_message_id TEXT,
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
        'reflection-source-v1:' ||
        octet_length(session_id)::TEXT || ':' || session_id ||
        octet_length(start_user_message_id)::TEXT || ':' || start_user_message_id ||
        octet_length(end_user_message_id)::TEXT || ':' || end_user_message_id ||
        message_count::TEXT || ':' || message_frames;

    RETURN encode(sha256(convert_to(fingerprint_input, 'UTF8')), 'hex')::CHAR(64);
END
$$;

ALTER TABLE extraction_jobs
    ADD COLUMN IF NOT EXISTS source_generation BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS source_fingerprint CHAR(64);

ALTER TABLE segment_targets
    ADD COLUMN IF NOT EXISTS source_generation BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS source_fingerprint CHAR(64);

ALTER TABLE segments
    ADD COLUMN IF NOT EXISTS source_generation BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS source_fingerprint CHAR(64);

UPDATE extraction_jobs
SET source_fingerprint = reflection_source_fingerprint(
        session_id,
        start_user_message_id,
        end_user_message_id,
        payload
    )
WHERE source_fingerprint IS NULL AND payload IS NOT NULL;

WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY segment_id ORDER BY id) AS generation
    FROM extraction_jobs
    WHERE source_fingerprint IS NOT NULL
)
UPDATE extraction_jobs AS jobs
SET source_generation = ranked.generation
FROM ranked
WHERE jobs.id = ranked.id AND jobs.source_generation = 0;

UPDATE segment_targets AS targets
SET source_fingerprint = reflection_source_fingerprint(
        jobs.session_id,
        jobs.start_user_message_id,
        targets.end_user_message_id,
        targets.payload
    )
FROM extraction_jobs AS jobs
WHERE jobs.id = targets.job_id AND targets.source_fingerprint IS NULL;

WITH maxima AS (
    SELECT segment_id, COALESCE(MAX(source_generation), 0) AS generation
    FROM extraction_jobs
    GROUP BY segment_id
)
UPDATE segment_targets AS targets
SET source_generation = maxima.generation + 1
FROM maxima
WHERE targets.segment_id = maxima.segment_id
  AND targets.source_generation = 0
  AND targets.source_fingerprint IS NOT NULL;

WITH target_identity AS (
    SELECT targets.job_id,
           targets.projection_version,
           targets.payload,
           targets.source_generation,
           targets.source_fingerprint,
           (
               jobs.projection_version <> targets.projection_version
               OR jobs.payload IS DISTINCT FROM targets.payload
               OR jobs.source_fingerprint IS DISTINCT FROM targets.source_fingerprint
           ) AS semantically_changed,
           (
               jobs.projection_version <> targets.projection_version
               OR jobs.payload IS DISTINCT FROM targets.payload
               OR jobs.source_generation <> targets.source_generation
               OR jobs.source_fingerprint IS DISTINCT FROM targets.source_fingerprint
           ) AS identity_changed
    FROM segment_targets AS targets
    JOIN extraction_jobs AS jobs ON jobs.id = targets.job_id
    WHERE targets.source_fingerprint IS NOT NULL
)
UPDATE extraction_jobs AS jobs
SET projection_version = target_identity.projection_version,
    payload = target_identity.payload,
    source_generation = target_identity.source_generation,
    source_fingerprint = target_identity.source_fingerprint,
    status = CASE
        WHEN jobs.status = 'succeeded'
          OR (jobs.status = 'failed' AND target_identity.semantically_changed)
        THEN 'pending'
        ELSE jobs.status
    END,
    attempts = CASE
        WHEN jobs.status = 'succeeded'
          OR (jobs.status = 'failed' AND target_identity.semantically_changed)
          OR (
              jobs.status IN ('pending', 'running')
              AND target_identity.identity_changed
          )
        THEN 0
        ELSE jobs.attempts
    END,
    lease_id = CASE
        WHEN jobs.status IN ('pending', 'succeeded')
          OR (jobs.status = 'failed' AND target_identity.semantically_changed)
        THEN NULL
        ELSE jobs.lease_id
    END,
    error = CASE
        WHEN jobs.status IN ('pending', 'succeeded')
          OR (jobs.status = 'failed' AND target_identity.semantically_changed)
        THEN NULL
        ELSE jobs.error
    END,
    started_at = CASE
        WHEN jobs.status IN ('pending', 'succeeded')
          OR (jobs.status = 'failed' AND target_identity.semantically_changed)
        THEN NULL
        ELSE jobs.started_at
    END,
    finished_at = CASE
        WHEN jobs.status IN ('pending', 'succeeded')
          OR (jobs.status = 'failed' AND target_identity.semantically_changed)
        THEN NULL
        ELSE jobs.finished_at
    END,
    next_attempt_at = CASE
        WHEN jobs.status IN ('pending', 'succeeded')
          OR (jobs.status = 'failed' AND target_identity.semantically_changed)
        THEN now()
        ELSE jobs.next_attempt_at
    END
FROM target_identity
WHERE jobs.id = target_identity.job_id
  AND (target_identity.identity_changed OR jobs.status = 'succeeded');

WITH latest AS (
    SELECT DISTINCT ON (segment_id)
           id, segment_id, end_user_message_id, projection_version, payload,
           source_generation, source_fingerprint
    FROM extraction_jobs
    WHERE status IN ('pending', 'running', 'failed')
      AND source_fingerprint IS NOT NULL
      AND payload IS NOT NULL
      AND (
          status IN ('pending', 'running')
          OR NOT EXISTS (
              SELECT 1
              FROM segments
              WHERE segments.id = extraction_jobs.segment_id
                AND (
                    extraction_jobs.finished_at IS NULL
                    OR segments.updated_at >= extraction_jobs.finished_at
                )
          )
      )
    ORDER BY segment_id,
             CASE WHEN status IN ('pending', 'running') THEN 0 ELSE 1 END,
             CASE WHEN status = 'failed' THEN finished_at END DESC NULLS LAST,
             source_generation DESC,
             id DESC
)
INSERT INTO segment_targets (
    segment_id,
    job_id,
    end_user_message_id,
    projection_version,
    payload,
    source_generation,
    source_fingerprint
)
SELECT segment_id, id, end_user_message_id, projection_version, payload,
       source_generation, source_fingerprint
FROM latest
ON CONFLICT (segment_id) DO NOTHING;

DELETE FROM extraction_jobs AS jobs
USING segment_targets AS targets
WHERE jobs.segment_id = targets.segment_id
  AND jobs.id <> targets.job_id
  AND jobs.status = 'pending';

WITH matching_jobs AS (
    SELECT DISTINCT ON (segments.id)
           segments.id AS segment_id,
           jobs.source_generation,
           jobs.source_fingerprint
    FROM segments
    JOIN extraction_jobs AS jobs
      ON jobs.segment_id = segments.id
     AND jobs.end_user_message_id = segments.end_user_message_id
     AND jobs.status = 'succeeded'
     AND jobs.source_fingerprint IS NOT NULL
    ORDER BY segments.id, jobs.source_generation DESC, jobs.id DESC
)
UPDATE segments
SET source_generation = matching_jobs.source_generation,
    source_fingerprint = matching_jobs.source_fingerprint
FROM matching_jobs
WHERE segments.id = matching_jobs.segment_id
  AND segments.source_fingerprint IS NULL;
