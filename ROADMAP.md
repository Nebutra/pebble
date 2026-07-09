# Pebble Roadmap

## Tauri desktop mainline migration

Pebble's desktop target is Tauri as the primary app shell, backed by the Go
runtime and Rust host boundary. Electron is a parity reference only while
migration is in progress; new desktop-shell work should move toward Tauri
commands, Rust host adapters, and Go runtime contracts instead of deepening
Electron main-process ownership. `pebble/zig-system/` is not linked into any
build yet (see its README) and is reserved for a future systems layer, not a
current runtime dependency.

Mainline rules:

- `pebble/desktop-tauri/` is the desktop-shell migration track and must load the
  same React workbench renderer, not a reduced or mock UI.
- Pixel parity is the bar: Tauri may be more reliable, faster, and more native, but
  it must not ship placeholder screens, simplified flows, or UI forks that only
  resemble Electron from a distance.
- Electron is a parity reference only; it is not the destination desktop shell.
- The Tauri shell must keep pixel-level parity with the Electron reference
  while Electron remains available for comparison.
- Existing renderer features should be backed by runtime contracts before the
  corresponding Electron IPC path is retired.
- `node config/scripts/verify-tauri-mainline.mjs` must pass when changing the
  Tauri shell, renderer entry, or migration contract.

Migration gates:

| Area | Target owner | Current status | Exit criterion |
| --- | --- | --- | --- |
| Window shell, sizing, and app identity | Tauri/Rust | Tauri config uses Pebble identity and Electron fallback window dimensions; Tauri now installs native window, settings-event, and menu bridges for close guards, titlebar popup menus, paste, help/settings events, sidebar toggles, Appearance checkbox state, and zoom. | Tauri window controls, titlebar behavior, traffic-light placement, menus, updater menu checks, and shortcut parity match Electron screenshots on macOS, Windows, and Linux. |
| Renderer parity | React in Tauri | Tauri renderer imports the canonical `@/App` and root renderer stylesheet. | Desktop Tauri screenshots match Electron reference views for landing, workspace, terminal, browser, source control, checks, settings, update dialogs, and crash surfaces. |
| File/project pickers and shell actions | Tauri commands + Rust host | Native folder picker commands exist for local project add flows; Tauri now bridges validated open-in-file-manager, open-in-editor/default app, URL/file URI open, path existence, attachment/image/audio/directory pickers, repo-icon PNG import, no-overwrite file copy, local Git base-ref/default-branch lookup, `pebble.yaml` hook checks, setup-script import inspection, issue-command shared/local resolution, and linked-worktree-safe issue-command runner script creation through the existing renderer contracts. Tauri local runtime RPC also maps file explorer `read`, `readDir`, preview read, chunk read/write, base64 upload writes, server-directory browsing, write, create file/dir, rename, copy, delete, stat, quick-open listing, text search, and markdown document listing to Go file endpoints with workspace path safety, while paired remote runtime environments proxy the same file explorer read/preview/chunk/write/CRUD/search/document RPCs for SSH worktrees instead of touching remote paths from the desktop host. Tauri overrides the web no-op file-watch API with a native Rust `notify` watcher for local worktrees and bridges SSH/remote worktree watches through `runtimeEnvironments.subscribe(files.watch)` into the same `fs:changed` renderer payload. Tauri also resolves terminal-tapped worktree paths and grants local temp-file terminal artifacts through native Rust commands with recent-terminal-output provenance, TTL grants, no-follow reads, stale-file checks, preview, and writeback; paired remote runtime environments proxy the same terminal artifact RPCs and keep remote grant IDs scoped to the originating connection/worktree/path. Legacy SSH relay-only terminal artifact grants and richer binary viewer parity remain explicit file-adapter gaps. | Project add/remove, folder workspaces, file attachment flows, repo icon import, markdown image copy, SSH project setup, base-ref pickers, local/remote file-watch refresh, local/paired-remote terminal artifact open/preview/write, local/paired-remote file explorer CRUD/search/preview, and trusted hook prompts run without Electron IPC. |
| Runtime RPC, remote environments, and PTY/session control | Go runtime (creack/pty) + Rust/Tauri | Tauri can start/probe the local Go runtime, call bounded runtime resources, expose native provider list/status/register RPCs through the real Go `/v1/providers` and subsystem status routes, detect installed local CLI agents through the shared `TUI_AGENT_CONFIG` catalog, map the local runtime preflight RPC methods onto real Tauri preflight probes, stream runtime `project.changed`/`worktree.changed` events back into the existing renderer repo/worktree refresh callbacks, emit renderer-correlated create progress events for Tauri worktree creation, map worktree lineage list/set/create paths onto Go runtime state including `workspaceLineage` records for folder/worktree parent keys, persist project groups, folder workspace objects, project order, and basic worktree metadata/sidebar sort order through Go runtime routes, run bounded local nested repo scan/import through Go `/v1/project-groups/scan-nested` and `/v1/project-groups/import-nested` with `.gitignore` filtering, sparse folder subgroups, existing-project reuse, local worktree target normalization, final progress events, cancel-to-`stopped` scan results, and scan/import timeouts aligned to the renderer's bounded UX, bridge paired remote `connectionId` nested repo scan/import through the same `projectGroup.scanNested`/`projectGroup.importNested` runtime environment RPCs instead of touching remote paths from the desktop host, run bounded local `git worktree remove` before deleting Tauri-created worktree records, map workspace-backed terminal spawn/write/output/stop/clear-buffer plus renderer-side geometry tracking onto Go process sessions, map local runtime terminal list/show/read/send/wait/inspect/clear/stop/stopExact/agent-status calls onto the same Go sessions, bridge runtime-backed agent sessions into the existing renderer `agentStatus` protocol with durable tab/leaf metadata for snapshots, expose renderer-compatible mobile fit/driver snapshots, subscriptions, and desktop reclaim actions through a Tauri-side state mirror, and map mobile device/runtime-access-grant list plus revoke calls to Go mobile relay pairings instead of empty web mocks. The Go runtime owns PTY spawn/winsize/resize via `creack/pty`; alt-screen and foreground-process tracking land separately. Tauri now also persists pairing-backed remote runtime environments in `pebble-environments.json`, validates `pebble://pair?...` payloads, redacts secrets in renderer responses, supports list/resolve/remove/disconnect plus one-shot and subscription WebSocket E2EE remote runtime calls through native commands instead of mock local environments, routes passive remote preflight probes through a runtime-environment selector when the connection id is a paired runtime environment, and exposes the canonical speech model catalog with explicit unavailable model states plus lifecycle listeners instead of an empty speech mock. Go HTTP context-level nested scan cancellation/streaming, legacy SSH relay nested import paths, Electron-style SSH relay agent detection, native Tauri STT/model download/OpenAI key storage, hook-level terminal idle/permission state in Go sessions, and live mobile/shared-control event ingestion are still explicit parity gates, not fake empty success. | Terminal creation, split panes, agent launch, session tail/input/stop, native PTY winsize propagation, alternate screen, foreground process tracking, live mobile terminal/browser presence-lock input from runtime RPC, remote runtime subscriptions/shared-control, full linked issue/PR metadata persistence, preserved-branch cleanup after worktree removal, workspace base-conflict events, and SSH relay paths are driven through runtime contracts. |
| Source control and reviews | Go runtime + provider adapters | Go owns source-control projections and diffs for local/relay-fed workspaces, and Tauri local runtime RPC now maps `git.status`, `git.checkIgnored`, `git.submoduleStatus`, `git.diff`, `git.history`, `git.branchCompare`, `git.commitCompare`, `git.branchDiff`, `git.commitDiff`, stage/unstage/discard, commit, fetch/pull/push/fast-forward/rebase, abort merge/rebase, fork sync, remote file/commit URLs, `git.upstreamStatus`, and conflict-operation fallback to source-control projection/content-diff/history/compare/mutation endpoints so Source Control shows real changed files, branch/ahead/behind state, basic file diffs, history, branch/commit compare summaries, working-tree mutations, hosted links, and primary sync actions instead of `method_not_available`. Go now persists the created base SHA for local runtime-created worktrees, exposes a base-status reconcile endpoint, and Tauri fans out local `checking/current/drift/base_changed/unknown` plus publish-remote branch-conflict events through the existing renderer subscriptions. Tauri also maps local `hostedReview.*` runtime calls to typed unsupported-provider review states/results instead of falling through to unmapped runtime errors, so Source Control uses its normal blocked-review UX while provider adapters are still being migrated. Projection-level status now preserves staged/unstaged/untracked area plus rename `oldPath` for local git status and relay-fed projection updates; provider-hosted review creation/update/query backends, native AI text-generation host wiring, rich conflict/binary/submodule diff metadata, and remote/SSH base-status parity are explicit Tauri gaps instead of fake successful responses. | GitHub, GitLab, and provider-neutral review surfaces work in Tauri with no Electron-only IPC assumptions. |
| Browser/webview/automation | Rust/Tauri browser adapter + Go state | Go persists browser tabs/profiles/permissions/downloads, queues `browser.*` actions, supports profile deletion, and Tauri now bridges runtime profile create/list/delete, installed-browser profile detection for import pickers, download cancellation, `browser.changed` events, degraded provider registration, local runtime RPC profile/tab lifecycle mappings, and toolbar viewport override state into the Electron renderer contract. Runtime `browser.viewport` now returns explicit request dimensions or the stored page override so renderer scaling paths do not crash before the native adapter exists. Tauri WebView shims now register browser-page executors with the runtime action consumer, so queued `browser.goto`/reload/back/forward/stop actions complete against the active native WebView instead of being marked adapter-unavailable. Tauri also queues `browser.screenshot` through the same runtime provider action path and waits for provider completion, so callers either receive real `{ data, format }` output from a native adapter or a clear provider failure instead of an unmapped/mock response. Tauri also maps local `window.api.automations` plus `automation.*` runtime RPCs to Go `/v1/automations`, preserving the renderer's rich automation fields in runtime payloads and making automation list/create/update/delete, run listing, and manual Run Now use real runtime storage instead of web fallback empties. Go still accepts only manual/interval schedules, so RRULE scheduler execution, Electron renderer/headless dispatch, native precheck execution, and Hermes/OpenClaw external automation managers remain explicit Tauri gaps; binary screenshot capture, design-mode/CDP execution, cookie import, and richer WebView inspection still return explicit unsupported errors instead of fake success. | Browser tabs, screenshots, downloads, permissions, design mode, action polling/completion, and automation run through native adapters with mobile/CLI parity. |
| Deep links and protocol routing | Tauri/Rust + renderer runtime environment store | Tauri registers the `pebble` scheme, filters startup/opened URLs to Pebble protocol links, and routes `pebble://pair?...` into the same runtime environment add/status refresh path used by the settings UI. | macOS, Windows, and Linux app activation deep links open or focus Pebble, add validated runtime environments without exposing secrets, and reject unsupported routes without silent success. |
| Computer use and emulator | Rust adapters + Go queues (Zig reserved, not yet linked) | Native/browser/emulator action queues are exposed through Tauri commands, and macOS computer-use permission status/setup/reset now goes through the same `Pebble Computer Use.app` helper as Electron via native Tauri commands, with Linux/Windows still returning explicit unsupported permission states instead of fake success. | Accessibility trees, screenshots, safe actions, and iOS/Android device control work through provider queues; low-level platform accessibility primitives are the candidate future Zig scope. |
| Updates, release, diagnostics | Tauri updater/release service + Go release plans | Go release plans and Nebutra routes are tracked; Tauri checks `https://github.com/nebutra/pebble/releases.atom`, verifies platform updater manifests before surfacing an available version, and routes the result into the existing UpdateCard status flow instead of a separate popup. Tauri also initializes the native updater/process plugins, maps UpdateCard download progress to signed updater download/install, and relaunches through the native process plugin while preserving the renderer restart-bypass event contract. Renderer error-boundary crash reports, breadcrumbs, dismiss/sent state, copyable details, diagnostic bundle previews/uploads, and crash submissions with NDJSON attachments now flow through native commands instead of web mock APIs. Signed Tauri updater endpoints/public keys and release artifacts remain release-engineering gates. | Tauri signing, notarization, updater manifests, Nebutra diagnostics endpoints, release notes, and verified updater download/install are release-blocking checks. |

