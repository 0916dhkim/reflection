# Reflection

Reflection is a small authenticated HTTP service that turns bounded conversation ranges into durable,
entity-resolved claims and retrieves those claims with vector plus graph recall. It runs on Python 3.13,
FastAPI, PostgreSQL 17, and pgvector.

## Processing model

`POST /v1/segments` stores the complete request in a durable FIFO job, records the latest desired snapshot
for that deterministic segment, and returns `202` immediately. A single worker is elected with a PostgreSQL
advisory lock, so multiple API replicas cannot process jobs concurrently. The elected worker resets
interrupted `running` jobs to `pending` when it acquires the lock and always claims the oldest pending
identity value. If the desired snapshot changes while an older job is running, the same transaction that
finishes the older extraction durably requeues the desired range/version. Each claim attempt receives a new lease UUID;
success, failure, and automatic requeue writes must match that lease, so work from a fenced-out worker
cannot commit after recovery.

For each job the worker:

1. Loads every prior stored summary for the session, without an application-level cap, while excluding
   the current deterministic segment so a mutable tail does not use its own old snapshot as context.
2. Calls the configured OpenRouter-compatible extraction model with low reasoning. The strict result is
   a summary of at most 1000 characters and claims with a confidence from 0 to 1, an entity subject, and
   exactly one entity object or literal value. Source grounding is a model instruction and best-effort
   property, not a separately validated guarantee. Extraction favors the most specific independently
   referable subject, keeps named plans/products/projects/policies as entities, emits short natural-language
   predicates rather than snake case, and preserves units and qualifiers in literal values.
3. Creates a separate endpoint occurrence for every entity subject and entity object. It embeds each
   occurrence together with its supporting claim and segment summary using Voyage `voyage-4-large` at
   1024 dimensions, then retrieves the union of at most five indexable pg_trgm name/alias candidates and
   five vector candidates. Literal values do not enter entity resolution.
4. Calls the configured OpenRouter-compatible resolution model once with all proposed claims,
   occurrences, candidate names and descriptions, and the segment summary using high reasoning. The model
   keeps or drops every proposed claim before resolving entities. Kept claims are stored unchanged;
   session-only claims and context-dependent claims that were not already stated against a stable named
   context are dropped. This prevents PR- or rollout-specific dependencies from becoming universal graph
   edges.
   Identical text occurrences can resolve differently and different real entities receive distinguishable
   canonical names. Newly proposed identical canonical names coalesce to the same deterministic entity UUID
   within the segment.
5. Embeds only kept claims and their new canonical entities as documents with Voyage. Candidate retrieval
   happens before joint triage and resolution, so entity mentions from all proposed claims receive temporary
   query embeddings; dropped claims create no persisted entities, graph edges, or document embeddings.
6. In one PostgreSQL transaction, upserts new entities, descriptions, and aliases, replaces the segment
   and claims, marks the leased job successful, and clears its source payload. No extraction data is
   written if a network call or model/schema validation fails.

Model requests are pinned to OpenRouter's official `deepseek` provider with fallbacks disabled. Reflection
places the complete schema in a system message, requests one JSON object, and validates every property
locally. Network, model, schema, and
entity-resolution validation failures all retry up to three attempts with a short configurable backoff
because another model call may succeed. An invalid persisted job payload is terminal at claim time, and a
generated embedding input over 30,000 UTF-8 bytes is terminal because retrying cannot reduce it. A delayed
oldest job continues to block newer jobs, preserving FIFO. Operators can explicitly reset a terminal job
with authenticated `POST /v1/jobs/{id}/retry`.

Extraction output is capped at 25 claims and 16,384 completion tokens; entity resolution is capped at
32,768 completion tokens. The token budgets include hidden reasoning as well as visible JSON. Every model
call also has a 180-second wall-clock deadline independent of
HTTPX's per-operation timeout. Completion logs record timing, finish reason, token count, and content size
without recording model input or output text.

