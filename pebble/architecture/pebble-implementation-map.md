# Pebble Implementation Map

This map defines ownership boundaries for a Pebble implementation. It is written as
an implementation contract: each subsystem must become a standalone service or
library with explicit API boundaries before old Electron-owned behavior is
removed.

## Language Ownership

| Area | Primary language | Reason |
| --- | --- | --- |
| Runtime service graph | Go | Long-lived concurrent services, cancellation, RPC, orchestration. |
| Repo/worktree/git providers | Go | Process orchestration, network API clients, portable filesystem handling. |
| Agent lifecycle | Go | Many independent process sessions and supervised state machines. |
| Terminal API | Go + Zig | Go owns sessions and routing; Zig owns PTY/signal/platform primitives. |
| Browser bridge | Rust + Go | Rust owns desktop WebView/security boundary; Go owns runtime-facing session state. |
| Computer-use providers | Rust + Zig | Platform APIs, capability gating, native binary surfaces. |
| Desktop app shell | Rust/Tauri | Window lifecycle, native menus, IPC boundary. |
| Desktop UI | React in Tauri | Preserve rich workbench semantics while removing Electron. |
| Mobile app | React Native | Native companion with shared runtime protocol. |
| Relay | Go | Remote daemon, reconnects, local socket/websocket transport. |
| Release/update | Rust + platform scripts | Tauri signing/updater and per-platform packaging. |

## Service Boundaries

### Runtime Gateway

Owns local authentication, version negotiation, request dispatch, streaming
events, and mobile method allowlists. This replaces Electron IPC and current
runtime RPC as a standalone daemon.

Current implementation:

- Go records native provider registration and derives browser/computer/emulator subsystem status,
  including ready/running/degraded/error state, from validated, TTL-bound provider reports.
- Go runtime HTTP can enforce an optional bearer token for control-plane APIs while leaving mobile
  relay WebSocket authentication to pairing secrets and encrypted sessions.
- Tauri can launch and stop a local `pebble-runtime` process for the desktop development loop while
  preserving the same HTTP gateway and bearer-token boundary used by external runtimes; source
  checkouts can fall back to `go run ./cmd/pebble-runtime` from `go-runtime` until packaged sidecars
  exist.
- Go exposes `/v1/events` as a server-sent event stream with event IDs; Rust/Tauri,
  desktop UI, and `pebble-control events` can read bounded, topic-filtered batches from that stream
  for runtime diagnostics.

### Workspace Service

Owns projects, repos, folder workspaces, worktree lineage, workspace metadata,
and cleanup policies.

Current implementation:

- Go persists projects and worktrees, supports project metadata updates/deletes, and removes
  worktree metadata without deleting files from disk.
- Project `locationKind` is validated to `local` or `ssh`; SSH workspaces must use relay-backed
  file, source-control, and session flows instead of accidental local execution, and SSH projects
  require a `hostId` so relay-fed state is scoped to an explicit remote host.

### Terminal Service

Owns terminal session lifecycle, PTY binding, shell injection, foreground process
tracking, agent launch, output buffering, and local/remote routing.

### Agent Lifecycle Service

Owns agent profiles, profile mutation, process-backed agent runs, prompt injection policy, and run
stop semantics.

Current implementation:

- Go persists agent profiles/runs, supports profile update/delete, and stops runs through the
  terminal session lifecycle.

### Orchestration Service

Owns task DAGs, dispatches, messages, decision gates, worker state, heartbeats,
and long-poll/event-stream delivery.

Current implementation:

- Go persists tasks, messages, replies, and dispatches; dispatch completion/failure updates the
  parent task state.

### Automation Service

Owns saved automation definitions, schedule metadata, trigger evaluation, run audit records, and
runtime actions that create or dispatch work without assuming local-only execution.

Current implementation:

- Go persists automation definitions and run records, supports manual and interval triggers, and
  executes actions through existing task, message, dispatch, agent-run, and computer-action
  services.
- HTTP and CLI expose automation create/update/delete/list, run listing, manual triggering, and
  interval evaluation endpoints.

### External Task Service

Owns provider-neutral records for Linear/Jira tickets and git-provider review surfaces, including
links back to internal orchestration tasks and workspace/repository metadata.

