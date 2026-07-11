# Pebble Implementation Map

This map defines ownership boundaries for a Pebble implementation. It is written as
an implementation contract: each subsystem must become a standalone service or
library with explicit API boundaries before old Electron-owned behavior is
removed.

## Language Ownership

| Area                        | Primary language                    | Reason                                                                                                                                |
| --------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime service graph       | Go                                  | Long-lived concurrent services, cancellation, RPC, orchestration.                                                                     |
| Repo/worktree/git providers | Go                                  | Process orchestration, network API clients, portable filesystem handling.                                                             |
| Agent lifecycle             | Go                                  | Many independent process sessions and supervised state machines.                                                                      |
| Terminal API                | Go                                  | Go owns sessions, routing, and PTY spawn/winsize (`creack/pty`); Zig is unlinked, reserved only for a future binary output channel.   |
| Browser bridge              | Rust + Go                           | Rust owns desktop WebView/security boundary; Go owns runtime-facing session state.                                                    |
| Computer-use providers      | Rust (Zig reserved, not yet linked) | Platform APIs, capability gating, native binary surfaces; Zig is a candidate future home for low-level accessibility primitives only. |
| Desktop app shell           | Rust/Tauri                          | Window lifecycle, native menus, IPC boundary.                                                                                         |
| Desktop UI                  | React in Tauri                      | Preserve rich workbench semantics while removing Electron.                                                                            |
| Mobile app                  | React Native                        | Native companion with shared runtime protocol.                                                                                        |
| Relay                       | Go                                  | Remote daemon, reconnects, local socket/websocket transport.                                                                          |
| Release/update              | Rust + platform scripts             | Tauri signing/updater and per-platform packaging.                                                                                     |

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
- Tauri can launch and stop a local `pebble-runtime` process while preserving the same HTTP gateway
  and bearer-token boundary used by external runtimes. Dev and release builds generate
  target-qualified `pebble-runtime` and `pebble-relay-worker` sidecars; macOS universal builds lipo
  arm64 and amd64 Go outputs. The Rust host resolves the bundled runtime first, while source
  checkouts retain a `go run ./cmd/pebble-runtime` fallback.
- Go exposes `/v1/events` as a server-sent event stream with event IDs; Rust/Tauri,
  desktop UI, and `pebble-control events` can read bounded, topic-filtered batches from that stream
  for runtime diagnostics.
- Tauri starts a native event-push bridge for `/v1/events`, re-emits runtime events to the
  renderer, and keeps the renderer polling fallback active until a connected status is observed.
- Go exposes `/v1/host/terminal-capabilities`, and Tauri maps `host.platform`,
  `host.wsl.*`, `host.pwsh.isAvailable`, and `host.gitBash.isAvailable` runtime calls onto that
  endpoint instead of returning unmapped host capability errors.
- Go persists SSH targets and runs bounded connectivity probes; Tauri maps target
  list/import/CRUD plus connect/disconnect UI state onto those probe results without claiming the
  SSH relay/PTY stack is complete. Auto-connect passphrase gating reads the persisted
  `lastRequiredPassphrase` target flag instead of returning a fixed false, and the runtime hosts a
  memory-only per-target credential cache (`/v1/ssh-targets/{id}/credential` seed/status/clear;
  Electron `SshConnection` cachedPassphrase/cachedPassword parity) so an already-unlocked target
  does not re-prompt within a runtime lifetime. Credentials are never written to the state file;
  the cache is cleared on disconnect and target removal, and the desktop re-seeds after restart.
- Go owns system-OpenSSH local port-forward processes, durable forward configuration, reconnect
  restoration, target-scoped cleanup, and legacy forward-ID migration. The deployed relay worker
  detects Linux/macOS listening ports, while bounded raw SSH directory browsing preserves the
  pre-project picker contract. Tauri exposes CRUD/list/change events, detected-port polling, and
  directory browsing without inheriting the web client's empty mocks.

### Workspace Service

Owns projects, repos, folder workspaces, worktree lineage, workspace metadata,
and cleanup policies.

Current implementation:

- Go persists projects and worktrees, supports project metadata updates/deletes, persists project
  order, and can run bounded local `git worktree remove` before deleting Tauri-created worktree
  records. Metadata-only deletion remains available for legacy/runtime bookkeeping paths. SSH
  worktree deletion and preserved-branch cleanup now run through `pebble-relay-worker
  worktree-remove`/`branch-delete`: the worker executes the shared host-side removal
  (`RemoveGitWorktreeOnHost`/`ForceDeleteGitBranchOnHost`) on the remote host and posts completions
  to `/v1/worktrees/remote-removals` and `/v1/worktrees/branches/remote-removals`, which retire the
  metadata record with the same preserved-branch contract as local deletions. Worktree removal
  (local and relay-backed) runs the project's `pebble.yaml` `scripts.archive` hook first, with
  Electron-parity cwd/env/shell/timeout; hook failure or timeout vetoes the removal with a typed
  409 instead of silently proceeding.
- Go persists worktree instance identity plus worktree/folder workspace lineage records, and Tauri
  bridges lineage list/set/create runtime calls into the existing renderer and CLI contracts.
- Go persists display/comment/archive/pin/read status, workspace status, manual order, and smart-sort
  order for worktrees; Tauri routes local and runtime RPC metadata writes through those runtime
  endpoints instead of renderer-only synthesis.