Some compatible providers append a second value or text after an otherwise valid structured JSON value.
Reflection validates and uses only the first JSON value and logs the ignored trailing character count,
never the trailing content. Invalid model output is reported without including source or response text in
exception traces.


Voyage requests set `truncation=false`. Inputs are rejected above 30,000 UTF-8 bytes and requests are
partitioned below both 128 inputs and 100,000 UTF-8 bytes. Byte limits are intentionally conservative
upper bounds for the provider's token limits and avoid a tokenizer dependency.

The model schemas contain no evidence or quote field. Source messages remain in the local PostgreSQL job
payload while pending, running, or failed. A transient desired-snapshot row also retains the latest submitted
payload only while a running or queued extraction must converge to it. The successful desired commit clears
the job payload and desired row so completed transcripts are not duplicated; a terminal failure also clears
a desired row when the already-committed projection-safe segment proves it is satisfied. Messages are never returned by segment or search endpoints. Recall returns
segment IDs only; any source-message hydration is explicitly local-only work for the caller and is not
performed by this service.

## API

All `/v1` endpoints require `X-Api-Key`. `/healthz` is intentionally unauthenticated and checks database
connectivity.

### Queue a segment

```http
POST /v1/segments
X-Api-Key: ...
Content-Type: application/json

{
  "session_id": "session-1",
  "start_user_message_id": "message-10",
  "end_user_message_id": "message-20",
  "projection_version": 1,
  "messages": [
    {"role": "user", "text": "I use PostgreSQL for Reflection."},
    {"role": "assistant", "text": "Understood."}
  ]
}
```

The segment UUID is UUIDv5-derived from `session_id` and `start_user_message_id`. Queue identity uses the
`session_id`/start/end range. Reposting an exact current snapshot returns the original job; a higher projection
version or a history rewind to a previously replaced end boundary requeues that identity with the submitted
payload. A different end ID creates a new FIFO job for the same deterministic segment. This preserves binary
rollback compatibility while supporting mutable tails and safe re-extraction. Lower-version jobs cannot
overwrite a newer projection-safe segment. `projection_version` defaults to `0`. During migration, context
projection uses committed summaries from both versions while version `1` ingestion replaces version `0`
incrementally.

Message text may be empty. A single message may contain up to 1,000,000 characters, while the aggregate
text across a segment is limited to 2,000,000 characters. This permits one unusually large turn without
allowing an unbounded many-message payload.

### Inspect results

- `GET /v1/jobs/{id}` returns queue state, attempts, timestamps, and a bounded error string.
- `POST /v1/jobs/{id}/retry` resets a terminal failed job's attempt budget and returns `202`.
- `GET /v1/segments/{uuid}` returns metadata, summary, and resolved claims, but no source messages.
- `GET /v1/sessions/{session_id}/segments` returns committed version `0` and version `1` segment IDs, boundaries, versions, and summaries in creation order for authenticated context projection clients.
- `POST /v1/search` accepts `{"query":"..."}`.

An old failed mutable-tail snapshot cannot be explicitly retried after any newer job exists for the same
segment, preventing the old snapshot from overwriting the newer tail.

Recall embeds the query, takes the top 10 vector claims, expands through each direct claim's subject and
entity object with at most 10 neighboring claims per entity, and orders each entity's neighbors by their
own query cosine similarity. Graph scores combine that similarity, the originating direct similarity, and
claim confidence; direct results always rank ahead of graph-only results. Literal objects have no
object-side graph expansion. Equivalent claims are grouped with distinct segment and session support
counts. Distinct-session support adds a small score boost capped at 0.1. At most 20 groups are returned,
and each result contains claim data including confidence, resolved entity IDs, score, support counts, and
contributing segment IDs.

## Configuration

Copy `.env.example` to `.env` for local Compose use and replace every secret. Secrets are read only from
environment variables; do not put production values in Compose or source control.