Current implementation:

- Go persists external work items for Linear, Jira, GitHub, GitLab, Bitbucket, Azure DevOps, and
  generic providers without using GitHub-only review naming.
- External work items can upsert provider state, create or link internal orchestration tasks, and
  filter by provider, kind, project, task, repository, or workspace through HTTP and CLI.

### Source Control Service

Owns git operations and provider-specific review surfaces. Provider differences
must stay explicit so generic review concepts do not become GitHub-only.

Current implementation:

- Go exposes local git status projections and file-scoped diff retrieval through the runtime
  gateway, with diff pathspecs constrained to workspace-relative paths.
- SSH/remote source-control projections can be updated by relay workers through the runtime
  gateway; direct git status/diff execution still returns relay-required errors without a worker.
  The runtime normalizes external changed-file status values, drops invalid workspace paths, and
  infers dirty sync state from non-empty changes before caching projections.
- `pebble-relay-worker git-status` can run in an SSH workspace and upsert provider-neutral git status
  projections with normalized changed-file statuses for remote source-control views.
- `pebble-control source-control update` can also attach repeated changed-file entries for manual
  relay diagnostics or provider integrations that already computed repository state.

### File Service

Owns project/worktree file tree listing, text preview, and writeback for editor surfaces. Remote
workspaces must route through relay workers instead of assuming the desktop host can read paths.

Current implementation:

- Go exposes local file tree, read, and write APIs with workspace-relative path traversal and
  symlink escape protection plus read-size limits.
- SSH/remote projects can serve cached file tree and content snapshots once relay workers upsert
  remote state; missing snapshots still return relay-required errors.
- `pebble-relay-worker` can run in a remote workspace and post file tree/content snapshots back to
  the runtime without requiring desktop-local filesystem access. Relay file reads resolve symlinks
  before reading and reject paths that escape the remote workspace root.

### Browser Service

Owns browser tabs, profiles, downloads, permissions, screenshots, automation
commands, and render streams. Tauri WebView is not a drop-in Electron WebContents
replacement, so this service must support multiple browser backends.

Current implementation:

- Go persists browser tabs and supports create, update, and close transitions over the runtime
  gateway.
- Go exposes tab-scoped browser command queuing so desktop, CLI, and mobile callers all create the
  same provider-consumable `browser.*` actions.
- Go persists browser profiles, supports browser profile deletion, clears profile-scoped
  permissions, falls tabs back to the default profile, and stores download lifecycle records so
  native browser adapters can report state without coupling to Electron WebContents.
- Go queues explicit `browser.download` provider actions from download records so binary transfer
  execution stays in the native adapter boundary.
- CLI/provider callers can report browser download filename, path, byte progress, and error
  metadata through the same download update route.
- Go records browser screenshot references and exposes `browser.screenshot` provider commands;
  CLI/provider callers can report screenshot URI metadata, while binary capture remains in the
  native adapter boundary.
- Rust/Tauri expose browser action poll/update commands that claim only `browser.*` runtime actions
  and report completion through the shared computer-action endpoint.
- The Tauri desktop shell bridges runtime browser profiles, download cancellation, and
  `browser.changed` events into the existing Electron renderer contract, while registering a
  degraded browser provider until native WebView/CDP execution is available.
- Rust/Tauri can register the desktop browser action bridge with `/v1/providers`, so runtime,
  desktop, and mobile projections show whether the native bridge is online; the desktop shell
  refreshes registration while connected so stale persisted providers do not claim readiness.
- Mobile projections replace full browser tab and download lists on runtime events so closed tabs
  and completed/removed provider records do not linger.
- Native page rendering plus binary screenshot capture and download execution remain assigned to
  browser adapters.

### Computer Service

Owns accessibility trees, screenshots, actions, cursor/keyboard safety checks,
and platform providers for macOS, Linux, and Windows.

Current implementation:

- Go owns persisted action queues and status transitions.
- Rust host exposes native-provider claim and completion commands over the runtime HTTP contract.
- `pebble-control computer queue` can attach JSON payloads for provider diagnostics and
  integration tests.
