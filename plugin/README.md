# Reflection OpenCode plugin

Deploy the service version that returns `boundaries` and `targets` before installing this plugin or running the manifest-aware backfill. Older service responses are rejected so clients cannot silently re-segment committed history.

This plugin submits complete OpenCode turns to Reflection and exposes two memory tools:

- `memory_search(query)` calls `POST /v1/search` and returns Reflection's structured claims and source segment IDs as JSON.
- `memory_read_segment(segment_id)` calls `GET /v1/segments/{id}`, reloads the referenced OpenCode session, and returns the original ordered user and assistant text as JSON. Source reading is best-effort and requires that the local OpenCode session and its message history still exist.

Tool calls and reasoning parts are excluded from extracted source text, but their complete model-visible representation counts toward segment boundaries. File parts are retained in source as bounded filename and MIME-type markers and receive a conservative media reserve for boundary weighting; messages with no text or file parts remain in the extraction output with an empty `text` value.

## Configuration

Create `~/.config/opencode/reflection.json` with permissions appropriate for a secret:

```json
{
  "url": "https://your-reflection-service.example.com",
  "apiKey": "your-api-key",
  "contextProjection": {
    "enabled": false
  }
}
```

Do not commit this file. `reflection.example.json` contains placeholders only. Every Reflection request sends the key in the `X-Api-Key` header.

### Context projection

`contextProjection.enabled` is experimental and defaults to `false`. When enabled on OpenCode V1, the plugin sets `compaction.auto` to `false` and replaces an old model-visible prefix with a synthetic compaction pair containing successful Reflection summaries. OpenCode's SQLite history is not changed. Manual `/compact` remains available and explicitly bypasses Reflection projection so it can recover a session when Reflection is unavailable.

After the service migration is deployed, projection accepts committed version `0` and version `1` summaries unconditionally. Version `1` ingestion and backfill replace older summaries incrementally. This mixed rollout deliberately accepts that a version `0` summary may contain ACP-hidden text or omit newer metadata safeguards.

Projection starts when estimated request input reaches the lower of 75% of model context or the model's usable input capacity after output reservation. The output reservation uses OpenCode's effective cap: the lower of the model output limit and `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`, with OpenCode's 32,000-token default when the override is absent. The estimate uses the latest provider-reported input token count plus conservative model-visible UTF-8 growth. Images receive a fixed vision-token reserve; embedded non-image media is conservatively sized from its data URL, and unknown remote non-image media fails closed. The first request without usage data uses the same conservative estimate. A reset chooses a whole local segment boundary that leaves a raw tail near 25% of model context. Every archived segment is closed, and the current open segment remains raw. Ordinary assistant and tool loops reuse the checkpoint, but pressure at the 90% hard input boundary can reset again mid-loop. Switching to a smaller model resets when the retained context exceeds that model's target; switching to a larger model retains the checkpoint.

When every archived closed segment has an exact committed summary and all inherited summary and tool records fit their budgets, the reset is lossless. Projection neither requests nor uses summary coverage for the retained open segment. On an actual reset path only, the transform snapshots its authoritative current local segments and enqueues a serialized closed-only target sync before any summary GET. This protects a new plugin process from stale same-boundary summaries without persistent failure state: the first reset may idempotently replay each closed segment, while successful fingerprints suppress later unchanged replays in that process. The existing aggregate freshness barrier bounds this sync to five seconds. A failed or timed-out sync skips the GET and produces warned lossy context; the serialized background operation remains handled, and later completion or retry can make a later reset fresh. Missing closed-segment summaries, summary-service or target-update errors, unsafe reasoning, unfinished or unsupported tools, archived media, and summary or tool budget omissions likewise produce a lossy reset with explicit omission markers and a synthetic warning in the model-visible context. Available exact closed-segment summaries are retained in a lossy reset. Summary existence is the only local freshness check; the production service hides stale summaries after a target update. Missing summaries never defer a reset. Completed OpenCode tool output is retained as a bounded, explicitly untrusted assistant-side record; output already compacted by OpenCode is not resurrected. Attachment filenames and MIME types are retained, but attachment contents are not copied. Projection fails only when no safe segment-aligned cutoff can produce a tail that fits the model input target.

Checkpoints live as mode-`0600` per-session files under `~/.local/state/reflection/projection/`. The exact synthetic summary and cutoff are reused through ordinary assistant/tool loops for provider-cache stability; a lossy checkpoint remains unchanged until a later normal compaction or hard-limit emergency reset. A lossy checkpoint queues one in-memory warning for that session. On the next `session.idle` or idle `session.status` event, the very first asynchronous action is a guarded `session.prompt` call with `noReply: true`, before status checks, ingestion, or inactive-session sweeps. Paired idle events await the same insertion. The inserted text is visible in both web and TUI history, is non-synthetic, and carries an exact Reflection metadata marker. Success consumes the pending warning without an additional TUI toast; failure leaves it pending for a later idle retry. The queue intentionally does not survive plugin restart.

OpenCode 1.18.15 chooses the default agent when `agent` is omitted from `session.prompt`, and may choose an agent/default/current model when `model` is omitted; it then updates the session when those values differ. The plugin therefore captures and supplies the active normal user's agent, provider/model, and optional model variant at reset time. The legacy generated SDK type omits `variant`, but the 1.18.15 runtime accepts and persists it, and the generated client forwards the complete request body. The `noReply` insertion is not atomic with a concurrent user prompt. Local persistence was measured at roughly 5-25 ms, but a prompt submitted during that window may be stored before the warning; because the warning can then become OpenCode's latest user message, the concurrent prompt may be skipped or only partially executed. This ordering race and its impact are explicitly accepted. Each reset also emits one structured OpenCode diagnostic containing IDs, counts, token limits, and omission reasons but no message content.

