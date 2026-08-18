CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS extraction_jobs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    segment_id UUID NOT NULL,
    session_id TEXT NOT NULL,
    start_user_message_id TEXT NOT NULL,
    end_user_message_id TEXT NOT NULL,
    payload JSONB,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_id UUID,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, start_user_message_id, end_user_message_id),
    CONSTRAINT extraction_jobs_running_lease_check CHECK (
        (status = 'running') = (lease_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS extraction_jobs_fifo_idx
    ON extraction_jobs (id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS segments (
    id UUID PRIMARY KEY,
    session_id TEXT NOT NULL,
    start_user_message_id TEXT NOT NULL,
    end_user_message_id TEXT NOT NULL,
    summary VARCHAR(1000) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, start_user_message_id)
);

CREATE INDEX IF NOT EXISTS segments_session_order_idx
    ON segments (session_id, created_at, id);

CREATE TABLE IF NOT EXISTS entities (
    id UUID PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    description TEXT NOT NULL,
    embedding vector(1024) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entities_name_trgm_idx
    ON entities USING gin (canonical_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS entities_embedding_hnsw_idx
    ON entities USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS entity_aliases (
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    normalized_alias TEXT NOT NULL,
    PRIMARY KEY (entity_id, normalized_alias)
);

CREATE INDEX IF NOT EXISTS entity_aliases_alias_trgm_idx
    ON entity_aliases USING gin (alias gin_trgm_ops);

CREATE TABLE IF NOT EXISTS claims (
    id UUID PRIMARY KEY,
    segment_id UUID NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    subject_text TEXT NOT NULL,
    subject_entity_id UUID NOT NULL REFERENCES entities(id),
    predicate TEXT NOT NULL,
    confidence DOUBLE PRECISION NOT NULL,
    object_entity_text TEXT,
    object_entity_id UUID REFERENCES entities(id),
    object_value TEXT,
    equivalence_key CHAR(64) NOT NULL,
    embedding vector(1024) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT claims_object_kind_check CHECK (
        (object_entity_text IS NOT NULL AND object_entity_id IS NOT NULL AND object_value IS NULL)
        OR
        (object_entity_text IS NULL AND object_entity_id IS NULL AND object_value IS NOT NULL)
    ),
    CONSTRAINT claims_confidence_check CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE INDEX IF NOT EXISTS claims_segment_idx ON claims (segment_id);
CREATE INDEX IF NOT EXISTS claims_subject_entity_idx ON claims (subject_entity_id);
CREATE INDEX IF NOT EXISTS claims_object_entity_idx ON claims (object_entity_id);
CREATE INDEX IF NOT EXISTS claims_equivalence_idx ON claims (equivalence_key);
CREATE INDEX IF NOT EXISTS claims_embedding_hnsw_idx
    ON claims USING hnsw (embedding vector_cosine_ops);