- Tauri exports these commands to the desktop shell without tying them to a specific platform
  provider, and the desktop UI can poll native/browser/emulator queues and mark actions completed
  or failed.
- Mobile projections expose computer action queue status so paired devices can inspect native
  provider work without polling provider-specific endpoints.
- Zig exposes the low-level C ABI that native providers can use for process, PTY, and signal
  primitives.

### Emulator Service

Owns iOS and Android device discovery, install/launch, gestures, screenshots,
accessibility trees, logs, and relay streaming.

Current implementation:

- Go persists emulator devices and attach sessions, including provider status/error updates and
  session detach semantics.
- Go exposes active-session emulator command queues so native iOS/Android adapters can claim
  gestures, installs, launches, screenshots, and log requests through the shared action contract.
- `pebble-control emulator command` can attach a JSON payload for coordinates, text input, bundle
  identifiers, or adapter-specific command parameters during relay diagnostics.
- Platform discovery, gestures, screenshots, install/launch, and logs still belong in the native
  iOS/Android adapters.

### Mobile Relay Service

Owns pairing, device identity, encrypted websocket sessions, mobile event
subscriptions, and server-side projection of desktop state.

Current implementation:

- Go owns pairing code issuance, persisted pairing records, pairing-secret validation, and the
  `/v1/mobile-relay` WebSocket transport, including fragmented client text-frame assembly.
- Unpaired WebSocket clients can only attempt `pair.start`; projection subscriptions and runtime
  commands require a paired device via encrypted handshake or pairing-secret `client.hello`.
- Paired connections can upgrade to encrypted envelopes through X25519, HKDF-SHA256, and
  AES-256-GCM before runtime projections or commands are exchanged.
- React Native owns a crypto provider interface, a local Expo `PebbleRelayCrypto` bridge, a
  WebCrypto fallback for platforms that expose SubtleCrypto, and an app-level crypto self-test.
- Pairing secrets are persisted through Expo SecureStore when the platform provides secure storage,
  while non-secret reconnect metadata remains in AsyncStorage. If SecureStore is unavailable, the
  pairing secret is not written to AsyncStorage and the stored pairing is not restored after reload.
- Runtime events are transformed into mobile projection events instead of leaking raw desktop
  service payloads to the React Native client.
- Snapshot projections currently cover terminals, agents, structured source-control dirty state,
  browser tabs/downloads, project/worktree files, orchestration tasks/messages/dispatches, automations,
  external tasks, release plan readiness, native provider readiness, computer action queues, emulator
  devices/sessions, settings, and keybindings.
- HTTP and CLI projection reads can request specific projection kinds and terminal output limits,
  which keeps diagnostics bounded as more mobile views are added.
- Browser commands from mobile are queued into the runtime computer-action surface until the native
  browser adapter executes them.
- File read/write commands from mobile are routed through the runtime file service so local path
  validation and remote relay-required behavior stay in one place.
- Native iOS/Android packaged-build validation of the `PebbleRelayCrypto` bridge is represented in
  default release checks, while `verify:native-crypto` covers the source-level module contract.

### Release And Update Service

Owns release plans, required artifacts, update manifests, signing/notarization checks, and the gate
that keeps a release from publishing before platform requirements are complete.

Current implementation:

- Go persists release plans with default required macOS, Windows, Linux, and updater-manifest
  artifacts.
- Artifact and check updates recompute readiness, and publishing remains blocked unless all
  requirements pass or an explicit force flag is used.
- Artifact platforms are constrained to generic, Linux, macOS, and Windows; artifact sizes must be
  non-negative and provided SHA-256 values must be real 64-character hex digests.
- The default release check set includes iOS/Android mobile packaged-build validation and native
  relay crypto bridge validation, so publish readiness cannot skip the mobile companion.
- Ordinary release updates cannot directly set computed `ready` or `published` status; publishing
  must pass through the publish gate.
- HTTP and CLI expose release create/update/list, artifact upsert, check update, generated manifest,
  and publish gate commands for CI integration.

### Settings Service

Owns persisted runtime settings and user keybindings for desktop/workbench surfaces. Shortcut
storage must remain platform-neutral so UI labels can render per operating system.

Current implementation:

- Go persists global, project, and workspace scoped settings.
- Keybindings store command ids, context, optional platform, enabled state, and `CmdOrCtrl` style
  accelerators through HTTP and CLI.

### Desktop Shell Mainline

Owns the product workbench shell after Electron exits. Tauri must load the canonical React renderer
and treat the Electron app only as a temporary screenshot and behavior reference during parity work.

Current implementation:

- `desktop-tauri` imports the root `@/App` renderer and root renderer stylesheet so shell migration
  does not fork the workbench UI into a mock or reduced surface.
- The Tauri shell is required to preserve pixel parity with the Electron reference; copied TSX is
  acceptable only when it is a deliberate migration step toward the same product surface, not a
  placeholder or simplified alternate UI.
- Tauri uses Pebble product identity and the Electron fallback window dimensions as the current
  baseline for pixel-level parity.
- Tauri installs renderer-side native shell bridges for window close guards, maximize/fullscreen
  state, native menu construction, titlebar menu popup, app-menu paste, help/settings events,
  sidebar toggles, Appearance menu settings state, and zoom routed through the same renderer
  callbacks Electron uses.
- Tauri replaces the web shell no-ops with native Rust commands for validated file-manager reveal,
  external editor/default app launch, URL/file URI open, path existence checks, attachment/image/
  audio/directory pickers, repo-icon PNG import, and no-overwrite file copy.
- Tauri wraps the web-compatible settings and UI state APIs with renderer-visible change events so
  menu actions can update the canonical store the same way Electron main-process broadcasts do.
- Tauri persists pairing-backed remote runtime environments through native Rust commands that read
  and write `pebble-environments.json`, validate `pebble://pair?...` payloads, redact device
  secrets from renderer responses, and harden the credential file on supported platforms.
- Tauri registers the `pebble` scheme, filters startup and opened URL events to Pebble protocol
  links, and routes `pebble://pair?...` through the runtime environment add/status refresh path.
- Tauri maps workspace-backed renderer `pty` calls onto Go runtime process sessions for the
  migration path: spawn starts `/v1/sessions`, input writes `/input`, output/status events feed the
  renderer through the existing `pty.onData`/`pty.onExit` contract, and stop maps to session delete.
  This is a fallback bridge, not the final Zig-backed PTY implementation.
- Tauri detects installed local CLI agents by reusing the shared `TUI_AGENT_CONFIG` command catalog
  and a native Rust PATH/install-dir probe, so agent settings and launch surfaces are no longer fed
  mock empty detection results.
- Tauri exposes updater version/status events and menu-triggered check errors so updater surfaces no
  longer silently no-op, and now checks the Nebutra/Pebble GitHub release feed plus platform
  manifests before feeding the existing UpdateCard `available`/`not-available`/`error` states.
  Actual Tauri updater download/install remains owned by the release/update service gate.
- Tauri replaces the web crash-report mock with native commands for renderer error-boundary
  reports, breadcrumbs, pending/latest lookup, dismiss/sent transitions, copyable crash text, and
  Nebutra crash feedback submission. Diagnostic bundle attachment is explicit `not_uploaded` until
  the native diagnostics collector is wired.
- `verify-tauri-mainline.mjs` checks the renderer entry, preload bridge, Vite aliasing, CSS source,
  Tauri identity, window bounds, native window/menu/settings/shell bridges, runtime PTY fallback,
  remote runtime environment store commands, preflight agent detection, deep-link routing, updater
  release-feed checks, crash-report persistence, browser runtime bridge, local mock-UI drift, and
  Roadmap commitment before shell changes are accepted.

## Migration Rule

Every migrated feature must move through this sequence:

1. Define or extend a contract under `contracts/`.
2. Implement runtime-owned behavior in Go/Rust/Zig.
3. Add CLI and desktop/mobile call sites.
4. Add focused tests at the service boundary.
5. Only then remove or bypass the corresponding Electron/TypeScript path.

Direct line-by-line translation from Electron main into a single Go or Rust
module is not allowed because it would preserve the current coupling.
Electron is not a destination architecture; it is only the parity reference
until Tauri plus the Go/Rust/Zig runtime path proves the same behavior.