Zig layer status: `pebble/zig-system/` (see its README) is not wired into any
build today. It is reserved for two gaps that genuinely need a systems layer
once the Go/Rust path proves insufficient: a binary terminal output channel
(perf) and low-level platform accessibility primitives (native). PTY ownership
itself is Go's (`creack/pty`), not Zig's.

## Nebutra web route backfill

After the Pebble rename, the app and public assets should treat
`https://www.nebutra.com/pebble` as the product web root. The nebutra.com
project needs to serve these real routes so the app can stop depending on the
old product domain.

Path migration rule:

- Product pages: `https://onpebble.dev/<path>` -> `https://www.nebutra.com/pebble/<path>`
- Product root: `https://onpebble.dev` -> `https://www.nebutra.com/pebble`
- Docs pages: `https://onpebble.dev/docs/<path>` -> `https://www.nebutra.com/pebble/docs/<path>`

Required Nebutra routes:

| Legacy route | Nebutra route | Surface | Status |
| --- | --- | --- | --- |
| `https://onpebble.dev` | `https://www.nebutra.com/pebble` | Product landing page | App/README/Homebrew links migrated; nebutra.com must serve it. |
| `https://onpebble.dev/download` | `https://www.nebutra.com/pebble/download` | Download page | App/README links migrated; nebutra.com must serve it. |
| `https://onpebble.dev/docs/*` | `https://www.nebutra.com/pebble/docs/*` | Mintlify docs | App/README/mobile links migrated; route list below. |
| `https://onpebble.dev/whats-new/changelog.json` | `https://www.nebutra.com/pebble/whats-new/changelog.json` | Update changelog feed | App now reads the Nebutra route; nebutra.com must serve static JSON. |
| `https://onpebble.dev/whats-new/nudge.json` | `https://www.nebutra.com/pebble/whats-new/nudge.json` | Update nudge feed | App now reads the Nebutra route; nebutra.com must serve static JSON. |
| `https://onpebble.dev/media/*` | `https://www.nebutra.com/pebble/media/*` | Changelog media assets | Feed media should use this static bucket/object-prefix route. |
| `https://www.onpebble.dev/diagnostics/token` | `https://www.nebutra.com/pebble/diagnostics/token` | Crash diagnostics token | Release workflows now compile official builds against the Nebutra route; nebutra.com must serve or proxy it. |
| `https://www.onpebble.dev/v1/feedback` | `https://www.nebutra.com/pebble/v1/feedback` | Feedback submission API | App now posts only to the Nebutra route; dynamic POST route or proxy required. |
| `https://api.onpebble.dev/v1/feedback` | `https://www.nebutra.com/pebble/v1/feedback` | Feedback fallback API | Legacy fallback removed from app; keep this listed only for external redirect/proxy cleanup. |