- Tauri emits renderer-correlated `fetching`/`creating` progress events around runtime worktree
  creation and now fans out local base-status plus remote-branch-conflict source-control events.
- Tauri maps local runtime `worktree.activate` to the existing renderer activation event path, so
  CLI/mobile-style activation requests use the same workspace selection flow as Electron instead
  of falling through to `method_not_available`.
- Project `locationKind` is validated to `local` or `ssh`; SSH workspaces must use relay-backed
  file, source-control, and session flows instead of accidental local execution, and SSH projects
  require a `hostId` so relay-fed state is scoped to an explicit remote host.
- Go now persists ProjectGroup objects plus full FolderWorkspace objects, including folder path,
  connection id, linked task, comment/archive/read/pin state, smart/manual ordering, workspace
  status, created agent, first-message rename state, and last activity. Tauri maps local
  `projectGroups` and `folderWorkspaces` preload APIs plus runtime `projectGroup.*` and
  `folderWorkspace.*` RPCs onto these Go routes. Local nested repo scan/import now runs through
  Go runtime routes with `.gitignore` filtering, sparse folder subgroups, existing-project reuse,
  and local worktree target normalization. Paired remote `connectionId` nested scan/import uses
  the same runtime environment RPC names, so the desktop host does not inspect SSH paths. Tauri
  now emits final scan progress events, lets the existing UI cancel active scan IDs into a stopped
  result, and gives scan/import calls renderer-aligned bounded timeouts. Go nested scan/import now
  threads the HTTP request context through the walk, so a dropped or cancelled request aborts the
  traversal and yields the same partial `stopped` result as the UI cancel flow. Scans carrying a
  `scanId` stream `project-group.scan-progress` snapshots (per-repo plus throttled directory-visit
  counts) over the existing event push channel, for local and relay scans alike. Relay-only
  (no paired runtime environment) nested scan/import now works too: `pebble-relay-worker
  scan-nested` runs the same walk on the remote host and posts cached snapshots the runtime
  serves through `projectGroup.scanNested`/`projectGroup.importNested` when the connection is
  relay-only.

### Terminal Service

Owns terminal session lifecycle, PTY binding, shell injection, foreground process
tracking, agent launch, output buffering, and local/remote routing.

Current implementation:

- Go PTY sessions persist geometry and output, track DEC alternate-screen transitions, and expose a
  bounded Unix process-table status probe with foreground process and child-process facts. Tauri
  `terminal.inspectProcess` consumes that status endpoint instead of guessing from the launch command.
- Windows uses a bounded PowerShell/CIM JSON process snapshot and descendant graph to report the
  deepest active lineage plus child-process facts; unlike Unix this is a lineage approximation
  because Windows exposes no equivalent terminal foreground marker.
- Windows process sessions use the OS ConPTY API through `go-pty`, including initial geometry,
  resize, bidirectional terminal streams, context cancellation, and process-tree lifecycle instead
  of the former stdin/stdout pipe approximation.
- SSH project sessions are real Go-managed PTYs whose child process is system OpenSSH. The resolver
  keeps remote cwd validation off the desktop filesystem, quotes cwd/argv as data, reuses the
  memory-only SSH credential cache, and preserves the original command in session metadata. All
  existing input/output/resize/tail/driver-lock APIs therefore work without an Electron relay PTY.
- Target-scoped termination resolves session project ownership through `project.hostId` and stops
  only sessions belonging to that SSH target; Tauri Settings calls the runtime route instead of a no-op.
- Reset Relay deduplicates concurrent resets, force-terminates those target-scoped PTYs, clears the
  memory-only credential cache, terminates target-scoped forward processes, and then emits
  disconnected state. Ordinary Disconnect also stops live forwards but preserves their durable
  configuration so the next successful connection restores them.

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

- Go persists automation definitions and run records, supports manual, interval, and RRULE
  triggers, and executes actions through existing task, message, dispatch, agent-run, and
  computer-action services. RRULE evaluation uses `github.com/teambition/rrule-go` and supports the
  DAILY/WEEKLY/MONTHLY subset (with INTERVAL/BYDAY/UNTIL/COUNT) that the Electron reference schedule
  builder actually emits; other frequencies (e.g. YEARLY) are rejected at create/update time.
- HTTP and CLI expose automation create/update/delete/list, run listing, manual triggering, and
  interval/RRULE evaluation endpoints (`pebble-control automation add/update --schedule rrule
--rrule <RFC5545> --dtstart <RFC3339>`).
- Tauri maps local `window.api.automations` and `automation.*` runtime RPC calls onto the Go
  automation HTTP routes, preserving the renderer's rich automation fields inside runtime payloads
  so list/create/update/delete, run listing, manual Run Now, and RRULE scheduling are backed by real
  runtime storage. Rust also owns local Hermes/OpenClaw external-manager discovery, bounded CLI
  lifecycle mutations, and paged local Hermes Markdown plus `state.db` run-history hydration while
  the renderer reuses the canonical job mappers. Go deploys a purpose-scoped relay worker for SSH
  Hermes/OpenClaw discovery, bounded mutations, run counts, and paged Hermes Markdown plus
  CGO-free SQLite transcript history using the same 24-hour session/output merge rule as Electron.
