-- Native spans have source cursors, not synthetic user boundaries. Keep the
-- installed legacy predicates intact, including their historical payload rules.
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION reflection_native_payload_valid(
    payload JSONB, owner TEXT, session TEXT, start_cursor TEXT, end_cursor TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE messages JSONB;
BEGIN
    IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN RETURN FALSE; END IF;
    IF NOT (payload ?& ARRAY['source_id', 'session_id', 'source_boundary_version',
        'start_source_message_id', 'end_source_message_id', 'projection_version',
        'processing_priority', 'messages'])
       OR payload - ARRAY['source_id', 'session_id', 'source_boundary_version',
        'start_source_message_id', 'end_source_message_id', 'projection_version',
        'processing_priority', 'messages'] <> '{}'::jsonb
       OR jsonb_typeof(payload->'source_id') IS DISTINCT FROM 'string'
       OR payload->>'source_id' IS DISTINCT FROM owner
       OR jsonb_typeof(payload->'session_id') IS DISTINCT FROM 'string'
       OR length(btrim(payload->>'session_id')) = 0
       OR length(payload->>'session_id') > 500
       OR payload->>'session_id' IS DISTINCT FROM session
       OR payload->'source_boundary_version' IS DISTINCT FROM '3'::jsonb
       OR payload->'projection_version' IS DISTINCT FROM '3'::jsonb
       OR jsonb_typeof(payload->'start_source_message_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(payload->'end_source_message_id') IS DISTINCT FROM 'string'
       OR payload->>'start_source_message_id' IS DISTINCT FROM start_cursor
       OR payload->>'end_source_message_id' IS DISTINCT FROM end_cursor
       OR jsonb_typeof(payload->'processing_priority') IS DISTINCT FROM 'number'
       OR (payload->>'processing_priority')::numeric NOT BETWEEN 0 AND 100
       OR (payload->>'processing_priority')::numeric <> trunc((payload->>'processing_priority')::numeric)
    THEN RETURN FALSE; END IF;
    messages := payload->'messages';
    IF jsonb_typeof(messages) IS DISTINCT FROM 'array' THEN RETURN FALSE; END IF;
    IF jsonb_array_length(messages) NOT BETWEEN 1 AND 10000 THEN RETURN FALSE; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(messages) m
        WHERE jsonb_typeof(m) IS DISTINCT FROM 'object') THEN RETURN FALSE; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(messages) m
        WHERE jsonb_typeof(m) IS DISTINCT FROM 'object'
        OR NOT (m ?& ARRAY['id', 'type', 'text'])
        OR m - ARRAY['id', 'type', 'text'] <> '{}'::jsonb
        OR jsonb_typeof(m->'id') IS DISTINCT FROM 'string'
        OR length(btrim(m->>'id')) = 0 OR length(m->>'id') > 500
        OR jsonb_typeof(m->'type') IS DISTINCT FROM 'string'
        OR m->>'type' NOT IN ('user', 'assistant', 'synthetic', 'shell', 'skill',
            'system', 'compaction', 'idle', 'agent-switched', 'model-switched', 'location-switched')
        OR jsonb_typeof(m->'text') IS DISTINCT FROM 'string'
        OR length(m->>'text') > 1000000)
    THEN RETURN FALSE; END IF;
    RETURN (messages->0->>'id') IS NOT DISTINCT FROM start_cursor
       AND (messages->-1->>'id') IS NOT DISTINCT FROM end_cursor
       AND (SELECT count(DISTINCT m->>'id') = count(*) AND sum(length(m->>'text')) <= 2000000
            FROM jsonb_array_elements(messages) m);
END $$;

ALTER TABLE segments ALTER COLUMN start_user_message_id DROP NOT NULL,
    ALTER COLUMN end_user_message_id DROP NOT NULL;
ALTER TABLE extraction_jobs ALTER COLUMN start_user_message_id DROP NOT NULL,
    ALTER COLUMN end_user_message_id DROP NOT NULL;
ALTER TABLE segment_targets ALTER COLUMN end_user_message_id DROP NOT NULL;

