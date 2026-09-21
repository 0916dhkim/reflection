-- CP005 expansion only.  This migration deliberately retains every existing
-- global key: old binaries must continue to be able to write until the
-- operator runs `scripts/source-ownership.mjs cutover` at a quiescent boundary.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS reflection_sources (
    source_id TEXT PRIMARY KEY CHECK (source_id = btrim(source_id) AND length(source_id) BETWEEN 1 AND 500),
    kind TEXT NOT NULL CHECK (kind IN ('opencode-v1', 'opencode-v2')),
    identity_scheme TEXT NOT NULL CHECK (identity_scheme IN ('legacy', 'source-v1'))
);

CREATE UNIQUE INDEX IF NOT EXISTS reflection_sources_one_legacy_identity
    ON reflection_sources ((identity_scheme))
    WHERE identity_scheme = 'legacy';

ALTER TABLE segments
    ADD COLUMN IF NOT EXISTS source_id TEXT;
ALTER TABLE extraction_jobs
    ADD COLUMN IF NOT EXISTS source_id TEXT;
ALTER TABLE segment_targets
    ADD COLUMN IF NOT EXISTS source_id TEXT;

ALTER TABLE segments
    DROP CONSTRAINT IF EXISTS segments_source_id_fkey;
ALTER TABLE segments
    ADD CONSTRAINT segments_source_id_fkey
    FOREIGN KEY (source_id) REFERENCES reflection_sources(source_id)
    NOT VALID;
ALTER TABLE extraction_jobs
    DROP CONSTRAINT IF EXISTS extraction_jobs_source_id_fkey;
ALTER TABLE extraction_jobs
    ADD CONSTRAINT extraction_jobs_source_id_fkey
    FOREIGN KEY (source_id) REFERENCES reflection_sources(source_id)
    NOT VALID;
ALTER TABLE segment_targets
    DROP CONSTRAINT IF EXISTS segment_targets_source_id_fkey;
ALTER TABLE segment_targets
    ADD CONSTRAINT segment_targets_source_id_fkey
    FOREIGN KEY (source_id) REFERENCES reflection_sources(source_id)
    NOT VALID;

CREATE FUNCTION reflection_immutable_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'source registry entries are immutable';
END;
$$;
CREATE TRIGGER reflection_sources_immutable
    BEFORE UPDATE OR DELETE ON reflection_sources
    FOR EACH ROW EXECUTE FUNCTION reflection_immutable_source();

-- Build large-table indexes CONCURRENTLY with install-indexes, not here.