- Go evaluates missed scheduled occurrences against the renderer-authored grace window, records
  out-of-window runs as `skipped_missed` at their original occurrence time without dispatching,
  and advances the recurrence from the current scheduler time.
- Go executes automation prechecks natively: a bounded shell command (default 60s, max 600s
  timeout, exit 0 = pass) gates scheduled triggers in the automation's working directory (explicit
  `workingDir`, payload `cwd`, or the targeted worktree/project path), records the full
  Electron-shaped result (`precheckResult`) on the run, and marks failed gates `skipped_precheck`
  without executing the action. Manual triggers bypass the precheck, matching Electron.
- The runtime runs its own scheduler tick (`RunAutomationScheduler`, one-minute interval in
  `pebble-runtime`) so due automations fire headlessly without a desktop shell polling
  `/v1/automations/evaluate`, and it strips the reserved `pebbleAutomation` renderer envelope from
  action payloads before decoding native action requests so renderer-authored automations execute
  instead of failing strict decode.
- Renderer dispatch flows over the runtime event push channel: passing (or precheck-free) triggers
  emit `automation.dispatch.requested`, and the Tauri bridge
  (`tauri-automation-dispatch-events.ts`) maps runs carrying the renderer envelope onto
  `window.api.automations.onDispatchRequested`, so the renderer's existing dispatch lifecycle
  (workspace create/reuse, agent terminal launch, completion bookkeeping) runs against the Go
  runtime. `runPrecheck` returns the natively recorded result rather than re-running the command.
- Tauri projects local Hermes/OpenClaw sources as explicit unavailable external managers instead of
  returning an empty fake state. `markDispatchResult` now writes the renderer's reported dispatch
  outcome back onto the Go `AutomationRun` record (`POST /v1/automations/runs/{id}/dispatch-result`)
  instead of only reading it back. External automation manager lifecycle execution (Hermes/OpenClaw
  create/update/pause/resume/run-now/delete) has landed via native Rust CLI invocation in
  `external_automations.rs` for local targets and the relay worker's equivalent action mapping for
  SSH targets, both driven through the same generic `mutateTauriExternalAutomation` dispatch.

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
- Tauri local runtime RPC maps renderer `git.status`, `git.upstreamStatus`, and conflict-operation
  fallback calls onto Go source-control projections so the canonical Source Control UI can render
  real changed-file and branch/ahead/behind state without Electron IPC. Tauri also maps `git.diff`
  to a Go content-diff endpoint for basic file diff viewing, maps `git.branchCompare`,
  `git.history`, `git.localBranches`, `git.checkout`, `git.commitCompare`, `git.branchDiff`, and
  `git.commitDiff` to bounded history/compare/ref-diff/branch commands, and maps
  stage/unstage/discard/commit plus fetch/pull/push/fast-forward/rebase, abort merge/rebase, fork
  sync, remote file/commit URL building, GitHub repo slug/upstream-remote identity, ignore checks,
  and basic submodule status to bounded Go git commands. Go also stores the created base SHA for local runtime-created worktrees
  and exposes base-status reconciliation, so Tauri can emit the existing renderer `worktree:baseStatus` and
  `worktree:remoteBranchConflict` subscription payloads without Electron IPC. The Go projection
  parser now preserves staged/unstaged/untracked areas and rename `oldPath` through the Tauri
  status mapper. Tauri maps GitHub PR checks, GitLab MR listing, and existing hosted-review
  branch lookup through local Go provider routes; Tauri also maps GitHub/GitLab hosted-review
  capabilities and creation onto Go provider routes, including worktree selector resolution,
  so local Create PR/MR no longer falls through to an unsupported-provider placeholder.
  Tauri preload now overrides the web fallback git generation API with native local commit-message
  and pull-request field generation: Rust reads staged/base diff context and runs bounded,
  cancelable agent plans while shared prompt/parser code keeps renderer output parity. Go's
  Create PR/MR template hydration now matches Electron's full candidate list (`.github/`,
  `.azuredevops/`, `.gitea/`, root, and `docs/` paths, with GitLab falling back to the generic PR
  candidates after its own `.gitlab/` paths), and `GitRepositoryIdentity` falls back to a `gh repo
  view --json isFork,parent` lookup for the fork-parent owner/repo when no local `upstream` remote
  is configured, mirroring Electron's `getRepoUpstream`. A parallel `/v1/providers/reviews/update`
  route now covers the realistic post-creation mutation set Electron supports (title/body edit,
  reviewer add/remove, close/reopen) for GitHub via `gh pr edit/close/reopen` and GitLab via `glab
  api PUT`/`mr close`/`mr reopen`; GitLab's reviewer set is a full-list REST replace in Electron
  (not an add/remove delta), so incremental reviewer mutation for GitLab stays an explicit gap
  (GitLab's retarget-base/draft-toggle also stay unimplemented, matching Electron). Bitbucket, Azure
  DevOps, and Gitea now have native creation and update alongside their existing REST-backed
  listing: `CreateBitbucketPR`/`CreateAzureDevOpsPR`/`CreateGiteaPR` POST to each provider's pull
  request collection endpoint, and `UpdateBitbucketPR`/`UpdateAzureDevOpsPR`/`UpdateGiteaPR` mutate
  title/body/reviewers/state on the same resource (Bitbucket via PUT plus a `/decline` state-
  transition call, Azure DevOps and Gitea via PATCH), reusing each provider's existing
  Config/authHeaders/repo-ref machinery and dispatched through the same `CreateHostedReview`/
  `UpdateHostedReview` provider switch GitHub/GitLab use. Three real per-provider limitations are
  explicit gaps rather than silently approximated: Bitbucket Cloud has no reopen endpoint for a
  declined PR (closing is one-way; the code and doc both say so) and no incremental reviewer add/
  remove (its PR update endpoint only replaces the full reviewer list, so add/remove requests return
  an explicit unsupported result); Azure DevOps has no "closed"/"open" status of its own (only
  active/abandoned/completed), so close/reopen map to its real `abandoned`/`active` transitions as
  the closest equivalent rather than a faithful pair (a completed/merged PR cannot be un-completed
  through this path). Go now parses porcelain unmerged states into Electron's exact conflict-kind
  union with merge/rebase/cherry-pick operation detection, exposes binary diff byte sizes/image-mime
  flags, synthesizes submodule pointer diffs with structured old/new SHA metadata, and lets relay
  workers report remote base-status drift through the same reconcile endpoint used locally.
  Remote/SSH text-generation relay parity is now closed: `pebble-relay-worker
  git-text-generation-context` builds the same staged-diff (commit message) or base-vs-head diff/log
  (pull request fields) context the local Rust command reads, but against the remote git checkout on
  the SSH host; Go's `POST /v1/ssh-targets/{id}/git-text-generation-context` route execs that
  subcommand over a direct system-ssh call (the same non-interactive connection args as
  `ProbeSshTarget`) and returns its JSON stdout. Tauri's `generateTauriCommitMessage` /
  `generateTauriPullRequestFields` call this route instead of failing immediately when
  `connectionId` is set, then build the identical prompt via the shared
  `buildCommitMessagePrompt`/`buildPullRequestFieldsPrompt` helpers and run the same local
  `runTauriPlan` agent execution as the local path — only the git context's source (local Rust vs.
  SSH relay) differs, not how the agent CLI is invoked. Remaining gap: this still assumes the relay
  worker binary is already deployed and reachable on the remote host's `PATH`; a host with no relay
  worker installed surfaces a relay-context fetch error instead of falling back.
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
- Go exposes local file create, directory create, chunk read/write, base64 upload write, server
  directory browse, rename, copy, delete, stat, quick-open list, markdown document list, and
  bounded text search APIs through the runtime gateway. Tauri maps the canonical renderer file
  explorer RPCs onto these endpoints, including binary/image preview responses for supported
  viewer types, so common browse/edit/upload/CRUD/search workflows no longer depend on Electron
  IPC. For SSH worktrees backed by paired runtime environments, Tauri proxies the same file
  explorer read/preview/chunk/write/CRUD/search/document RPCs to the owning runtime instead of
  touching remote paths from the desktop host. Tauri also overrides the web preload's file-watch
  no-op with a Rust `notify` watcher for local worktrees and bridges SSH/remote watches through
  runtime-environment `files.watch` subscriptions, emitting the same Electron-compatible
  `fs:changed` payloads in both cases.
  Tauri also resolves terminal-tapped worktree paths and grants local temp-file terminal artifacts
  through native Rust commands with recent-output provenance, TTL, no-follow, stale-file, preview,
  and writeback checks. Paired remote runtime environments proxy the same terminal artifact RPCs
  and keep remote grant IDs scoped to the originating connection/worktree/path. Legacy SSH
  relay-only terminal artifact grants and richer binary viewer parity remain native file-adapter
  gaps.
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
- Go records browser screenshot references and exposes `browser.screenshot` provider commands.
  Tauri captures live child WebViews through AppKit, WebView2, or WebKitGTK and returns the existing
  base64 PNG/JPEG payload with optional CSS-coordinate cropping.
