# Reflection

Reflection is an authenticated memory service that turns bounded OpenCode conversation ranges into durable, entity-resolved claims and recalls those claims with vector and graph search. The active implementation is a Node.js 24 pnpm monorepo with a Fastify server, PostgreSQL 17, and pgvector.

> Production runs the Node.js/Fastify implementation. The TypeScript cutover and canary are complete, and production was healthy at revision `697b42a` on 2026-08-24. The Python package, tests, and packaging files remain only as a rollback baseline pending an explicit deletion decision. Never run the old Python server or old plugin/backfill writers against a database containing v2 source-span rows.

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

`projection_version: 1` is the ordinary text projection contract. Version `2` identifies the bounded sanitized tool fallback used when a span has no ordinary text; it is an application compatibility fence stored in the existing integer column, not a new source-boundary or SQL migration version. Once a span has a persisted version-2 anchor, rebuilt snapshots remain version 2 even if ordinary text later appears.

| Contract | Identity and coverage                                                                                                                                                                                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1       | Legacy whole-turn coverage. `start_source_message_id` and `end_source_message_id` are `null`. A range starts and ends on user-message IDs and includes each complete OpenCode turn in that range. The deterministic segment UUID is derived from the session ID and starting user-message ID. |
| v2       | Exact inclusive intra-turn coverage. `start_user_message_id` must equal `end_user_message_id`, and both source-message cursors are required. The deterministic segment UUID is derived from the session ID and starting source-message ID, so one user turn can have multiple sibling spans.  |

The shared segmenter is the only source of new boundaries. It counts the complete model-visible representation, including visible text, reasoning, sanitized tool input/state/output, and conservative media reserves. Ordinary turns are packed into v1 ranges up to 20,000 weighted characters. Oversized turns use v2 spans and split only after a completed assistant message. A source message is never split: a single unsplittable message that exceeds the limit remains one oversized v2 span. If messages from different turns are interleaved, an oversized disjoint turn remains one v1 whole-turn range because exact v2 cursors cannot cross the intervening turn.

Committed boundaries and active targets are reconciled as a deterministic maximum-coverage, non-overlapping partition before uncovered history is segmented. Once a valid v2 anchor exists within a turn, every uncovered sibling range in that turn remains v2; it cannot silently fall back to a whole-turn v1 follow-up.

Segment UUIDs use fixed UUIDv5 namespaces. Source fingerprints use SHA-256 over a versioned, UTF-8 length-framed source identity and the ordered submitted role/text messages. Processing priority does not change source identity. Projection commit fingerprints bind the segment, exact end boundary, summary, and projection version. JavaScript and PostgreSQL implement the same framing so replay and migration checks are deterministic.

## Processing model

`POST /v1/segments` validates and stores a canonical request, updates the latest desired target for that exact source span, and returns a durable job with `202`. Reposting an unchanged source fingerprint is idempotent. A changed source snapshot advances its generation and fences stale work.

A PostgreSQL advisory lock elects one worker across all API replicas. Jobs are selected by `processing_priority` descending and then oldest desired target. Backfill and inactive-session sweeps use priority `0`, active-session idle ingestion uses priority `50`, and blocking context projection uses priority `100`. Reposting the same exact source at a higher priority raises the retained target priority without changing its identity.

The worker dispatches up to `WORKER_CONCURRENCY` (default `4`) jobs concurrently while claiming sequentially on a single reserved advisory-lock connection and enforcing at most one in-flight job per session. The worker has two durable phases:

1. Extraction produces a trimmed, nonempty summary of at most 1,000 characters and proposed claims. The result and a projection commit fingerprint are staged on the exact desired target. Legacy empty committed summaries remain readable so backfill can replace them safely. Extraction runs concurrently across sessions.
2. Source-aware claim triage, entity resolution, and embeddings complete. Claim-bearing resolution serializes through a process-local resolution lane to prevent duplicate entity creation, while claim-free segments commit concurrently. One transaction commits the segment, resolved claims, entities, aliases, successful job state, and payload cleanup.

