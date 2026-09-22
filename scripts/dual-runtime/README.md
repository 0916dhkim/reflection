# Actual Dual-Runtime Gate

Run `node scripts/dual-runtime/run.mjs` from the repository root. Docker is the
only host dependency besides Node. No host node_modules, credentials, exposed
ports, live configuration, or production databases are used.

The runner snapshots tracked files plus new files only under
`scripts/dual-runtime/`, builds the unmodified Reflection server
and both plugin bundles, and verifies published OpenCode 1.18.29 / 2.0.8 binary
integrities. A fresh pgvector database and internal-only Docker network are
created for each run. Both hosts use distinct temporary homes and authenticated
source readers. Native restart reuses exactly those same isolated directories.
V1 uses the production `legacy` identity scheme; v2 uses `source-v1`.
Source state prefixes have mode 0700; actual SQLite databases, host session
lists, and effective plugin configuration are checked for isolation.

Snapshots use NUL-delimited Git filenames, reject symlinks/special files (including
symlinked parent directories), and exclude `.env` / `.env.*` at every depth.
No unrelated untracked packaging files are included. Exact included filenames
and hashes are recorded. Node and pgvector base images are digest-pinned.
The scenario refuses non-fixture database credentials, upstream addresses,
API keys, or HOME before constructing its database pool.

Only model/extraction/embedding HTTP upstreams are scripted. Reflection registry,
search, ingestion, worker processing, persistence, and source history are real.
The forwarding proxies only introduce availability failures, never successful
Reflection responses. A title-only native helper avoids unrelated title model
calls; it does not intercept tools, context, storage, ingestion, or compaction.

## Coverage

- Sixteen pressure turns in each host; real PG summaries in projected notices,
  preserved raw histories, latest-user uniqueness, no native compaction.
- Model-driven search in each host; the model fixture parses the actual search
  result, selects the other source owner, and emits an actual tool call. Exact
  ordered reads are compared against live history with bundled production
  canonicalization/hydration helpers. Wrong owner and source outage refuse;
  recovery returns the same messages.
- Both source forwarding proxies force seven-message pages while preserving
  opaque cursors, v1 `X-Next-Cursor`, and unmodified v2 JSON bodies. Cross-host
  reads must demonstrate actual continuation. Source readers reject Reflection
  API-key headers even with otherwise correct Basic authentication.
- All accepted source payloads are compared with live canonical history ranges
  and production UUID/fingerprint helpers. PostgreSQL committed rows and jobs
  are reconciled by source, fingerprint, and generation, allowing duplicate
  submissions and priority changes. Pending targets and native SQL NULL
  boundaries are checked independently; completed targets must be removed.
- Extraction accepts only the two production schemas, creates claims only with
  literal source support, and tags unsupported ranges `NO_FACT`. Embeddings
  require `input_type` of `query` or `document`.
- Manual compaction veto and separate-workspace automatic-compaction refusal.
- Real native process restart, manifest-only outage, verified cached summary
  text and raw history preservation, registry availability, no re-extraction,
  and real-worker recovery.
- Actual session model switch to a smaller budget with bounded estimated
  outgoing context and latest-user preservation.
- Held upstream extraction with pending real jobs, bounded prompt completion,
  explicit missing-summary notices, then real-worker completion and projection.
- Ordinary inline PNG bytes and archived latest-user PNG restoration after
  eight bounded real shell tool calls; no native compaction or raw-image changes.
- Actual background subagent, held child response until parent acknowledgement
  persists, API-verified parent/child lineage, later synthetic completion, stable
  acknowledgement, subsequent closed-range ingestion and actual cross-host read.

The scenario deadline is 300 seconds; the outer runtime timeout allows another
15 seconds for cleanup. Child responses and shell commands have independent
finite timeouts. Cleanup removes only this run's labeled containers, database
volume, network, and image, then checks those labels for leaks. Build cache and
the shared base images are not pruned.

## Evidence And Limits

The runner prints only a compact summary and retains full `report.json`, `runtime.log`,
`build.log`, and its exact source snapshot in the reported temporary directory.
The report includes dynamic assertion counts by phase, explicit internal gate
states, provider/backend/source/extraction request captures, tool schemas,
diagnostics, source-root/commit/file hashes, binary/bundle hashes, Docker image
digests, timings, and cleanup verification. Failures do not become skipped passes.

V1 warm dependencies are installed with pnpm, in hoisted layout. Its published
1.18.29 loader's `Npm.checkDirty` explicitly reads `package-lock.json` and calls
npm Arborist when declared dependencies are missing there. A pnpm-only warm
directory, including the hoisted variant, timed out at offline session creation.
The build therefore also runs `npm install --package-lock-only --ignore-scripts`
to generate a genuine compatibility lock without replacing the pnpm install.
Both generated warm lockfile hashes are recorded; these dependencies are not
claimed to be covered by the repository's frozen root lockfile.
Loader reference: https://github.com/anomalyco/opencode/blob/v1.18.29/packages/core/src/npm.ts

Run `node --test scripts/dual-runtime/safety-check.mjs` for isolated snapshot and
environment-guard regression tests. They do not modify the runner's environment
or the working repository's Git index.

The separate terminal extraction failed-status/retry scenario is not exercised.
Hold/pending/recovery is covered. PNG coverage is not a claim about every media
format. Background content ingestion is demonstrated on later closed ranges
under projection pressure, not autonomous idle-only ingestion. Remaining
external gates are commercial-provider quality, GTK, and operator-approved
production adoption; this harness performs none of those actions.