- Rust/Tauri expose browser action poll/update commands that claim only `browser.*` runtime actions
  and report completion through the shared computer-action endpoint.
- The Tauri desktop shell bridges runtime browser profiles, download cancellation, and
  `browser.changed` events into the existing Electron renderer contract, detects installed browser
  profile candidates for the import picker through a native Rust command, and registers a degraded
  browser provider until Chromium/Safari source-browser decryption and full CDP parity are available.
- Tauri local runtime RPC maps browser profile create/list/delete plus tab create/list/show/close
  lifecycle calls onto Go `/v1/browser/*` routes so renderer runtime callers do not fall back to
  `method_not_available` for stateful browser records.
- Tauri maps runtime `browser.goto`, `browser.back`, `browser.forward`, and `browser.reload` to
  Go browser provider actions while updating the tab projection first, so the native WebView
  provider can consume real queued navigation work instead of the desktop shell dropping those
  commands.
- Tauri WebView shims register page-scoped action executors with the browser action consumer, so
  queued `browser.goto`, reload, back, forward, and stop actions now complete against the active
  native WebView and report results back to the shared runtime action endpoint.
- Rust now owns child WebView creation for the Tauri browser surface. Isolated profiles receive a
  shared native data directory on Windows/Linux and a stable WebKit data-store identifier on
  macOS 14+, so tabs in one profile share cookies/storage while different profiles stay separated;
  the renderer only reacquires the created WebView handle for layout and compatibility events.
