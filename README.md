# Reflection

Reflection is an authenticated memory service that turns bounded OpenCode conversation ranges into durable, entity-resolved claims and recalls those claims with vector and graph search. The active implementation is a Node.js 24 pnpm monorepo with a Fastify server, PostgreSQL 17, and pgvector.

> Migration status: production still runs the Python revision `aa83637`. The Python package, tests, and packaging files remain in this repository only as a temporary rollback baseline until the Node production canary passes. Do not delete them yet, and do not run the Python server or any old plugin/backfill writer against a database after v2 source-span rows have been written.

## Monorepo layout

| Path                                                | Responsibility                                                                                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`                                   | Strict TypeBox HTTP contracts, deterministic identities and fingerprints, and the canonical OpenCode segmenter used by every TypeScript writer.           |
| `server`                                            | Fastify API, PostgreSQL migrations and persistence, extraction worker, model clients, and recall.                                                         |
| `plugin`                                            | OpenCode ingestion, context projection, `memory_search`, and exact local source hydration. Its stable deployable artifact is `plugin/dist/reflection.js`. |
| `scripts`                                           | Resumable OpenCode SQLite backfill. Its stable operational entry point is `scripts/backfill.mjs`.                                                         |
| `migrations`                                        | Ordered SQL migrations applied by the Node server at startup.                                                                                             |
| `src/reflection_service`, `tests`, `pyproject.toml` | Temporary Python rollback-only implementation. These files are not part of the Node image or normal pnpm checks.                                          |

## Source-span contracts

`source_boundary_version` describes source coverage. It is separate from `projection_version`, which describes summary projection safety.

| Contract | Identity and coverage                                                                                                                                                                                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1       | Legacy whole-turn coverage. `start_source_message_id` and `end_source_message_id` are `null`. A range starts and ends on user-message IDs and includes each complete OpenCode turn in that range. The deterministic segment UUID is derived from the session ID and starting user-message ID. |
| v2       | Exact inclusive intra-turn coverage. `start_user_message_id` must equal `end_user_message_id`, and both source-message cursors are required. The deterministic segment UUID is derived from the session ID and starting source-message ID, so one user turn can have multiple sibling spans.  |

The shared segmenter is the only source of new boundaries. It counts the complete model-visible representation, including visible text, reasoning, sanitized tool input/state/output, and conservative media reserves. Ordinary turns are packed into v1 ranges up to 20,000 weighted characters. Oversized turns use v2 spans and split only after a completed assistant message. A source message is never split: a single unsplittable message that exceeds the limit remains one oversized v2 span. If messages from different turns are interleaved, an oversized disjoint turn remains one v1 whole-turn range because exact v2 cursors cannot cross the intervening turn.

Committed boundaries and active targets are reconciled as a deterministic maximum-coverage, non-overlapping partition before uncovered history is segmented. Once a valid v2 anchor exists within a turn, every uncovered sibling range in that turn remains v2; it cannot silently fall back to a whole-turn v1 follow-up.

Segment UUIDs use fixed UUIDv5 namespaces. Source fingerprints use SHA-256 over a versioned, UTF-8 length-framed source identity and the ordered submitted role/text messages. Processing priority does not change source identity. Projection commit fingerprints bind the segment, exact end boundary, summary, and projection version. JavaScript and PostgreSQL implement the same framing so replay and migration checks are deterministic.

## Processing model

`POST /v1/segments` validates and stores a canonical request, updates the latest desired target for that exact source span, and returns a durable job with `202`. Reposting an unchanged source fingerprint is idempotent. A changed source snapshot advances its generation and fences stale work.

A PostgreSQL advisory lock elects one worker across all API replicas. Jobs are selected by `processing_priority` descending and then oldest desired target. Normal plugin ingestion and backfill use priority `0`; context projection foreground work uses priority `100`. Reposting the same exact source at a higher priority raises the retained target priority without changing its identity.

The worker has two durable phases:

1. Extraction produces a bounded summary and proposed claims. The result and a projection commit fingerprint are staged on the exact desired target.
2. Source-aware claim triage, entity resolution, and embeddings complete. One transaction commits the segment, resolved claims, entities, aliases, successful job state, and payload cleanup.

A staged summary can therefore appear in the session manifest while its job is still `running`. This is intentional so a foreground context transform can use the exact summary without waiting for entity resolution. A staged summary does not mean claims are available or the job succeeded. Use `GET /v1/jobs/{id}` for full job state; `GET /v1/segments/{id}` exposes only fully committed summaries and resolved claims.

Interrupted workers recover running jobs. Every attempt has a lease UUID, and staged extraction plus final resolution must still match the lease, generation, source fingerprint, projection version, and exact v1/v2 boundary. Stale work cannot commit after a target changes. Retryable model, network, schema, and resolution failures use the configured attempt budget. Deterministically invalid persisted input and oversized embedding input fail terminally.

Extraction and source-aware resolution currently use GPT-5.6 Luna through OpenRouter's OpenAI route with native strict JSON Schema. Voyage `voyage-4-large` supplies 1,024-dimensional embeddings. Source payloads remain only while a target is pending, running, or failed; successful completion clears duplicated transcript payloads. API responses never return stored source messages.

## Manifest and API

All `/v1` endpoints require `X-Api-Key`. `/healthz` is unauthenticated and verifies database connectivity. Fastify serves OpenAPI at `/openapi.json` and interactive documentation at `/docs`.

`GET /v1/sessions/{session_id}/segments` always returns `manifest_version: 2` with three separate arrays:

- `segments`: projection-eligible summaries. Entries may be fully committed summaries or exact fingerprint-guarded staged summaries.
- `boundaries`: every committed source boundary, including ineligible or superseded projections and its source fingerprint.
- `targets`: every current desired source span with source fingerprint and job status.

Clients must validate the manifest version, deterministic segment IDs, source cursors, and fingerprints rather than trusting array order.

### Queue an exact v2 span

```http
POST /v1/segments
X-Api-Key: ...
Content-Type: application/json

