# Reflection OpenCode plugin

This plugin submits complete OpenCode turns to Reflection and exposes two memory tools:

- `memory_search(query)` calls `POST /v1/search` and returns Reflection's structured claims and source segment IDs as JSON.
- `memory_read_segment(segment_id)` calls `GET /v1/segments/{id}`, reloads the referenced OpenCode session, and returns the original ordered user and assistant text as JSON. Source reading is best-effort and requires that the local OpenCode session and its message history still exist.

Tool calls and reasoning parts are excluded from extracted source text. File parts are retained as bounded filename and MIME-type markers; messages with no text or file parts remain in the output with an empty `text` value.

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

Projection starts when estimated request input reaches the lower of 75% of model context or the model's usable input capacity after output reservation. The estimate uses the latest provider-reported input token count plus conservative model-visible UTF-8 growth. Images receive a fixed vision-token reserve; embedded non-image media is conservatively sized from its data URL, and unknown remote non-image media fails closed. The first request without usage data uses the same conservative estimate. A reset keeps a segment-aligned raw tail near 25% of model context. Switching to a smaller model resets immediately when the retained context exceeds that model's target; switching to a larger model retains the checkpoint.

Only a contiguous prefix of successful, fully answered segments can be removed. Missing summaries, unanswered turns, service failures, invalid model metadata, or insufficient coverage fail the provider request instead of dropping source messages. Reasoning remains excluded; if a native compaction split leaves unsummarized reasoning at the front of its retained tail, projection fails closed rather than discarding it. Completed OpenCode tool output is retained as a bounded, explicitly untrusted assistant-side record; output already compacted by OpenCode is not resurrected. Attachment filenames and MIME types are retained, but attachment contents are not copied.

Checkpoints live as mode-`0600` per-session files under `~/.local/state/reflection/projection/`. The exact synthetic summary and cutoff are reused through an assistant/tool loop for provider-cache stability unless request pressure reaches the 90% emergency boundary. Each reset is logged through OpenCode with its session, tail boundary, and estimated request pressure.

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

The plugin reacts to `session.idle` and idle `session.status` events. It does not start a timer.

A turn is one user message plus every assistant message whose `info.parentID` matches that user message ID. A user message without an assistant is not a complete turn and is not submitted. It also closes the preceding segment so no summary range can span omitted user content. Ordered text and file metadata markers count toward segment size.

Segments target at most 20,000 text characters without splitting a turn. A segment that reaches exactly 20,000 characters is closed immediately. A turn that would cross the limit starts the next segment. A turn larger than the limit is submitted as a standalone segment. Closed segments are submitted on idle; the final open tail is submitted when an idle event discovers that its session has been inactive for at least 10 minutes. Submissions may repeat because the Reflection service owns idempotency.

HTTP requests time out after 120 seconds. Memory tool cancellation still aborts its in-flight request.

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

Context projection also calls `GET /v1/sessions/{session_id}/segments`, which returns committed version `0` and version `1` segment IDs, boundaries, versions, and summaries. The plugin orders and validates those boundaries against local history rather than trusting response order.

## Development

```sh
pnpm format
pnpm test
pnpm typecheck
pnpm build
pnpm verify:bundle
```

`pnpm verify:bundle` copies only the built file into a fresh temporary ESM directory with no `node_modules` and imports it.