- Tauri WebView shims enable native child WebView devtools and route
  `window.api.browser.openDevTools` to the active child WebView label, so the browser toolbar and
  context-menu inspection controls have real behavior in the Tauri shell instead of returning
  a dead false.
- Tauri routes `sessionClearDefaultCookies` to live default-partition child WebViews and uses the
  native cookie store to enumerate and delete cookies only. Cache, local storage, and other browsing
  data are preserved, matching the renderer contract instead of over-clearing the session.
- Tauri manual cookie-file import now stays native end to end: Rust owns the file picker, enforces
  file/entry limits, validates cookie fields, writes HttpOnly/Secure/SameSite/expiry metadata through
  the matching child WebView cookie store, and returns only counts plus domain names. Direct import
  from installed Firefox profiles uses a bounded native SQLite snapshot; Chromium/Safari import
  remains gated until native credential decryption lands.
- Tauri maps the renderer's `findInPage` and `stopFindInPage` compatibility calls to bounded Rust
  commands for the active child WebView. Rust validates the browser-only child label, evaluates the
  native `window.find` request with a timeout, and returns Electron-shaped match events so the
  existing find UI remains functional without exposing arbitrary WebView evaluation to the renderer.
- Persisted browser annotation markers now render inside Tauri child WebViews through a structured
  Rust command. The host validates marker count, IDs, and finite non-negative geometry before
  injecting a closed-shadow visual overlay that follows page scroll; this does not enable element
  selection or claim the still-missing grab/CDP boundary.
- Tauri reuses the canonical Electron guest grab runtime through a browser-child-scoped Rust eval
  command with script-size and timeout bounds. Arm, click/right-click selection, hover extraction,
  cancellation, payload clamping, and annotation creation now keep the existing renderer UX and
  safety budgets. On macOS, selection capture hides grab/annotation overlays, maps the CSS rect to
  the WKWebView bitmap using independent display scales, clamps it, and returns a budgeted PNG.
- The renderer keeps manual JSON cookie-file import available under Tauri while presenting installed
  browser import as explicitly unavailable, instead of hiding both capabilities behind one gate.
- Tauri runtime RPC maps `browser.eval` to the live child WebView through the bounded Rust callback
  bridge and preserves the Electron `{ result, origin }` contract. Viewport and context-menu
  inspection work without claiming full CDP element/action parity.
- Tauri runtime RPC reuses the same native Firefox/profile cookie importer and default-cookie clear
  adapter as the desktop Browser API instead of returning fixed unsuccessful placeholders.
- Tauri runtime RPC queues `browser.screenshot` through the same provider action path and waits for
  the action result. The platform executor captures WKWebView, WebView2, or WebKitGTK through Rust
  and returns `{ data, format }` without another renderer contract change.
- Tauri records toolbar viewport overrides per browser page and runtime `browser.viewport` returns
  explicit request dimensions or the stored page override until the native WebView/CDP adapter
  exists, so renderer input-scaling paths do not crash while avoiding a fake claim that real
  viewport emulation is complete.
- Tauri child WebViews now use Wry's cross-platform native download hook. Rust assigns a
  collision-safe Downloads path, emits requested/finished events with a native correlation ID,
  and the renderer persists those transitions into Go browser download records so the existing
  `browser.changed` UI and mobile projections stay authoritative. On Windows, a second WebView2
  adapter retains `DownloadOperation` only on the UI thread, emits real byte progress, and routes
  cancel requests back through the owning WebView before marking the Go record canceled. macOS and
  Linux sample the growing destination file at 400ms intervals, emit only changed byte counts, and
  stop as soon as the native download leaves the registry.
- Rust/Tauri can register the desktop browser action bridge with `/v1/providers`, so runtime,
  desktop, and mobile projections show whether the native bridge is online; the desktop shell
  refreshes registration while connected so stale persisted providers do not claim readiness.
  Its degraded capability report now distinguishes working native WebView/find/annotation-overlay/
  cookie-clear, native download start/finish, and macOS/Windows/Linux full/selection screenshot
  paths from the remaining Chromium/Safari cookie decryption, macOS/Linux download cancellation,
  and CDP gaps. Firefox profile import uses a bounded native SQLite snapshot and the live child
  WebView cookie store.
- Tauri runtime RPC now exposes provider list/status/register through the same Go routes, so
  UI, mobile, and runtime diagnostics read the same TTL-bound provider truth instead of a preload
  stub.
- Mobile projections replace full browser tab and download lists on runtime events so closed tabs
  and completed/removed provider records do not linger.
- Native page rendering and macOS/Linux download cancellation remain assigned to browser adapters.

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
- Tauri routes macOS computer-use permission status, setup, and reset through the bundled
  `Pebble Computer Use.app` helper using the same TCC identity checks as Electron. On Linux and
  Windows, Tauri returns explicit unsupported permission states — this matches Electron exactly
  (`src/main/computer/macos-computer-use-permissions.ts` reports unsupported on every non-darwin
  platform), so it is full parity rather than a Tauri gap.
- Mobile projections expose computer action queue status so paired devices can inspect native
  provider work without polling provider-specific endpoints.
