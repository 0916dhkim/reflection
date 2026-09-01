# Reflection OpenCode plugin

The Reflection plugin submits canonical OpenCode source spans, projects older context from exact summaries, and exposes local source hydration. It requires a v2-capable Reflection server whose session manifest has `manifest_version: 2` and separate `segments`, `boundaries`, and `targets` arrays.

Do not run this plugin against the Python server, and do not run an old plugin against a database after v2 source-span rows exist. The production migration must stop every old plugin writer before the Node server applies migration `006`; see the root `README.md` for the forward-only cutover.

## Build and install

The stable deployable artifact is `plugin/dist/reflection.js`. Build and verify it from the repository root with Node 24 and the root lockfile:

```bash
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm install --frozen-lockfile
pnpm --filter opencode-reflection-plugin build
pnpm verify:plugin-bundle
install -d ~/.config/opencode/plugins
install -m 0644 plugin/dist/reflection.js ~/.config/opencode/plugins/reflection.js
```

The single-file ESM bundle contains the plugin, shared contracts/segmentation, `@opencode-ai/plugin`, and runtime dependencies. The copied file does not depend on this checkout or its `node_modules`. Restart OpenCode after replacing it. `pnpm verify:plugin-bundle` imports only the copied bundle in a fresh temporary ESM directory with no `node_modules` and checks its public exports.

## Configuration

Create `~/.config/opencode/reflection.json`:

```json
{
  "url": "https://your-reflection-service.example.com",
  "apiKey": "your-api-key",
  "contextProjection": {
    "enabled": false
  }
}
```

Protect the file as a secret and never commit it:

```bash
chmod 600 ~/.config/opencode/reflection.json
```

Every request sends `apiKey` as `X-Api-Key`. Context projection is experimental and defaults to disabled.

## Memory tools

- `memory_search(query)` calls `POST /v1/search` and returns structured claims with their supporting segment IDs.
- `memory_read_segment(segment_id)` calls `GET /v1/segments/{id}`, reloads that OpenCode session locally, and returns ordered user/assistant text for the committed source boundary.

Hydration is local and fails closed if the session history no longer exists. A v1 segment hydrates complete turns between its inclusive user boundaries. A v2 segment resolves its inclusive `start_source_message_id` and `end_source_message_id` within one user turn and returns exactly that intra-turn span. Missing, duplicate, reordered, or cross-turn v2 cursors are errors rather than a reason to widen the read to a whole turn.

Tool calls normally do not appear in hydrated/extracted text, but their complete model-visible representation contributes to segmentation weight. When every ordinary source message in a segment is blank, extraction receives up to 20,000 characters of sanitized tool names and state instead. Sanitized tool JSON sorts object keys recursively before truncation so transport key order cannot change source fingerprints. Objects with redacted keys use an entry-array representation so literal placeholder-shaped keys cannot collide with renderer placeholders. The server also recognizes the bounded legacy flat-key representation; deploy the compatible server before a plugin that emits the entry-array representation. This fallback omits reasoning, inline `data:` values, and compacted tool output. File parts become bounded filename and MIME markers. Empty model-visible messages remain in the submitted source with an empty `text` value.

## Canonical ingestion

The plugin reacts to `session.idle` and idle `session.status` events. It serializes target updates per session, checks idle status before and after capture, and coalesces event bursts. Active sessions submit closed spans only. A detached sweep may snapshot open spans from at most 20 other sessions after ten minutes of inactivity; unchanged revisions are cached for ten minutes, and current session metadata is rechecked before submission. SDK reads use cancellation signals and 30-second deadlines. An open v2 span is eligible only when its exact endpoint is a finite-completed assistant; a user or unfinished-assistant endpoint remains mutable and raw.

A canonical turn is one normal user message plus every model-visible assistant message whose `parentID` names that user message. Unanswered users and intermediate assistants remain source. Native compaction markers and exact Reflection projection-loss control messages are excluded as boundaries. Warning-like ordinary user messages without the exact marker remain source.

The shared segmenter targets 20,000 model-visible weighted characters. Weight includes visible text, reasoning, sanitized tool state/input/output, and conservative media reserves. Ordinary history uses legacy v1 whole-turn ranges. An oversized turn uses v2 exact source-message spans and splits only at a completed assistant message. A source message cannot be divided, so an unsplittable oversized message remains one standalone v2 span above the target. If messages from different turns are interleaved, an oversized disjoint turn remains one v1 whole-turn range because exact v2 cursors cannot cross the intervening turn.

Before segmenting uncovered history, the plugin validates `manifest_version: 2`, deterministic IDs, exact cursors, and fingerprints, then selects a deterministic maximum-coverage non-overlapping set from committed boundaries and current targets. Any turn containing a valid v2 anchor remains fragmented into v2 siblings; uncovered source before or after that anchor cannot become a whole-turn v1 follow-up.

