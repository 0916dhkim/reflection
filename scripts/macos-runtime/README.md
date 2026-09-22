# Hosted macOS Readiness

This lane is **not a local smoke test**. Only the PR workflow may execute it on
GitHub-hosted ARM64 `macos-15` and `macos-26`. The entrypoint checks the exact
hosted identity, platform, architecture, absolute job paths and checkout before
creating files or starting processes. It checks the actual macOS major against
the matrix before native execution. There is no workflow-dispatch dependency,
installation of the CLI wrapper, live-machine fallback, OAuth, or credential
import.

Safe local checks:

```sh
pnpm test:macos-v2:safety
pnpm check
```

Do not execute `run.mjs`, the sandbox probe, native binaries, Playwright, or
fixture listeners locally. Dependency/browser downloads happen outside the
sandbox in CI before native startup. All native invocations, including version
inspection, use private HOME/XDG/config/DB paths, an allowlisted environment,
and a mandatory Seatbelt profile. Private paths are normalized with `realpath`
to account for Darwin's `/var` symlink. The profile permits public OS reads and
Mach services, restricts file writes to the disposable root (plus device output),
and permits only explicit loopback ports. A CI-only narrower sandbox probe
checks an allowed write/request and rejects an outside write and port 4096.
This does not establish TCC, Gatekeeper, notarization, or quarantine acceptance;
the lane never removes quarantine.

## Required Gates

- Published 2.0.8 Darwin ARM64 archive/binary hashes, Mach-O architecture,
  signature verification, and exact `opencode v2.0.8` version output.
- Private native SQLite startup; authenticated HTTP/SPA routing; bounded SSE
  session creation and reconnection.
- Production Reflection bundle initialization and actual model-driven
  `memory_search` -> `memory_read_segment` -> final marker through native v2.
- Real native seed user history, canonicalized and identified by bundled
  production helpers. The HTTP backend mocks claims/segment metadata only.
  Authenticated source RPCs are forwarded to native v2 and inspected for raw
  native records; no synthetic source-history fallback exists.
- Global config-directory and workspace AGENTS sentinels in source order.
  Project discovery is enabled only inside a fresh private git workspace.
- Chromium and WebKit session title, prompt, assistant rendering, API history,
  direct route reload, and success of every requested bundled JS/CSS asset.
  HTTP Basic credentials use challenge-response, not injected global headers.
  Browser routing blocks other origins; data/blob UI resources remain allowed.
- Strict port 4097 loopback listener; independent valid port-4098 baseline before
  occupied-port and invalid-DB negatives; explicit bind/SQLite error evidence;
  no silent 4098 switch. Same-DB/different-port behavior is characterized, not
  assumed to be rejected: foreground `serve` does not promise exclusive instance
  ownership merely because an upstream ProcessLock utility exists. Deployment
  must prevent accidental root/database sharing in its own configuration.
- SQLite history persistence after restart and unchanged run-owned port-4096
  HTTP/file sentinel. The sentinel is not a real v1 runtime.

All spawned CLI/helper groups are tracked immediately, including failed starts.
Requests and streams are bounded; streams are cancelled in `finally`. The run
has an eight-minute cancellation deadline and the workflow a fifteen-minute
timeout. Reports contain gate outcomes, provenance and limitations, not raw
provider histories or credentials. `outcome: passed` means **these required
gates** passed, not that every adoption gate is verified. Cleanup failure fails
the run. Unimplemented watcher, PTY, SafeShell, pressure/media and broad-provider
checks are listed separately as remaining work, never as passing phases.

## Source Contracts

Inspected OpenCode source revision:
`7673ed6bd6547ee0dcb81aab55f1392fb751d652` (2.0.8 assessment).

- `packages/cli/src/server-process.ts`: config/env selection, exact requested
  port, password and file-watcher/FFF controls.
- `packages/cli/src/services/web-ui.ts`: SPA fallback, missing asset/API 404s.
- `packages/app/src/shell/routes/{routes.tsx,session.ts}` and
  `packages/app/src/runtime/server/registry.tsx`: the actual route is
  `/server/<base64url(server-origin)>/session/<id>`, not a directory-base64 route.
  `packages/util/src/encode.ts` supplies the UTF-8 base64url algorithm.
- `packages/protocol/src/groups/session.ts`: explicit `location.directory`
  session creation and prompt/history contracts, also exercised by CP012 and
  the existing native-provider-probe runner/observer.
- `packages/core/src/config/plugin/instruction.ts`: global AGENTS followed by
  project files; `instruction-discovery.ts` preserves insertion/render order.
- `packages/core/src/util/process-lock{,-ffi.bun}.ts`: Darwin FFI lock and
  `Process lock is already held` evidence.
- `packages/protocol/src/groups/pty.ts`: available but not exercised here;
  `connect-token`, `x-opencode-ticket: 1`, location query and single-use WebSocket
  ticket are explicit. No guessed PTY API is used.
- `packages/plugin/src/promise/plugin.ts`: the inspected plugin context does
  not expose a `ctx.file` member. Watcher observer coverage is deferred rather
  than invented. `promise/tool.ts` and `promise/shell.ts` expose tool transforms
  and shell hooks; SafeShell execution is separately unverified.
- This repository's `scripts/dual-runtime/scenario.mjs` supplies the tested v2
  `providers` / `@opencode/ai/providers/openai-compatible` configuration.
  `oracle.mjs` bundles the production native history/segment identity functions.

Workflow action SHAs were resolved from current release tags using the GitHub
API: checkout 7.0.1, setup-node 7.0.0, upload-artifact 7.0.1 and pnpm/action-setup
6.1.0. Playwright is pinned to 1.63.0; its published registry explicitly includes
`mac15-arm64` and `mac26-arm64` Chromium/WebKit artifacts. Neither source
inspection nor local pure checks establishes native
macOS success; both matrix jobs still need to run after the reviewing agent
pushes the PR.