- `pebble/zig-system/` defines a candidate C ABI for process/PTY/signal primitives but is not
  linked into any build; it is a reserved future layer, not a current dependency (see its README).

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
- macOS: a native iOS Simulator adapter (`commands/emulator_ios_provider.rs`) reconciles
  `xcrun simctl list devices` into the Go device store and drains the `emulator.*` action queue
  for install/launch/screenshot (base64 PNG) via simctl; boot/shutdown recycling and idempotent
  simctl error handling follow Electron's `ios-emulator-backend.ts` patterns. Tap/swipe/pressKey/
  type/rotate/logs are honest typed gaps — simctl has no synthetic input or rotation API and no
  bounded log-tail primitive; Electron's parity mechanism is the third-party `serve-sim` helper
  (private CoreSimulator HID injection), which would need to be replaced by Facebook's `idb` or an
  XCTest UI-automation harness to close.
- Android device discovery, gestures, screenshots, install/launch, and logs still have no native
  adapter (out of scope for the iOS slice); non-macOS hosts also report an explicit unsupported gap.

### Mobile Relay Service

Owns pairing, device identity, encrypted websocket sessions, mobile event
subscriptions, and server-side projection of desktop state.

Current implementation:

- Go owns pairing code issuance, persisted pairing records, pairing-secret validation, and the
  `/v1/mobile-relay` WebSocket transport, including fragmented client text-frame assembly.
- Go exposes persisted mobile relay pairings as runtime access grants, supports revoking a pairing
  by device id, and Tauri maps the renderer's mobile device/access-grant list and revoke APIs to
  those runtime routes instead of the web preload's empty grant mock.
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
- Tauri backs local Git base-ref/default-branch lookups with native `git` commands so the
  canonical repository settings and worktree-create branch pickers no longer receive empty mock
  results.
- Tauri's Vite build uses a relative asset base so packaged WebViews load the hashed renderer
  scripts/styles from `frontendDist`; absolute `/assets/...` paths are treated as a white-screen
  regression.
- Tauri wraps the web-compatible settings and UI state APIs with renderer-visible change events so
  menu actions can update the canonical store the same way Electron main-process broadcasts do.
- Tauri persists pairing-backed remote runtime environments through native Rust commands that read
  and write `pebble-environments.json`, validate `pebble://pair?...` payloads, redact device
  secrets from renderer responses, and harden the credential file on supported platforms.
- Tauri registers the `pebble` scheme, filters startup and opened URL events to Pebble protocol
  links, and routes `pebble://pair?...` through the runtime environment add/status refresh path.
- Tauri maps workspace-backed renderer `pty` calls onto Go runtime process sessions for the
  migration path: spawn starts `/v1/sessions`, input writes `/input`, clearBuffer drops the runtime
  tail, output/status events feed the renderer through the existing `pty.onData`/`pty.onExit`
  contract, stop maps to session delete, and renderer-side resize/reportGeometry state preserves
  Electron's restore semantics until native winsize propagation lands. This is a fallback bridge;
  the runtime-owned PTY it targets is Go-backed (`creack/pty`), not Zig.
- Tauri local runtime RPC maps terminal create/list/resolveActive/show/read/send/wait/inspect/clear/stop/
  stopExact/focus/close/split/resolvePane/agent-status calls to Go process sessions so CLI,
  agent-note, sleep/restore, terminal-handle copy, local session-tab creation, and runtime-probe
  flows do not fall through to unmapped Electron-only methods. Tauri also exposes local
  `session.tabs.list/listAll/createTerminal/activate/close/move/updatePaneLayout/setTabProps/
subscribe/unsubscribe` snapshots and mutations from Go session records plus a Tauri-side tab
  state mirror instead of empty tab mocks. Go now persists tab moves on the live session record
  (`PATCH /v1/sessions/{id}` tab/leaf placement) and stores durable per-worktree tab/group/pane
  layout snapshots (`/v1/session-tab-layouts/{worktreeId}`) that survive runtime restarts, and
  tracks hook-reported idle/permission state per session (`POST /v1/sessions/{id}/hook-status`,
  accepting session id or launch token) with a blocking Go-side `POST /v1/sessions/{id}/wait`
  for `exit`/`tui-idle` that only hook-reported idle (never permission) satisfies, matching
  Electron's TUI readiness model. The runtime serves Electron's `POST /hook/{source}` hook
  transport and stamps `PEBBLE_AGENT_HOOK_*` env into spawned PTYs, and Tauri `terminal.wait`/
  `terminal.agentStatus` now ride the runtime wait/hook state. Session output streams for real:
  the runtime coalesces per-line chunks into bounded `session.output` events (25ms window, 32KB
  newest-tail cap with `coalescedChunks`/`droppedBytes` accounting) on `/v1/events`, and the
  Tauri push bridge maps them onto `pty.onData` with tail-polling kept as the fallback
  transport. Durable tab-layout persistence has a Tauri-side module
  (`tauri-session-tab-layout-persistence.ts`: rehydrate + debounced newest-wins write-back
  against `/v1/session-tab-layouts/{worktreeId}`). Remaining gap: wiring that module into the
  session-tab mirror's subscription state.