{
  "session_id": "ses_123",
  "start_user_message_id": "msg_user",
  "end_user_message_id": "msg_user",
  "source_boundary_version": 2,
  "start_source_message_id": "msg_user",
  "end_source_message_id": "msg_assistant_2",
  "projection_version": 1,
  "processing_priority": 100,
  "messages": [
    {"role": "user", "text": "I use PostgreSQL for Reflection."},
    {"role": "assistant", "text": "Understood."}
  ]
}
```

Requests that omit all three source-boundary fields are normalized to legacy v1. New plugin and backfill writers always send the canonical fields explicitly.

### Other endpoints

- `GET /v1/jobs/{id}` returns status, attempts, timestamps, exact source boundary, and a bounded error.
- `POST /v1/jobs/{id}/retry` resets a retryable terminal job and returns `202`.
- `GET /v1/segments/{uuid}` returns a committed summary and resolved claims without source text.
- `GET /v1/sessions/{session_id}/segments` returns the manifest described above.
- `POST /v1/search` accepts `{"query":"..."}` and returns grouped claims plus supporting segment IDs.

Recall embeds the query, ranks direct claim matches, expands through resolved subject and entity-object neighbors, groups equivalent claims, and reports segment/session support. Literal objects do not receive object-side graph expansion.

## Plugin projection

Context projection is disabled by default. When enabled, the plugin disables OpenCode native automatic compaction and replaces only an old model-visible prefix with a synthetic summary pair. OpenCode SQLite history is never rewritten. The retained raw tail is immutable: a checkpoint records its starting message and is reused without editing or regenerating that tail during ordinary assistant/tool loops.

Projection begins near 75% of usable model input and targets a raw tail near 25% of model context. Before a reset, the transform computes the canonical local spans, submits all required closed spans at foreground priority `100`, and waits up to 90 seconds for exact summaries. Extraction staging lets summaries become eligible before claim resolution finishes. If synchronization, polling, or summary coverage is still incomplete at the deadline, the transform keeps every available exact summary and produces an explicitly marked lossy fallback. Missing summaries never authorize a mismatched boundary. Projection fails only when no safe message-aligned retained tail can fit.

Manual `/compact` remains available and bypasses the Reflection transform. If a native/manual compaction already exists, its summary is inherited as prior context; native compaction markers are not ingested as user boundaries, and compacted tool output is not resurrected.

`memory_read_segment` fetches committed boundary metadata from Reflection and hydrates text from the local OpenCode session. v1 reads complete user turns. v2 resolves both source-message cursors and returns exactly that inclusive intra-turn span. Hydration fails closed if cursors are missing, ambiguous, reordered, or no longer available locally.

See `plugin/README.md` for plugin installation and the complete ingestion/projection behavior.

## Requirements and install

- Node.js 24.0 or newer within the Node 24 release line
- pnpm 10.33.0, pinned by `packageManager`
- PostgreSQL 17 with `vector` and `pg_trgm` for server or integration work
- Docker with Compose for the packaged deployment

From the repository root:

```bash
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm install --frozen-lockfile
```

The root lockfile is authoritative for every workspace package.

## Configuration

Copy `.env.example` to `.env` for local development or Compose and replace every placeholder. The Node server loads a root `.env` automatically. Do not commit credentials.

Required variables:

| Variable             | Purpose                                         |
| -------------------- | ----------------------------------------------- |
| `DATABASE_URL`       | PostgreSQL URL. URL-encode password characters. |
| `REFLECTION_API_KEY` | Expected `X-Api-Key` value.                     |
| `OPENROUTER_API_KEY` | Bearer key for extraction and resolution.       |
| `VOYAGE_API_KEY`     | Bearer key for embeddings.                      |

Model route, reasoning, schema mode, upstream URL, pool, worker, timeout, migration directory, and logging overrides are optional. Startup validates model/provider combinations, a 1,024-dimensional embedding configuration, and a pool of at least two connections because the elected worker retains one advisory-lock connection.

Provider pinning may be incompatible with OpenRouter zero-data-retention filters when a selected endpoint does not satisfy them. Voyage retention is controlled at the organization level. Review both providers' retention settings before sending sensitive transcripts.

## Local server

Start a local pgvector-enabled PostgreSQL instance, populate `.env` with local values, then run:

```bash
pnpm start
```

`pnpm start` rebuilds the Fastify bundle and launches `server/dist/main.js` from the repository root so the default `migrations/` path resolves correctly. The server listens on `0.0.0.0:8000`, applies checksummed migrations under an advisory lock, starts the elected extraction worker, and shuts down on `SIGINT` or `SIGTERM`. Compose gives the API 15 minutes to finish an in-flight extraction, resolution, and embedding sequence before forcing termination.

## Verify

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm verify:plugin-bundle
pnpm check
```