Every submission includes an explicit source boundary, a deterministic versioned source fingerprint, and a processing priority. Ordinary text defaults to `projection_version: 1`; tool-fallback sources use version `2`, which prevents an older writer from replacing the sanitized payload after rollout. A persisted version-2 anchor remains version 2 when rebuilt, even if its current source includes ordinary text. Inactive-session sweeps use priority `0`; active-session idle ingestion uses priority `50`. A successful in-process fingerprint cache suppresses unchanged replays, but authoritative manifest fingerprints invalidate that cache if another writer changes a target. Service idempotency makes a process-restart replay safe.

## Staged summaries and foreground priority

Context projection needs summaries sooner than it needs resolved claims. On a reset path, the plugin submits every required closed canonical span at processing priority `100`. The server's worker schedules those jobs ahead of priority `50` active-session ingestion and priority `0` inactive-session/backfill work.

The server stages extraction output before entity resolution. Once the exact target, source fingerprint, summary, and projection commit fingerprint match, the staged summary can appear in the manifest's `segments` array while the target job remains `running`. This early summary is valid for projection only. `GET /v1/segments/{id}` and search claims are fully committed only after resolution finishes and the job reaches `succeeded`.

## Context projection

When enabled, the plugin sets OpenCode `compaction.auto` to `false`. It starts considering projection near 75% of usable model input, accounting for the active model's output reservation, and chooses a whole canonical span boundary that leaves a raw tail near 25% of context. It may reset again near the 90% hard input boundary during a long assistant/tool loop or after switching to a smaller model.

The request estimate covers the message payload visible to the transform plus a conservative reserve. The hook runs before OpenCode assembles final instruction files, MCP content, tool schemas, later plugin transforms, and provider-specific rewrites, so the estimate is not an absolute bound on the final provider request. A hard bound requires an OpenCode seam that exposes the assembled request before dispatch.

Projection replaces only the archived prefix with a synthetic compaction user/assistant pair. The retained raw tail is immutable. Its first message ID and generated summary are persisted as a mode-`0600` checkpoint under `~/.local/state/reflection/projection/` and reused across ordinary loops for provider-cache stability. A checkpoint is discarded only when its referenced local messages no longer match or a later safe reset replaces more of the prefix.

On an actual reset, the transform performs this bounded sequence:

1. Snapshot authoritative local messages and compute canonical spans from the current v2 manifest.
2. Serialize a closed-span foreground sync at priority `100` before accepting summaries.
3. Poll for exact eligible summaries while the foreground jobs remain pending/running.
4. Stop waiting after one aggregate 90-second transform deadline.
5. Build the projected prefix from every available exact summary plus bounded inherited context and tool records.

If synchronization, polling, the service, or summary coverage is incomplete at 90 seconds, projection does not mutate the retained tail or substitute a wider boundary. It emits a warned lossy prefix with explicit omission markers and preserves every exact summary that is available. Missing summaries, unsafe/inherited reasoning, unfinished tools, archived media, and summary/tool budget truncation are all marked lossy. The serialized background sync remains handled, so a later safe reset can use newly available summaries. Projection throws only when no safe message-aligned cutoff can make the request fit.

The plugin shows a best-effort TUI toast immediately after a lossy reset. It never persists the warning as a conversational message, so warning delivery cannot reorder user turns. The synthetic projection summary itself carries the durable model-visible omission warning.

## Native and manual compaction

Manual `/compact` remains available. The `experimental.session.compacting` hook temporarily bypasses Reflection's message transform, so manual compaction can recover a session even if Reflection is unavailable.

If history already contains a native/manual compaction pair, the plugin inherits the native assistant summary as prior context and starts canonical source planning after it. It does not ingest the compaction marker as a user turn, expose hidden pre-compaction source as an exact span, or resurrect OpenCode tool output that native compaction already cleared. Any uncovered inherited text can be retained only as explicitly labeled context; unsafe omissions make the next Reflection projection lossy.

## Operational behavior

- Memory tool calls time out after 120 seconds and honor cancellation.
- Manifest/ordinary projection reads and each target submission use short five-second HTTP deadlines.
- The foreground transform has one aggregate 90-second wait for target synchronization and exact summaries.
- Failed closed-span submissions remain a sticky freshness failure until the boundary succeeds or current history removes it.
- Failed inactive open snapshots are logged but do not block closed-summary reads.
- OpenCode SQLite is read through the SDK and is never modified by ingestion or projection.
- Structured diagnostics contain IDs, counts, limits, and omission reasons, never source text.

## Development

From the repository root:

```bash
pnpm --filter opencode-reflection-plugin format:check
pnpm --filter opencode-reflection-plugin typecheck
pnpm --filter opencode-reflection-plugin test
pnpm --filter opencode-reflection-plugin build
pnpm verify:plugin-bundle
```

`pnpm check` runs the complete monorepo checks and verifies the built plugin bundle last.