- Tauri local runtime RPC maps mobile/CLI files.list/open/openDiff plus file explorer
  read/readChunk/readPreview/write/writeBase64, create/rename/copy/delete/stat/list/search,
  upload chunk, and server directory browse calls to Go file endpoints and renderer file-open
  events. For SSH worktrees backed by paired runtime environments, Tauri proxies the
  same file explorer read/preview/chunk/write/CRUD/search/document RPCs to the owning runtime
  instead of touching remote paths from the desktop host. Tauri file watching uses Rust `notify`
  for local worktrees and runtime-environment `files.watch` subscriptions for SSH/remote
  worktrees, emitting the renderer's existing `fs:changed` payload shape instead of the web no-op.
  Tauri resolves terminal-tapped worktree paths and grants local temp-file terminal artifacts
  through native Rust commands with recent-output provenance, TTL, no-follow, stale-file, preview,
  and writeback checks. Paired remote runtime environments proxy the same terminal artifact RPCs
  and keep remote grant IDs scoped to the originating connection/worktree/path. Legacy SSH
  relay-only terminal artifact grants and richer binary viewer parity remain native file-adapter
  gaps.
- Tauri now maps runtime-backed agent sessions into the existing renderer `agentStatus` IPC
  contract instead of leaving the Activity/Agents page on the web mock: spawn records the real
  `tabId`/`leafId` pane key, runtime `session.status` events emit `working`/`blocked`/`done`
  semantics, failed runtime sessions stay visible as blocked work needing attention, kill maps to
  interrupted completion, and `/v1/sessions` snapshots carry tab/leaf/launch metadata so hot reload
  can rehydrate live agent rows.
- Tauri reconciles Claude, OpenClaude, Gemini, Cursor, Droid, Command Code, Grok, Devin, Kimi, and Amp managed hooks through Rust at startup and whenever the
  canonical `agentStatusHooksEnabled` setting changes. The native host preserves unrelated hook
  definitions, writes executable scripts before atomically replacing settings JSON, and removes
  only Pebble-owned entries on opt-out. Gemini preserves its `{}` stdout response, 10-second
  millisecond-form timeout, current event set, and stale `PreToolUse` cleanup. Windows commands use
  the same UTF-16LE PowerShell encoding as Electron so profile paths with spaces remain valid.
  Cursor uses its documented `version: 1` top-level `command` schema across all eight events and
  sweeps stale direct or nested managed definitions without disturbing user commands.
  Droid uses all eight Factory events with event-specific matchers and reports `hooksDisabled` as
  partial even when every managed definition is present.
  Command Code restores hook metadata stripped by its subprocess environment from ancestor
  processes or a matching endpoint file; endpoint ports are compared before fields are loaded so a
  stale file cannot replace current connection credentials.
  Grok writes only its dedicated trusted global `~/.grok/hooks/pebble-status.json` file, installs
  all eight events with the correct three matchers, and preserves user definitions in that file.
  Devin accepts its documented JSONC config, uses platform-specific config roots and Windows
  `cmd.exe` invocation, installs all eight matcher-less events, and surfaces default/explicit
  `read_config_from.claude` overlap rather than hiding duplicate hook risk.
  Kimi manages one convergent marker-delimited block in `config.toml`, preserves all user TOML
  outside that block, creates a rolling `.bak`, and always installs a POSIX script for Kimi's Git
  Bash shell on every platform.
  Amp writes the complete five-event TypeScript plugin with live endpoint-file refresh, bounded
  payload projection and a 50-item non-blocking POST queue; ownership markers prevent install or
  removal from touching a user-authored same-name plugin.
  Copilot owns the dedicated `hooks/pebble.json` lifecycle for all 13 documented events, preserves
  user definitions, cleans stale managed commands across unknown events, and writes the executable
  POSIX/PowerShell script before atomically replacing the hook file.
  Antigravity owns the `~/.gemini/config/hooks.json` `pebble-status` bundle, preserving the three
  direct-command events, nested `PostToolUse` matcher schema, passive permission output, and
  event-specific Windows wrappers without touching adjacent user bundles.
  Hermes parses and atomically rewrites `config.yaml` with a rolling backup, owns only marked
  plugin files, and installs the complete ten-event Python plugin with endpoint refresh and bounded
  payload projection before enabling it.
  Codex owns the platform-specific managed runtime home, six status hooks, exact canonical SHA-256
  trust identities, approved/disabled user-hook trust remapping after group-index shifts, system
  config stripping, and resource symlink or ownership-marked copy fallback.
  SSH managed-hook transport is now a versioned Go runtime action rather than Electron SFTP: it
  preserves saved target options, uses memory-only askpass credentials, bounds script/input/output
  and execution time, and exposes a purpose-scoped Tauri client. Agent-specific remote mutation
  payloads now run through `pebble-relay-worker agent-hooks-install`; all fourteen remote formats
  are complete, including Hermes YAML/plugin files, Devin JSONC, Kimi marker-delimited TOML, and
  Codex canonical trusted hashes. Before bootstrap, Go probes the remote OS/architecture, resolves
  or cross-builds a CGO-free matching worker, atomically deploys it to `~/.pebble/bin`, and injects
  the deployed path into the purpose-scoped install script.
  Successful Tauri SSH connection invokes installation best-effort so a malformed agent config
  cannot disable the workspace.
  Real-host Linux/macOS amd64/arm64 relay deployment remains a release validation gate.
- Tauri exposes renderer-compatible mobile fit/driver snapshots, listener subscriptions, and
  desktop reclaim actions for terminal/browser presence-lock surfaces. This prevents stuck empty
  APIs in the renderer contract. Live shared-control ingestion now lands in the Go runtime:
  mobile relay `terminal.input` frames write into sessions through a presence-locked
  `WriteSessionFromClient` (mobile input takes the floor; desktop-sourced input/resize is
  refused with 423 while mobile drives; `POST /v1/sessions/{id}/reclaim-desktop` releases it),
  `session.driver` events stream to the Tauri driver mirror so the renderer lock banner mounts,
  and the desktop fit-restore action reclaims runtime-side. Browser/emulator shared-control
  ingestion and mobile-side driver notification remain parity gates.