`pnpm check` runs formatting, type checking, unit tests, all workspace builds, and isolated plugin bundle verification in that order. Normal `pnpm test` explicitly excludes the PostgreSQL integration suite.

The integration suite requires an explicitly disposable pgvector database. It destroys Reflection tables in the supplied database. Never point it at development, staging, or production data.

```bash
docker run --rm -d --name reflection-test-postgres \
  -e POSTGRES_USER=reflection \
  -e POSTGRES_PASSWORD=reflection \
  -e POSTGRES_DB=reflection \
  -p 55432:5432 \
  pgvector/pgvector:pg17

REFLECTION_TEST_DATABASE_URL=postgresql://reflection:reflection@127.0.0.1:55432/reflection \
  pnpm test:integration

docker rm -f reflection-test-postgres
```

`pnpm test:integration` exits with an error before Vitest starts unless `REFLECTION_TEST_DATABASE_URL` is set.

## Docker and Compose

The multi-stage `Dockerfile` performs a frozen pnpm install, builds the Fastify bundle, deploys production dependencies, and copies `migrations/` into a slim Node 24 runtime. The runtime uses the image's unprivileged `node` user and includes a `/healthz` health check.

For Compose, prepare `.env`, ensure the PostgreSQL bind path exists and is writable, then run:

```bash
docker compose config
docker compose up --build --wait
```

The default PostgreSQL path is `/srv/reflection/postgres` for Dokploy. Set `POSTGRES_DATA_PATH` to another absolute host path for a local deployment. Compose waits for PostgreSQL before starting the API and reports API health through `/healthz`. The database role needs permission to create `vector` and `pg_trgm` on first boot.