## Install

Install dependencies, build the single-file bundle, and copy it into OpenCode's global plugin directory:

```sh
pnpm install --frozen-lockfile
pnpm build
mkdir -p ~/.config/opencode/plugins
cp dist/reflection.js ~/.config/opencode/plugins/reflection.js
```

The bundle contains the plugin's local modules, `@opencode-ai/plugin`, and its runtime dependencies, so the copied file does not depend on this source tree or its `node_modules`. Rebuild and copy the file again after changing the plugin, then restart OpenCode.

## Ingestion behavior

The plugin reacts to `session.idle` and idle `session.status` events. Each session has at most one active idle pass and one dirty-rerun bit, so event bursts cause at most one follow-up capture and one sweep. The plugin checks session status before and after message capture so detached idle work does not ingest a turn that has become busy, and detached idle hooks log failures rather than rejecting. Message listing requests SDK throwing semantics and treats only an array response as authoritative: missing or non-array data cannot masquerade as a rewind, while `data: []` is a valid empty-session history. It does not start a timer.

A turn is one normal user message plus every provider-visible assistant message whose `info.parentID` matches that user message ID. Unanswered turns and model-visible intermediate assistants remain source. OpenCode 1.18.15 hides generic errored assistants; an assistant with `MessageAbortedError` remains visible only when it has a part other than `step-start` or `reasoning`. The same message-level rule governs token estimates, extracted text, archived tools, and lossy omission markers. Ignored user parts are hidden, while ignored assistant text, reasoning, and tools remain provider-visible and follow the same projection paths. Native compaction markers remain excluded. A persisted Reflection warning is recognized only when it has the exact warning text, exact metadata marker, one visible non-synthetic text part, and no extra metadata. That exact control message remains model-visible and counts toward request pressure, but is excluded from normal user boundaries, segment source, open/closed segmentation, projection tail candidates, active-model selection, and `memory_read_segment` hydration. Warning-like user messages with arbitrary, mixed, or additional metadata remain ordinary source. Ordered text and file metadata markers count toward segment size.

Segments target at most 20,000 model-visible character equivalents without splitting a turn. The weight includes visible text, reasoning, sanitized tool input/state/output, and a conservative media reserve. Before segmenting, the plugin reconciles committed boundaries and active desired targets against local user order, preserves a deterministic maximum-coverage non-overlapping set, and applies the new weight only to uncovered ranges. A segment that reaches exactly 20,000 characters is closed immediately. A turn that would cross the limit starts the next segment. A turn larger than the limit is submitted as a standalone segment. Active-session idle events submit closed segments only; the final open segment is never posted for the active session. The inactive-session sweep may snapshot another session's open segment after 10 minutes for cross-session recall. Inactive eligibility is re-read from current session metadata after the existing idle-status/message/idle-status capture sequence; a session updated during a stale sweep submits closed segments only. A per-session cache fingerprints each segment body after successful submission, so unchanged closed history and unchanged inactive open snapshots are not reposted in the same process. A changed open snapshot gets a new fingerprint and remains a source-versioned service update. Restarting the plugin may replay each segment once; service idempotency makes that safe. Failed submissions are not cached and retry on a later eligible idle event. A failed open snapshot is logged but does not block closed-segment summary loading; a failed closed submission remains a sticky freshness failure while its start boundary exists. A successful current-history capture clears that sticky failure if undo or rewind removed the failed boundary, including replacement or open-only history. Target-update POSTs are serialized per session and each has a five-second timeout. A projection reset drains already-pending and newly-coalesced updates for at most five seconds before loading summaries. Any present closed-segment update failure or wait timeout makes summary loading fail into lossy projection rather than accepting possibly stale summaries. A prior freshness failure is cleared only by confirmed successful POSTs, a cache hit proving that segment's current fingerprint was submitted successfully, or a successful capture proving the failed start no longer exists; busy or otherwise unobserved no-op captures cannot clear it.

Memory requests time out after 120 seconds, projection summary reads after five seconds, and target updates as described above. Memory tool cancellation still aborts its in-flight request.

`POST /v1/segments` receives:

```json
{
  "session_id": "ses_...",
  "start_user_message_id": "msg_...",
  "end_user_message_id": "msg_...",
  "projection_version": 1,
  "messages": [{ "role": "user", "text": "..." }]
}
```

`GET /v1/segments/{id}` must return `session_id`, `start_user_message_id`, and `end_user_message_id` with the same meanings. User boundaries are inclusive.

Context projection also calls `GET /v1/sessions/{session_id}/segments`, which returns eligible summaries, committed boundaries with source fingerprints, and desired targets separately. The plugin orders and validates committed and active target boundaries against local history rather than trusting response order; source fingerprints invalidate process-local replay suppression after another writer updates a segment.

## Development

```sh
pnpm format
pnpm test
pnpm typecheck
pnpm build
pnpm verify:bundle
```

`pnpm verify:bundle` copies only the built file into a fresh temporary ESM directory with no `node_modules` and imports it.