- Tauri exposes the canonical speech model catalog with functional lifecycle listener registration,
  and the native speech backend itself has landed: cloud transcription via OpenAI
  (`speech_openai_transcription.rs`, key stored through `speech_openai_key_store.rs`) and local
  on-device transcription via a sherpa-onnx engine (`speech_local_engine.rs`,
  `speech_local_dictation.rs`, model fetch/verify in `speech_model_download.rs`). Settings and
  dictation surfaces read/write against these native adapters instead of the Electron renderer
  contract.
- Tauri detects installed local CLI agents by reusing the shared `TUI_AGENT_CONFIG` command catalog
  and a native Rust PATH/install-dir probe, so agent settings and launch surfaces are no longer fed
  mock empty detection results. Tauri CLI registration uses native Rust for the host command and
  routes WSL CLI status, install, and removal through the native Rust bridge with bounded subprocess
  timeouts, managed-file conflict checks, and atomic replacement instead of inheriting the web
  browser-managed fallback copy.
- Tauri maps local runtime preflight RPC calls for agent detection/refresh back onto the same
  native probe path, preserving renderer call sites that go through `callRuntimeRpc`.
- Tauri maps passive remote preflight probes through `runtimeEnvironments.call` when the supplied
  connection id resolves to a paired runtime environment, then sanitizes agent lists and Windows
  terminal capabilities before they reach renderer state. Electron-style SSH mux detection remains
  a separate parity gate.
- Tauri streams runtime `project.changed` and `worktree.changed` events into the existing
  renderer repo/worktree refresh callbacks, so runtime-backed project/workspace mutations no
  longer rely only on manual list refreshes.
- Tauri maps worktree create-base prefetch to a best-effort Go runtime git fetch for local git
  projects, preserving Electron's warm-up behavior without touching SSH workspaces from the
  desktop host.
- Tauri maps `repo.hooksCheck`, setup-script import inspection, issue-command shared/local
  resolution, and issue-command runner script creation through Go file reads, shared
  `pebble.yaml` parsers, and a Rust `git rev-parse --git-path` writer. The runner preserves
  Electron's `PEBBLE_*` plus historical compatibility env vars and writes under the real gitdir
  for linked worktrees, so trusted hook prompts and linked-issue launches are no longer fed fake
  no-hook state in the Tauri shell.
- Tauri remote runtime environments now use the stored pairing material only inside Rust commands:
  one-shot `runtimeEnvironments.call` and subscription calls open the WebSocket, perform the same
  E2EE hello/auth flow as the Electron shared client, and return or stream the remote RPC envelope
  plus binary frames instead of falling back to local runtime results. Shared-control ingestion
  remains a separate parity gate. Relay-only SSH agent detection now works: `pebble-relay-worker
  agent-detect` probes the remote PATH against the desktop-passed TUI agent catalog (so the Go
  side never drifts from `src/shared/tui-agent-config.ts`), posts detections to
  `/v1/remote-hosts/agent-detections`, and Tauri `detectRemoteAgents` falls back to that cached
  per-host detection when no paired runtime environment answers.
- Tauri file watching now uses native `notify` for local worktrees and resolves `connectionId`
  worktree watches to runtime `files.watch` subscriptions, fanning both paths back into the same
  Electron-compatible `FsChangedPayload` consumed by Explorer, Source Control, and editor reloads.
- Tauri exposes updater version/status events and menu-triggered check errors so updater surfaces no
  longer silently no-op, initializes the native updater/process plugins, and now maps the existing
  UpdateCard lifecycle onto signed updater package download, native install, and process relaunch.
  The Nebutra/Pebble GitHub release feed remains a readiness fallback for release visibility, and
  Tauri fetches Nebutra `whats-new/changelog.json` through Rust/reqwest before emitting available
  statuses so the Electron release-popup content model stays shared. Missing updater signing config
  or platform endpoints must surface as explicit errors with manual release links instead of fake
  downloaded states.
- Tauri replaces the web crash-report mock with native commands for renderer error-boundary
  reports, breadcrumbs, pending/latest lookup, dismiss/sent transitions, copyable crash text, and
  Nebutra crash feedback submission with native NDJSON diagnostic bundle attachment. The same
  diagnostics command path backs Settings privacy previews, preview-open enforcement, upload, and
  delete requests.
- `verify-tauri-mainline.mjs` checks the renderer entry, preload bridge, Vite aliasing, CSS source,
  Tauri identity, window bounds, native window/menu/settings/shell bridges, runtime PTY fallback,
  mobile driver-state mirrors, remote runtime environment store commands, git base-ref lookup, preflight agent detection,
  deep-link routing, updater release-feed checks and native plugin wiring, crash-report persistence,
  browser runtime bridge, local mock-UI drift, and Roadmap commitment before shell changes are
  accepted.
  The verifier also locks local filesystem watch bridging so the Tauri shell keeps a native
  `notify` watcher with Electron-compatible payloads instead of falling back to web no-ops.

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