Required variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | psycopg PostgreSQL URL; URL-encode password characters |
| `REFLECTION_API_KEY` | expected `X-Api-Key` value |
| `OPENROUTER_API_KEY` | bearer key for structured model calls |
| `VOYAGE_API_KEY` | bearer key for direct Voyage embedding calls |

The model and upstream URL variables shown in `.env.example` are optional. The service validates that
the embedding dimension remains 1024 and that the connection pool has at least two connections because
the elected worker holds one connection for its advisory lock. `WORKER_MAX_ATTEMPTS` defaults to `3`,
and `WORKER_RETRY_BACKOFF_SECONDS` defaults to `2`.

### Data retention prerequisite

Provider pinning is incompatible with OpenRouter's zero-data-retention filter because the official
DeepSeek endpoint is categorized as allowing paid-model training. Voyage retention is also controlled at
the organization/account level. Operators should review both providers' retention settings before sending
sensitive transcripts.

## Run

```bash
docker compose up --build
```

The Dokploy-oriented Compose file binds PostgreSQL data to `/srv/reflection/postgres`. Ensure that path
exists and is writable by the container's PostgreSQL user before deployment. The API runs idempotent SQL
from `migrations/` at startup; the database role therefore needs permission to create the `vector` and
`pg_trgm` extensions on first boot.

For local development without Compose:

```bash
python3.13 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/uvicorn reflection_service.main:app --reload
```

## Verify

```bash
.venv/bin/ruff format --check .
.venv/bin/ruff check .
.venv/bin/mypy src
.venv/bin/pytest
```

Set `REFLECTION_TEST_DATABASE_URL` to a disposable pgvector-enabled PostgreSQL database to include the
integration test. The test truncates all Reflection tables in that database.

## Backfill

`scripts/backfill.mjs` reads the local OpenCode SQLite database and submits stable sessions newest first.
Segments within each session remain chronological. It processes one segment to a terminal state before
submitting the next, so pending transcript payloads do not accumulate in PostgreSQL. Existing successful
jobs are skipped through the service's
idempotent segment API. A stale provider `402` receives one immediate retry; repeated `402` failures wait
five minutes before retrying through Reflection, ensuring the readiness check uses the deployed service's
credentials and configured models. Other terminal failures receive one explicit retry and are recorded
before the worker continues.
Sessions updated within the last ten minutes are deferred and rechecked after other stable sessions.

Backfill submissions use projection version `1` and the same hidden-text, attachment-metadata, successful-turn,
and unanswered-turn barrier rules as the live plugin. After deploying the migration, stop the version `0`
worker and run the upgraded backfill. Projection may be activated after a mixed-version smoke test and uses
version `0` summaries until each segment is replaced by version `1`.

The worker reads service credentials from `~/.config/opencode/reflection.json`. Progress is atomically
stored in `~/.local/state/reflection-backfill/state.json`, and a PID lock prevents concurrent workers. Run
a source inventory without submitting anything using:

```bash
node scripts/backfill.mjs --dry-run
```

Run the resumable backfill with:

```bash
node scripts/backfill.mjs
```

For unattended operation, run it under a supervisor that uses an absolute Node path and working directory,
stores stdout and stderr durably, and restarts only after nonzero exits. Restarts scan from the newest
session again, but successful segment submissions are skipped idempotently.

When `REFLECTION_BACKFILL_LAUNCHD_LABEL` and `REFLECTION_BACKFILL_LAUNCHD_PLIST` are set, successful
completion starts a detached cleanup helper that removes the plist and unloads the LaunchAgent. Failed runs
leave the supervisor installed so it can restart. Terminal completion includes segments whose model output
remained invalid after all retries; those failures remain recorded in the progress state. The helper
confirms the service is unloaded before deleting its plist and requests another run if cleanup fails.
Cleanup results are written beside the progress state.
