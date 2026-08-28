ALTER TABLE segment_targets
    ADD COLUMN IF NOT EXISTS extraction_validation_version INTEGER,
    ADD COLUMN IF NOT EXISTS extraction_validation_fingerprint CHAR(64);

CREATE OR REPLACE FUNCTION reflection_extraction_validation_fingerprint(
    extraction_result JSONB,
    validation_version INTEGER,
    source_fingerprint CHAR(64)
) RETURNS CHAR(64)
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
    fingerprint_input TEXT;
BEGIN
    IF extraction_result IS NULL
       OR validation_version IS NULL
       OR source_fingerprint IS NULL THEN
        RETURN NULL;
    END IF;

    fingerprint_input :=
        'reflection-extraction-validation-v1:' ||
        octet_length(validation_version::TEXT)::TEXT || ':' || validation_version::TEXT ||
        octet_length(source_fingerprint::TEXT)::TEXT || ':' || source_fingerprint::TEXT ||
        octet_length(extraction_result::TEXT)::TEXT || ':' || extraction_result::TEXT;

    RETURN encode(sha256(convert_to(fingerprint_input, 'UTF8')), 'hex')::CHAR(64);
END
$$;

UPDATE extraction_jobs AS jobs
SET status = 'pending',
    attempts = 0,
    error = NULL,
    lease_id = NULL,
    started_at = NULL,
    finished_at = NULL,
    next_attempt_at = now()
FROM segment_targets AS targets
WHERE targets.job_id = jobs.id
  AND jobs.status IN ('running', 'failed')
  AND (
      targets.extraction_result IS NOT NULL
      OR targets.summary_commit_fingerprint IS NOT NULL
      OR targets.extraction_validation_version IS NOT NULL
      OR targets.extraction_validation_fingerprint IS NOT NULL
  );

UPDATE segment_targets
SET extraction_result = NULL,
    summary_commit_fingerprint = NULL,
    extraction_validation_version = NULL,
    extraction_validation_fingerprint = NULL
WHERE extraction_result IS NOT NULL
   OR summary_commit_fingerprint IS NOT NULL
   OR extraction_validation_version IS NOT NULL
   OR extraction_validation_fingerprint IS NOT NULL;

ALTER TABLE segment_targets
    DROP CONSTRAINT IF EXISTS segment_targets_extraction_validation_check;
ALTER TABLE segment_targets
    ADD CONSTRAINT segment_targets_extraction_validation_check CHECK (
        (
            extraction_result IS NULL
            AND summary_commit_fingerprint IS NULL
            AND extraction_validation_version IS NULL
            AND extraction_validation_fingerprint IS NULL
        )
        OR
        (
            extraction_result IS NOT NULL
            AND summary_commit_fingerprint IS NOT NULL
            AND extraction_validation_version IS NOT NULL
            AND extraction_validation_version > 0
            AND extraction_validation_fingerprint IS NOT NULL
            AND source_fingerprint IS NOT NULL
            AND extraction_validation_fingerprint =
                reflection_extraction_validation_fingerprint(
                    extraction_result,
                    extraction_validation_version,
                    source_fingerprint
                )
        )
    );