## Plugin bundle

Build and verify the stable single-file artifact from the repository root:

```bash
pnpm --filter opencode-reflection-plugin build
pnpm verify:plugin-bundle
install -d ~/.config/opencode/plugins
install -m 0644 plugin/dist/reflection.js ~/.config/opencode/plugins/reflection.js
```

The copied bundle is self-contained and does not depend on this checkout or its `node_modules`. Restart OpenCode after replacing it. During the production cutover, do not start OpenCode with this bundle until the v2-capable server is healthy.

## Backfill

`scripts/backfill.mjs` is the stable Node 24 launcher. It registers Node's TypeScript hooks and starts `scripts/src/backfill.ts` without depending on a transient build output. Run it from the repository root:

```bash
node scripts/backfill.mjs --dry-run
node scripts/backfill.mjs
```

The backfill reads OpenCode SQLite from `~/.local/share/opencode/opencode.db`, service credentials from `~/.config/opencode/reflection.json`, and atomically stores resumable state under `~/.local/state/reflection-backfill/`. `OPENCODE_DATABASE_PATH` and `REFLECTION_BACKFILL_STATE_DIR` override the local paths. A mode-`0600` PID lock prevents concurrent workers.

Sessions are processed newest first, but spans within a session remain chronological. The launcher waits for ten minutes of session inactivity, snapshots message and part JSON, rechecks the SQLite revision before and throughout network/job waits, and replans if either local history or the server target changes. Backfill uses priority `0`, waits for each job before submitting the next span, retries provider-balance failures conservatively, and skips exact successful fingerprints idempotently. `REFLECTION_BACKFILL_PRIORITY_JOB_IDS` can retain specific already-created foreground jobs across a supervised restart.

An authoritative dry run reads `manifest_version: 2`, validates deterministic IDs, and reports eligible, stale, pending, conflicting, and new spans without writing local state or server targets.

## Production cutover

Migration `006_canonical_source_spans.sql` is a forward-only writer boundary. Use a stop-first deployment; never perform a rolling Python/Node or old/new plugin rollout.

1. Build and verify the Node server, `plugin/dist/reflection.js`, and `scripts/backfill.mjs` from the same revision.
2. Stop the old backfill supervisor and confirm no backfill process remains.
3. Stop every OpenCode process loading the old plugin, then remove or disable its installed bundle so it cannot restart as a writer.
4. Stop every old Python API/worker replica before any Node server can run migration `006`.
5. Take and verify a restorable database backup while all writers are stopped. Record the deployed Python image/revision `aa83637` and its configuration for rollback.
6. Deploy the Node image. Let it apply migrations, then require a healthy `/healthz` and a session response with `manifest_version: 2` before enabling any client.
7. Install the v2 bundle at `~/.config/opencode/plugins/reflection.js` while OpenCode remains stopped.
8. Run two authoritative dry runs against the same stopped-writer snapshot and require byte-identical output:

```bash
node scripts/backfill.mjs --dry-run > /tmp/reflection-dry-run-1.json
node scripts/backfill.mjs --dry-run > /tmp/reflection-dry-run-2.json
cmp /tmp/reflection-dry-run-1.json /tmp/reflection-dry-run-2.json
```

9. Start one canary OpenCode client. Force an oversized turn with multiple completed assistant messages and verify same-user v2 sibling spans with distinct exact source cursors, no later whole-turn v1 follow-up for that turn, and exact `memory_read_segment` hydration for each sibling. Also require its foreground jobs to reach `succeeded` and expose fully resolved claims after any early staged summary.
10. Resume the TypeScript backfill, then enable the v2 plugin for the remaining OpenCode clients. Monitor failed jobs, target drift, projection-loss warnings, and backfill state before declaring the canary complete.

Once any v2 row exists, old Python, plugin, and backfill binaries cannot safely write to that database. If the Node deployment fails after migration, keep all writers stopped and either fix forward with v2-capable code or restore the pre-migration backup as a coordinated full rollback before starting `aa83637`. Starting only the old binary against the migrated database is not a rollback.

After the Node production canary passes and the rollback window closes, remove the Python rollback files in a separate change. Until then, their presence is intentional.
