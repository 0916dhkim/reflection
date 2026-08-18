# Reflection OpenCode plugin

This plugin submits complete OpenCode turns to Reflection and exposes two memory tools:

- `memory_search(query)` calls `POST /v1/search` and returns Reflection's structured claims and source segment IDs as JSON.
- `memory_read_segment(segment_id)` calls `GET /v1/segments/{id}`, reloads the referenced OpenCode session, and returns the original ordered user and assistant text as JSON. Source reading is best-effort and requires that the local OpenCode session and its message history still exist.

Tool calls, reasoning parts, and every non-text part are excluded. Messages with no text parts remain in the output with an empty `text` value.

## Configuration

Create `~/.config/opencode/reflection.json` with permissions appropriate for a secret:

```json
{
  "url": "https://your-reflection-service.example.com",
  "apiKey": "your-api-key"
}
```

Do not commit this file. `reflection.example.json` contains placeholders only. Every Reflection request sends the key in the `X-Api-Key` header.

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

A turn is one user message plus every assistant message whose `info.parentID` matches that user message ID. A user message without an assistant is not a complete turn and is not submitted. Only ordered text parts count toward segment size.

Segments target at most 20,000 text characters without splitting a turn. A segment that reaches exactly 20,000 characters is closed immediately. A turn that would cross the limit starts the next segment. A turn larger than the limit is submitted as a standalone segment. Closed segments are submitted on idle; the final open tail is submitted when an idle event discovers that its session has been inactive for at least 10 minutes. Submissions may repeat because the Reflection service owns idempotency.

HTTP requests time out after 120 seconds. Memory tool cancellation still aborts its in-flight request.

`POST /v1/segments` receives:

```json
{
  "session_id": "ses_...",
  "start_user_message_id": "msg_...",
  "end_user_message_id": "msg_...",
  "messages": [{ "role": "user", "text": "..." }]
}
```

`GET /v1/segments/{id}` must return `session_id`, `start_user_message_id`, and `end_user_message_id` with the same meanings. User boundaries are inclusive.

## Development

```sh
pnpm format
pnpm test
pnpm typecheck
pnpm build
pnpm verify:bundle
```

`pnpm verify:bundle` copies only the built file into a fresh temporary ESM directory with no `node_modules` and imports it.