## Mintlify docs route backfill

Canonical docs base:

- `https://www.nebutra.com/pebble/docs`

Routes currently referenced by the app, README, localized READMEs, telemetry surfaces, mobile settings, and feature-wall entry points:

- `/pebble/docs`
- `/pebble/docs/mobile`
- `/pebble/docs/model/worktrees`
- `/pebble/docs/terminal`
- `/pebble/docs/browser/design-mode`
- `/pebble/docs/review/linear`
- `/pebble/docs/ssh`
- `/pebble/docs/review/annotate-ai-diff`
- `/pebble/docs/editing/file-explorer`
- `/pebble/docs/cli/overview`
- `/pebble/docs/model/quick-open`
- `/pebble/docs/agents/usage-tracking`
- `/pebble/docs/editing/markdown`
- `/pebble/docs/editing/viewers`
- `/pebble/docs/cli/computer-use`
- `/pebble/docs/notifications`
- `/pebble/docs/telemetry`
- `/pebble/docs/privacy`
- `/pebble/docs/agents/supported`
- `/pebble/docs/tasks`

## Product web/static feed gaps

These are not normal docs pages. The app now points at these Nebutra routes, so the nebutra.com project must serve them before public release:

- `https://www.nebutra.com/pebble/whats-new/changelog.json`
- `https://www.nebutra.com/pebble/whats-new/nudge.json`
- Changelog media URLs should move to `https://www.nebutra.com/pebble/media/*`
- `https://www.nebutra.com/pebble/diagnostics/token`

This feedback endpoint still needs a Nebutra-owned dynamic POST handler or proxy:

- `https://www.nebutra.com/pebble/v1/feedback`

The in-app changelog and update card currently link release notes to GitHub Releases:

- `https://github.com/nebutra/pebble/releases`
- `https://github.com/nebutra/pebble/releases/tag/<tag>`

## Remaining rename/productization gaps

These are outside the product-site/docs route migration above:

- Nebutra.com must implement or proxy these runtime routes now referenced by the app:
  - `GET /pebble/whats-new/changelog.json`
  - `GET /pebble/whats-new/nudge.json`
  - `GET /pebble/media/*`
  - `GET /pebble/diagnostics/token`
  - `POST /pebble/v1/feedback`
- Brand assets now use a Pebble candidate mark instead of the legacy whale glyph. Final brand QA should still settle the source-of-truth vector/bitmap set and regenerate any marketing-only collateral.
- Historical/internal design docs have been migrated from legacy product
  wording, CLI examples, local paths, and reference links to Pebble naming.
