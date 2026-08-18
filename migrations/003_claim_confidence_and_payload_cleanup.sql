ALTER TABLE extraction_jobs
    ALTER COLUMN payload DROP NOT NULL;

UPDATE extraction_jobs
SET payload = NULL
WHERE status = 'succeeded' AND payload IS NOT NULL;

ALTER TABLE claims
    ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION;

UPDATE claims
SET confidence = 1
WHERE confidence IS NULL;

ALTER TABLE claims
    ALTER COLUMN confidence SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'claims'::regclass
          AND conname = 'claims_confidence_check'
    ) THEN
        ALTER TABLE claims
            ADD CONSTRAINT claims_confidence_check CHECK (
                confidence >= 0 AND confidence <= 1
            );
    END IF;
END
$$;