A staged summary can therefore appear in the session manifest while its job is still `running`. This is intentional so a foreground context transform can use the exact summary without waiting for entity resolution. A staged summary does not mean claims are available or the job succeeded. Use `GET /v1/jobs/{id}` for full job state; `GET /v1/segments/{id}` exposes only fully committed summaries and resolved claims.

Interrupted workers recover running jobs. Every attempt has a lease UUID, and staged extraction plus final resolution must still match the lease, generation, source fingerprint, projection version, exact v1/v2 boundary, and current deterministic-validation version. Staged output from an older validation policy is re-extracted instead of reused or projected. Stale work cannot commit after a target changes. Retryable model, network, schema, and resolution failures use the configured attempt budget. Deterministically invalid persisted input and oversized embedding input fail terminally.

Extraction and source-aware resolution currently use GPT-5.6 Luna through OpenRouter's OpenAI route with native strict JSON Schema. Voyage `voyage-4-large` supplies 1,024-dimensional embeddings. Source payloads remain only while a target is pending, running, or failed; successful or superseded completion clears duplicated transcript payloads. API responses never return stored source messages.

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

When a source span has no visible text, writers submit bounded renderer-canonical tool fallback text.

### Other endpoints

- `GET /v1/queue` returns historical job and current target counts, due and delayed pending work, bounded running-job ages, sanitized current-target error categories split between retrying and terminal work, and current terminal-job counts over 5-minute, 1-hour, and 24-hour windows. Because retries mutate job rows, the windows are a current-state drain signal rather than append-only attempt history. The endpoint never returns source payloads or raw errors.
- `GET /v1/jobs/{id}` returns status, attempts, timestamps, exact source boundary, and a bounded error.
- `POST /v1/jobs/{id}/retry` resets an exact current terminal failed job to pending and wakes the extraction worker, returning `202`. Any eligible staged extraction result on the matching current target is preserved so work resumes directly at entity resolution.
- `POST /v1/jobs/{id}/restart` resets an exact current terminal failed job to pending and wakes the extraction worker, returning `202`. Unlike retry, restart atomically clears staged extraction results and validation fingerprints on the current target so the worker performs a completely fresh extraction from the original source payload.
- `POST /v1/jobs/{id}/supersede` marks an exact current terminal failed job as `superseded`, clears its payload, sets `error = 'snapshot was superseded'`, and deletes the exact matching row from `segment_targets`, returning `200`. This endpoint does not wake the worker and never deletes committed segments. It is strictly intended for operators when an authoritative local source planner proves an exact current failed target is obsolete and will never be generated again under current segmentation rules, clearing poisoned targets from session manifests.
- `GET /v1/segments/{uuid}` returns a committed summary and resolved claims without source text.
- `GET /v1/sessions/{session_id}/segments` returns the manifest described above.
- `POST /v1/search` accepts `{"query":"..."}` and returns grouped claims plus supporting segment IDs.

Recall embeds the query, ranks direct claim matches, expands through resolved subject and entity-object neighbors, groups equivalent claims, and reports segment/session support. Literal objects do not receive object-side graph expansion.

## Plugin projection

Context projection is disabled by default. When enabled, the plugin disables OpenCode native automatic compaction and replaces only an old model-visible prefix with a synthetic summary pair. OpenCode SQLite history is never rewritten. The retained raw tail is immutable: a checkpoint records its starting message and is reused without editing or regenerating that tail during ordinary assistant/tool loops.

Projection begins near 75% of usable model input and targets a raw tail near 25% of model context. Before a reset, the transform computes the canonical local spans, submits all required closed spans at foreground priority `100`, and waits up to 90 seconds for exact summaries. Extraction staging lets summaries become eligible before claim resolution finishes. If synchronization, polling, or summary coverage is still incomplete at the deadline, the transform keeps every available exact summary and produces an explicitly marked lossy fallback. Missing summaries never authorize a mismatched boundary. Projection fails only when no safe message-aligned retained tail can fit.

Request-pressure accounting is necessarily approximate. OpenCode's message-transform hook runs before OpenCode adds final instruction files, MCP content, resolved tool schemas, later plugin transforms, and provider-specific rewrites. Reflection measures the message payload available at the hook and reserves additional capacity, but it cannot enforce an absolute final-request bound without a new OpenCode seam that exposes the assembled provider request.

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