DO $$
DECLARE tbl TEXT; old_check TEXT; legacy_users TEXT; native_payload TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['segments', 'extraction_jobs', 'segment_targets'] LOOP
        SELECT pg_get_expr(conbin, conrelid) INTO STRICT old_check FROM pg_constraint
          WHERE conrelid = tbl::regclass AND conname = tbl || '_source_boundary_check';
        legacy_users := 'end_user_message_id IS NOT NULL';
        native_payload := '';
        IF tbl <> 'segment_targets' THEN
            legacy_users := legacy_users || ' AND start_user_message_id IS NOT NULL';
            native_payload := ' AND start_user_message_id IS NULL';
        END IF;
        IF tbl = 'extraction_jobs' THEN
            native_payload := native_payload || ' AND (payload IS NULL AND status IN (''succeeded'', ''failed'', ''superseded'') OR reflection_native_payload_valid(payload, source_id, session_id, start_source_message_id, end_source_message_id))';
        ELSIF tbl = 'segment_targets' THEN
            native_payload := native_payload || ' AND reflection_native_payload_valid(payload, source_id, payload->>''session_id'', start_source_message_id, end_source_message_id)';
        END IF;
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', tbl, tbl || '_source_boundary_check');
        -- The old validated checks already cover existing legacy rows. Defer the
        -- replacement's table scan to operator preparation under a weaker lock.
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (
          (source_boundary_version IN (1,2) AND %s AND (%s)) OR
          (source_boundary_version = 3 AND end_user_message_id IS NULL
           AND source_id IS NOT NULL AND length(btrim(source_id)) > 0
           AND start_source_message_id IS NOT NULL AND length(btrim(start_source_message_id)) > 0 AND length(start_source_message_id) <= 500
           AND end_source_message_id IS NOT NULL AND length(btrim(end_source_message_id)) > 0 AND length(end_source_message_id) <= 500
           AND projection_version = 3 %s)) NOT VALID', tbl, tbl || '_source_boundary_check', legacy_users, old_check, native_payload);
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION reflection_source_fingerprint(
    source_id TEXT, session_id TEXT, start_user_message_id TEXT, end_user_message_id TEXT,
    source_boundary_version INTEGER, start_source_message_id TEXT, end_source_message_id TEXT, payload JSONB
) RETURNS CHAR(64) LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE frames TEXT; input TEXT;
BEGIN
    IF source_boundary_version IN (1,2) THEN
        RETURN reflection_source_fingerprint(session_id, start_user_message_id, end_user_message_id,
            source_boundary_version, start_source_message_id, end_source_message_id, payload);
    END IF;
    IF source_boundary_version IS DISTINCT FROM 3 OR source_id IS NULL
       OR start_user_message_id IS NOT NULL OR end_user_message_id IS NOT NULL
       OR NOT reflection_native_payload_valid(payload, source_id, session_id, start_source_message_id, end_source_message_id)
    THEN RETURN NULL; END IF;
    SELECT string_agg(octet_length(m->>'id')::text || ':' || (m->>'id') ||
        octet_length(m->>'type')::text || ':' || (m->>'type') ||
        octet_length(m->>'text')::text || ':' || (m->>'text'), '' ORDER BY n)
      INTO frames FROM jsonb_array_elements(payload->'messages') WITH ORDINALITY AS messages(m,n);
    input := 'reflection-source-v3:' || octet_length(source_id)::text || ':' || source_id ||
        octet_length(session_id)::text || ':' || session_id || '1:3' ||
        octet_length(start_source_message_id)::text || ':' || start_source_message_id ||
        octet_length(end_source_message_id)::text || ':' || end_source_message_id ||
        jsonb_array_length(payload->'messages')::text || ':' || frames;
    RETURN encode(sha256(convert_to(input, 'UTF8')), 'hex')::char(64);
END $$;

CREATE OR REPLACE FUNCTION reflection_projection_fingerprint(
    segment_id UUID, source_boundary_version INTEGER, end_user_message_id TEXT,
    end_source_message_id TEXT, summary TEXT, projection_version INTEGER
) RETURNS CHAR(64) LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE fingerprint_input TEXT;
BEGIN
    IF source_boundary_version = 1 THEN
        IF end_source_message_id IS NOT NULL THEN RETURN NULL; END IF;
        RETURN reflection_projection_fingerprint(segment_id, end_user_message_id, summary, projection_version);
    END IF;
    IF source_boundary_version NOT IN (2,3) OR end_source_message_id IS NULL THEN RETURN NULL; END IF;
    IF source_boundary_version = 3 AND end_user_message_id IS NOT NULL THEN RETURN NULL; END IF;
    fingerprint_input :=
        CASE WHEN source_boundary_version = 3 THEN 'reflection-projection-v3:' ELSE 'reflection-projection-v2:' END ||
        octet_length(segment_id::TEXT)::TEXT || ':' || segment_id::TEXT ||
        octet_length(source_boundary_version::TEXT)::TEXT || ':' || source_boundary_version::TEXT ||
        CASE WHEN source_boundary_version = 3 THEN '' ELSE octet_length(end_user_message_id)::TEXT || ':' || end_user_message_id END ||
        octet_length(end_source_message_id)::TEXT || ':' || end_source_message_id ||
        octet_length(summary)::TEXT || ':' || summary ||
        octet_length(projection_version::TEXT)::TEXT || ':' || projection_version::TEXT;
    RETURN encode(sha256(convert_to(fingerprint_input, 'UTF8')), 'hex')::CHAR(64);
END $$;
