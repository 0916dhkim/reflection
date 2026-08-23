ALTER TABLE extraction_jobs
    DROP CONSTRAINT IF EXISTS extraction_jobs_status_check;

ALTER TABLE extraction_jobs
    ADD CONSTRAINT extraction_jobs_status_check CHECK (
        status IN ('pending', 'running', 'succeeded', 'failed', 'superseded')
    );