Model route, reasoning, schema mode, upstream URL, pool, worker concurrency/polling/retry, timeout, migration directory, and logging overrides are optional. Startup validates model/provider combinations, a 1,024-dimensional embedding configuration, and a pool of at least two connections because the elected worker retains one advisory-lock connection.

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
  -e POSTGRES_DB=reflection_test \
  -p 127.0.0.1:55432:5432 \
  pgvector/pgvector:pg17

REFLECTION_TEST_DATABASE_URL=postgresql://reflection:reflection@127.0.0.1:55432/reflection_test \
  pnpm test:integration

docker rm -f reflection-test-postgres
```

`pnpm test:integration` requires a loopback `REFLECTION_TEST_DATABASE_URL` whose database name contains `test` or `disposable`, with no query overrides. It builds both plugins and runs the database suite followed by the dual-plugin integration test sequentially. That test activates the actual bundles in isolated HOME directories against one real PostgreSQL backend; only the OpenCode hosts, extraction engine, and embeddings are fixtures.

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

The copied bundle is self-contained and does not depend on this checkout or its `node_modules`. Restart OpenCode after replacing it. Before installing a writer from a newer contract revision, require the server to advertise support for that revision and remain healthy.

## Backfill

`scripts/backfill.mjs` is the stable Node 24 launcher. It registers Node's TypeScript hooks and starts `scripts/src/backfill.ts` without depending on a transient build output. Run it from the repository root:

```bash
node scripts/backfill.mjs --dry-run
node scripts/backfill.mjs
node scripts/backfill.mjs --allow-failures
```

The backfill reads OpenCode SQLite from `~/.local/share/opencode/opencode.db`, service credentials and the required stable `sourceId` from `~/.config/opencode/reflection.json`, and atomically stores resumable state under `~/.local/state/reflection-backfill/`. `sourceId` is trimmed and must be a nonblank string of at most 500 characters; Reflection does not infer a v1 default. All ingestion mutations, including retries, send it as `source_id`. `OPENCODE_DATABASE_PATH` and `REFLECTION_BACKFILL_STATE_DIR` override the local paths. `REFLECTION_MAX_MUTABLE_SOURCE_DEFERRAL_MS` overrides the 24-hour safe-deferral window. A mode-`0600` PID lock prevents concurrent workers.

Sessions are processed newest first, but spans within a session remain chronological. The launcher waits for ten minutes of session inactivity, snapshots message and part JSON, rechecks the SQLite revision before and throughout network/job waits, and replans if either local history or the server target changes. Open v2 spans ending on a user or unfinished assistant remain deferred; after 24 hours from the latest observed revision, backfill records them as safely skipped failures without submitting them. Backfill uses priority `0`, waits for each job before submitting the next span, retries provider-balance failures conservatively, and skips exact successful fingerprints idempotently. `REFLECTION_BACKFILL_PRIORITY_JOB_IDS` can retain specific already-created foreground jobs across a supervised restart.

Runs with failures return nonzero and retain LaunchAgent supervision. After reviewing the recorded failures, `--allow-failures` explicitly accepts them and permits cleanup on the next run. Dry runs return nonzero when manifests are invalid or mutable-source skips have expired.

An authoritative dry run reads `manifest_version: 2`, validates deterministic IDs, and reports eligible, stale, pending, conflicting, and new spans without writing local state or server targets.

## Production cutover and rollback

The stop-first Node cutover and production canary are complete. The checklist remains the authoritative procedure for recreating or auditing that boundary; it is not a pending rollout plan.

Migrations `006_canonical_source_spans.sql` and `008_extraction_validation.sql` are forward-only writer boundaries. Migration 008 rejects extraction writes from an older Node server, and an older server's `/healthz` does not detect that incompatibility. Stop every old API/worker replica before a new replica applies either migration; after migration 008, rollback requires fixing forward or restoring the pre-migration database backup. Migration `007_superseded_job_status.sql` exposes discarded extraction work as `superseded` instead of reporting false success. Use a stop-first deployment; never perform a rolling Python/Node, old/new Node, or old/new plugin rollout. Any change to submitted source rendering or fingerprint framing is also a stop-first writer boundary even when its projection version is unchanged: stop backfill and every plugin writer, build both writers from the same revision, install them together, and only then resume. Mixed source renderers can otherwise alternate fingerprints and target generations for the same span.

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

The Node production canary has passed. Removing the Python rollback files remains a separate explicit decision; until then, their presence is intentional.

### CP005/006 source ownership preparation

**No production rollout until CP007.** The historical stop-first checklist above is not authorization to deploy this source-aware revision. Plain `pnpm start` is not sufficient on an unprepared database: startup rejects missing source-aware indexes or retained global boundary indexes.

For an explicitly approved environment, run the operator commands from an installed Node 24 checkout with `DATABASE_URL` exported securely (and the same `MIGRATION_LOCK_ID` as the server, if overridden):

The supported container deliverable is the explicit `source-operator` target:

```bash
docker build --target source-operator -t reflection-source-operator .
docker run --rm --read-only --network none reflection-source-operator --help
```

This target retains the server/shared sources and installed dependencies, runs as `node`, and defaults to operator help. It starts no API or worker; the default final `runtime` target is unchanged and does not contain the operator. For approved database operations, supply `DATABASE_URL` securely and attach the operator to the approved database network, replacing `--help` with the action and arguments below (not `node scripts/source-ownership.mjs`). Migrations are packaged at `/app/migrations`; pass `MIGRATION_LOCK_ID` if overridden on the server. No endpoint or credential is embedded in the image.

The image deliverable does not authorize production execution or require direct managed-database access from the assistant. CP008 must still coordinate credentials, network access, writer shutdown, and operator execution through documented deployment controls.

1. Run `node scripts/source-ownership.mjs expand`. This uses the server's checksummed transactional migration runner without starting an API or worker. On a database already at migration008, expansion009 preserves old-writer compatibility; earlier pending migrations retain their own stop-first requirements.
2. Register each source explicitly: `node scripts/source-ownership.mjs register --id LEGACY_ID --kind opencode-v1 --identity-scheme legacy`, and similarly register new sources using `--kind opencode-v2 --identity-scheme source-v1`. Expansion never inserts sources automatically.
3. Run `node scripts/source-ownership.mjs install-indexes` to build and verify source-aware indexes concurrently.
4. Stop all old writers, then run `node scripts/source-ownership.mjs cutover --old-writers-stopped`. This removes only the superseded global boundary indexes, not UUID primary keys or claims foreign keys.
5. Start the source-aware backend and compatible clients only after the preceding preparation and the CP007 rollout gate.
6. Run `node scripts/source-ownership.mjs backfill --legacy-source LEGACY_ID --batch-size 100`, then `node scripts/source-ownership.mjs enforce --old-writers-stopped` after confirming old writers remain stopped and ownership is complete.

All operator actions serialize on the migration advisory lock with a five-second lock wait. Concurrent index builds have a 30-minute statement timeout; timed-out operations are retryable after inspecting contention. `MIGRATIONS_DIR` optionally overrides the expansion migration directory. Expansion, index installation, cutover, and enforcement are separate phases; do not use a failing application startup as the expansion mechanism.

### Disposable rollout rehearsal (CP007)

From the repository root, with Docker available:

```bash
pnpm test:rollout-rehearsal --new 64ff248
```

The old revision is pinned to `8187636`; `--new` defaults to committed `HEAD`. Uncommitted application changes are deliberately excluded. The runner archives each revision independently, builds its real API/worker and plugin, and records source trees, artifact hashes, dependency inputs, migrations and image identities. Only the provider engine/embeddings and OpenCode SDK are synthetic. Builds need registry access; execution uses an internal Docker network, disposable PostgreSQL, isolated HOME directories, no host mounts or published ports, and no production credentials. Containers/network are cleaned up on success or failure. Reports and build logs remain under the printed OS-temp path.

The scenario exercises old-compatible expansion, mixed-client refusal, interrupted concurrent indexes, graceful and forced worker shutdown, staged-result reuse, paired history reads, concurrent ingestion during interrupted backfill, repeated enforcement, and restores into separate databases. It verifies original source rows and final enforcement preserve data, rather than checking counts alone.

The synthetic HTTP outage budget is five seconds, including a two-second stop grace and the fixture cutover backup. This is **not a production-scale timing guarantee**. The current Compose default is fifteen minutes: CP008 must configure a supported short stop timeout matching the tested policy, or separately verify an API-available drain procedure. Old SQL writers must be gone before cutover; the command-line confirmation does not discover them.

Recovery after cutover should prefer completing the source-aware rollout. The tested cutover-boundary backup preserves all work accepted before that snapshot, including active/staged/pending jobs, but does not preserve later writes. Do not automatically downgrade or restore an older backup after new writes: CP008 must preserve/replay those writes or use a sufficiently current recovery point. The initial older baseline restore is only a point-in-time rollback demonstration.

### Native OpenCode v2 implementation (CP009–011)

Native manifests use **version 3**; legacy manifests remain version 2. A manifest cannot mix native and legacy boundary entries. Native source fingerprints explicitly frame the rendering-policy version separately from the boundary version; neither priority nor JSON property order participates in content identity.

The separate plugin builds to `packages/opencode-v2-plugin/dist/reflection-v2.js`. It targets OpenCode **2.0.8**, not the v1 plugin API. Do not replace the running v1 bundle or install both artifacts in the same discovery directory. Production activation remains gated on CP008 and final dual-instance readiness.

The native plugin requires an explicit absolute `options.configPath` to an isolated Reflection JSON configuration containing `url`, `apiKey`, `sourceId`, `sources`, and `contextProjection: { enabled: true }`. Its own registered source must be `opencode-v2` / `source-v1`. Load the artifact through a plugin directory containing `index.js`, as exercised by the runtime probe. Set native `compaction.auto: false`; the plugin validates normalized, location-scoped configuration and separately vetoes native compaction hooks. Invalid configuration cannot silently disable Reflection and restore native compaction.

Native boundary **3** stores exact consecutive source-message ranges with typed `{id,type,text}` provenance and no invented user boundaries. It uses projection/rendering policy **3**; legacy boundary1/2 identities and hashes are unchanged. Completed messages are packed against a soft size target; oversized messages stay intact, and incomplete records are not finalized. Background job completion is a later synthetic message, not a reason to hold its completed launch acknowledgment open. Binary media uses explicit source descriptors; projection carries renderer-omission notices. Hydration returns policy-rendered text, not original attachment bytes or omitted reasoning.

Migration010 leaves replacement checks `NOT VALID` during short expansion DDL. `install-indexes` validates them in separate statements and builds the two new native-v3 indexes concurrently. Strict backend startup requires validation/index preparation. This is implementation code, not permission to run production migration early.

Projection archives only verified complete source ranges, preserves complete tool exchanges and raw-tail references, and restores the latest actual user input verbatim when it lies in the archived prefix. Version-2 checkpoints retain bounded verified summaries and frozen ranges through service outages only when current source proofs still match. Genuinely unavailable summaries produce explicit bounded omission notices where a safe context fits; impossible contexts fail closed. Image inputs are retained with a conservative estimation reserve. Unbounded non-image media, top-level provider-native payloads, or ambiguous source mappings fail explicitly rather than being silently dropped. Ordinary provider metadata is preserved and budgeted. Estimates are not a proof of final provider token count or a claim of all-provider compatibility.

The SDK does not supply native abort signals to Promise callbacks. Plugin-owned operations have bounded deadlines and are cancelled on observed terminal/deletion events; underlying non-abortable SDK calls can still finish after cancellation. Checkpoint/source verification prevents trusting stale state. Retry delivery uses authoritative job reconciliation and best-effort at-most-one confirmed retry, not an exactly-once network guarantee.

`pnpm check` verifies both bundles. `pnpm test:opencode-v2` runs the original isolated API probe and the actual native Reflection bundle against the published binary with a synthetic Reflection HTTP service and provider. It checks native tool execution, priority-50 idle ingestion, foreground projection, source fingerprints, actual-user preservation, pending/unavailable summaries, native-compaction refusal, background completion, partial-stream interruption, and image input. Real PostgreSQL tests separately exercise the native ingestion lifecycle and SQL/hash parity; these component tests do not replace CP012's final deployed dual-instance verification.

### CP012 OpenCode delivery package

#### Optional native user policy

The v2 plugin accepts an optional absolute `options.userPolicyPath` alongside `options.configPath`. Omitting it preserves the existing plugin behavior. A present but invalid/unreadable profile retains blocking guards rather than enabling native fallback. Use a bundle built from this implementation: older delivery bundles do not implement this option.

```json
{
  "version": 1,
  "instructionFiles": [
    "/absolute/shared/MEMORY.md",
    "/absolute/shared/USER.md"
  ],
  "modelAllowlists": { "openrouter": ["google/gemini-3.8-flash"] },
  "geminiOpenRouterToolGuard": true
}
```

Explicit local instruction files are reread coherently for each normal context request and appended in array order after native global/project AGENTS. Missing, changing, invalid-UTF8 or oversized required files block that request; fixing the file allows a later request without reloading the profile. Policy settings themselves are loaded at plugin initialization. Native v1.18.29 upstream rereads instruction contents; a frozen per-session content snapshot is not assumed. Auxiliary title/generate requests are not projected by this context policy.

Catalog transforms disable non-allowlisted models for each listed provider, without enabling otherwise disabled models. An all-request-kind dispatch guard also rejects forbidden selections: a later native config override may expose a model in the UI but cannot bypass this guard. Providers absent from the map are unaffected. This filters catalog IDs, not a claim about upstream routing aliases or account authorization.

The tool guard quotes completed textual tool results containing `{` only for OpenRouter `google/` models. Multipart text is joined like the provider lowerer and encoded once, retaining file parts and surrounding metadata. Both this expansion and appended instructions occur before Reflection's planning and final hard-budget checks. Stored history, ingestion identities and source fingerprints are not rewritten. It is not an HTTP-after-budget workaround.

`scripts/src/opencode-v2-config.ts` provides a pure, strict pinned-schema draft converter with field accounting, read-only definition mappings and value-free deferred credential slots. It preserves agent/model/permission/MCP settings rather than substituting deny-all or disabled placeholders. Its output is always non-activatable: bindings must be resolved privately against an unchanged reviewed input, with filesystem containment, credential provisioning and coordinated source/reader activation handled separately. Numeric MCP defaults are preserved, while progress-reset and legacy remote-transport parity remain explicit verification limits. The hosted Mac fixture exercises the opt-in profile separately from the unchanged baseline.

This package is a delivery artifact and documentation only. It does not install a bundle, create a launcher, start or restart OpenCode, migrate a database, register a source, copy history, or adopt v2 in production.

From a clean, tracked checkout, build both actual plugin bundles, independently verify their standalone imports, and publish one new directory outside the repository and outside the user home/config/data/service paths:

```bash
pnpm package:opencode --out /absolute/operator-chosen/delivery
# Equivalent direct command:
node scripts/package-opencode.mjs --out /absolute/operator-chosen/delivery
```

`--out` is required, must be absolute, and must name a path that does not yet exist. The packager refuses unknown flags, a dirty tracked tree, untracked nonignored files, a repository destination, and home/config/data/service locations. It captures the checkout identity before building and rejects an artifact if the commit, tree, or lockfile changes during the build. It stages alongside the requested destination, holds a sibling cooperative reservation lock, verifies the destination is still absent, and then renames the complete artifact. The lock prevents cooperating packagers from colliding; POSIX rename cannot protect against a process that ignores that reservation and races the final rename. It never deletes a supplied directory. A development-only `--allow-dirty` package is marked `"dirty": true` in `manifest.json`; it is not a clean release claim. A failed build removes only its own staging directory.

The artifact contains only `v1/reflection.js`, native-discovery `v2/index.js`, `examples/`, and `manifest.json`; it does not include this repository, `node_modules`, a live v1 state/database, credentials, or a tar dependency. The manifest records the Git commit/tree, lockfile SHA-256, and byte size/SHA-256 for each delivered file. To independently inspect it, compare the bundle hashes and sizes in `manifest.json` with the two compiled source artifacts from the recorded commit.

The example JSON files deliberately contain invalid placeholders. Preserve the existing real Reflection base URL and API key rather than guessing an API path from these examples. Manually edit absolute paths and credentials before an operator-approved activation; do not render real keys, source URLs, or passwords through the packager. Each config's own source entry is required. The selected final layout is v1 at `127.0.0.1:4097` and v2 at `127.0.0.1:4096`; verify that the coordinated v1 port move actually occurred before using these maps. They do not move the current listener. Basic reader credentials are optional for v1 and require verification of its actual authentication policy; v2 has placeholder Basic credentials. Both configs retain stable IDs (`danny-opencode-v1` and `danny-opencode-v2`). Public hostname changes must not retarget historical local readers. `contextProjection.enabled` is required for the native config.

For a future **internal trial only**, keep every v2 path separate from v1. For example, an operator may choose one private `<v2-root>` and manually set `HOME=<v2-root>/home`, `XDG_CONFIG_HOME=<v2-root>/config`, `XDG_DATA_HOME=<v2-root>/data`, `XDG_STATE_HOME=<v2-root>/state`, `XDG_CACHE_HOME=<v2-root>/cache`, `TMPDIR=<v2-root>/tmp`, and a separate workspace. Set both `OPENCODE_CONFIG=<v2-root>/config/opencode-v2.json` and `OPENCODE_CONFIG_DIR=<v2-root>/config/opencode`; point the native config at an absolute v2 bundle directory and the isolated Reflection v2 config. HOME isolation also hides global Git, SSH, and AGENT settings, so the operator must review that consequence before adoption. Keep `OPENCODE_PASSWORD` in the environment rather than a literal command argument or log. Do not copy/import a source database or automatically import old v1 history.

Use only the chosen OpenCode **2.0.8** release binary for that future trial. The operator must run its `--version` check, verify the upstream release archive with the integrity data actually published for that artifact, and record the SHA-256 of the extracted exact binary. The supplied OpenCode JSON intentionally omits model/provider configuration and credentials: v2 schema/configuration differs from v1 and those settings must be ported and reviewed separately, outside the Reflection gate. The exercised harness is Linux ARM64 only; platform compatibility, real-provider behavior, GTK, and configuration adoption remain external checks that this packager does not perform. No system service, LaunchAgent, or enabled daemon is generated here.

Before any native writer source is registered or used, an approved native-capable backend must be deployed. At this packaging baseline, production `b75f4d1` is schema 009 and does not accept native boundary version 3; PRs 19 and 20 are unmerged. Hold automatic deployment before merging the native release, and prepare the same release's operator with privately supplied database credentials. The planned operator sequence is:

```bash
# Approved operator only; never a test fixture pointed at production.
node scripts/source-ownership.mjs expand
node scripts/source-ownership.mjs install-indexes
# Deploy the matching native-capable backend and verify readiness before:
node scripts/source-ownership.mjs register --id danny-opencode-v2 --kind opencode-v2 --identity-scheme source-v1
```

The index-preparation step validates migration 010's boundary constraints and creates its native indexes before the new backend starts. Registration is a plain INSERT: first check `GET /v1/sources/danny-opencode-v2`, and do not blindly repeat it or alter an existing identity. Do not repeat the completed CP008 cutover/backfill or re-register `danny-opencode-v1`. The updated v1 bundle supports native-v3 reads; install its matching reader map and have the user restart v1 only at a coordinated time. Keep the isolated v2 writer disabled until the remaining adoption checks pass. CP012 protocol/package verification does not make all of OpenCode ready: GTK, target-platform behavior, and provider configuration remain external gates.

Recovery is operator-controlled: leave the existing v1 service and paths untouched; stop only the isolated v2 instance if it must be stopped. Reflection memories remain source-scoped, and this package performs no automatic restore, rollback, source registration, or history import.
