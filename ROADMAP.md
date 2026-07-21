# Pebble Roadmap

## Tauri migration follow-ups

- Interactive SSH project sessions now force a remote PTY without changing non-interactive probes
  and relay commands. Windows ConPTY applies askpass argument and environment transformations to the
  real command, and the Go runtime waits on the desktop's native Windows process handle so a forced
  desktop exit cannot leave an old runtime bound to port 17777. Release evidence still needs
  password-only/encrypted-key SSH on Windows plus remote resize and signal checks.
- Native browser downloads correlate same-URL concurrent completions by their unique reserved
  destination instead of URL FIFO order. Native platform handles claim the first unbound download
  ID rather than the newest matching URL; macOS retains the exact ID-to-`WKDownload` association and
  releases it on completion. macOS now preflights both WKDownload delegate selectors and fails
  child-WebView setup explicitly when cancellation hooks cannot be installed. Windows and Linux
  release runners must still prove two concurrent same-URL downloads receive distinct destinations,
  canceling either ID leaves the other running, and completion events preserve both associations;
  macOS-host compilation is not evidence for those platform hooks. macOS direct
  mouse move/down/up/click now crosses a validated AppKit responder command boundary instead of
  constructing DOM mouse events. macOS selector click, double-click, and hover now resolve only
  bounded target geometry in the page before crossing the same native input boundary. macOS
  selector fill and type now use page code only to focus the bounded target, then replace or append
  text through WKWebView's focused AppKit responder instead of mutating DOM values. Key press/down/up
  now use bounded AppKit key events, wheel input preserves pixel-level two-axis deltas through a
  local CoreGraphics-to-AppKit event. Checkbox/radio checks use native clicks with final-state verification, while
  single-value selects resolve only the option index before navigating with native Home/Arrow/Enter
  keys. Native multi-select now resolves only option geometry, uses platform-native additive
  clicks (`Meta` on macOS and `Control` on Windows/Linux), and verifies the resulting selected
  options without mutating DOM state. Browser selectors and snapshot refs now recurse through open
  ShadowRoots and same-origin frames, preserve nested frame offsets for native input, and reject
  cross-origin, closed, detached, or ambiguous routes explicitly instead of falling back to the top
  document. A focused macOS real-runtime gate now mounts the production child-WKWebView factory,
  registers its canonical UUID with the runtime action queue, revokes the functional bundle's own
  Accessibility grant before launch, and requires trusted mouse, key, text, wheel, drag, check,
  select, and same-origin frame/open-ShadowRoot events while the Computer Use helper is also
  `not-granted`. Trusted mouse, key, text, wheel, check, select, and same-origin frame/open-ShadowRoot
  delivery pass this gate. Native drag safely reaches trusted `dragstart` and always exits its AppKit
  tracking loop, but public WKWebView/AppKit APIs cannot deliver trusted HTML5 `dragenter`/`drop`
  without global input permission: DOM `DragEvent` is untrusted, `NSWindow.sendEvent` cannot coordinate
  WebKit's asynchronous drag-source reply with AppKit's modal session, and `CGEventPost` is permission
  gated. Pebble now routes this one action through the existing signed `Pebble Computer Use.app` helper,
  converts child-WKWebView viewport points into validated window coordinates on AppKit's thread, and runs
  helper socket/AX work on Rust's blocking pool. Permission denial is explicit; there is no mock DOM drag
  or potentially blocking responder fallback. A green trusted-drop run under the helper identity with its
  disclosed Accessibility grant remains a release gate alongside background automation ownership and
  platform download-hook evidence.
  Windows now maps the same validated mouse, text, key, wheel, and ordered drag actions onto
  WebView2 `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, and `Input.insertText` CDP calls;
  installed Windows runner evidence remains required before release completion.
  Linux maps those actions to ordered GDK motion, button, smooth-scroll, and key events delivered
  through the WebKitGTK widget input path; installed Linux runner evidence remains required.
- Linux computer-use now synthesizes modifier hotkeys through AT-SPI and uses the GTK desktop
  clipboard, removing xdotool and external clipboard-tool dependencies. Debian packages still
  declare Python/AT-SPI dependencies. Release publication is Debian-only on both Linux architectures;
  AppImage stays blocked until it carries a frozen self-contained Python/GI provider runtime and passes
  clean-VM execution. Declaring deb dependencies is not accepted as AppImage evidence. Artifact
  inspection now rejects every Linux executable or sidecar requiring symbols newer than GLIBC_2.35.
- Linux is intentionally omitted from `latest.json` until a self-contained updater payload exists.
  Debian installs are directed to their package manager or the exact `.deb` release download and never
  invoke the AppImage installer. A native deb updater is optional future scope, not parity.
- Local Windows WSL runtime preference now drives the authoritative Go session launcher. Windows cwd
  containment runs before the selected distro resolves it through `wslpath`; Go owns `wsl.exe
--distribution/--cd/--exec`, and late-bound hook/account environment names cross through `WSLENV`
  without exposing values in argv. Release completion still requires shell, hook networking, PTY,
  resize, signal, and agent behavior in a real WSL install.

- Ghostty and Warp terminal theme previews no longer inherit the Web preload's synthetic
  `found: false` result. Rust performs cross-platform discovery, native file/folder selection,
  bounded recursive scanning and size checks; the shared source-faithful TypeScript parsers produce
  the same settings diff and custom-theme records for Electron and Tauri. Warp YAML parsing runs in
  a disposable Web Worker with a hard timeout so malformed imports cannot stall the renderer.
- Tauri `settings.onChanged` is now a real renderer event channel. Successful settings writes,
  including View > Appearance menu actions, update the canonical React store and shortcut-policy
  cache immediately instead of inheriting the Web baseline's no-op subscription. Native document
  priming is mutation-generation guarded, so a delayed startup read cannot overwrite a renderer
  change; a failed in-flight write restores its payload only when no newer value is already queued.
- macOS release bundles now stage the complete native local-speech dependency closure after Rust
  compilation and place `libonnxruntime` plus `libsherpa-onnx-c-api` in `Contents/Frameworks`.
  Release inspection requires both libraries, verifies their target architecture and nested Developer
  ID signatures, and fails before publication when either is missing. This closes the launch-time dyld
  crash that previously allowed `tauri build` to succeed while the resulting `Pebble.app` immediately
  exited. Every reusable release job also checks out the caller-supplied ref so artifact, updater
  manifest, and evidence verification cannot accidentally inspect different revisions.
- Settings navigation now separates code prefetch from component mount: pointer/focus intent warms
  the target chunk, quiet-time staggered preloading warms every lazy pane without mounting it,
  selection alone mounts it, and visited panes retain state without disconnecting/reconnecting the
  Settings effect tree. Opening Settings cancels pending pane imports; preloading resumes only after
  the hidden route has committed and painted. The retained route is memoized so visibility changes
  update only compositor-layer attributes, and Tauri resolves the default parallel-universe directory
  through native `homeDir`/`join` instead of exposing a literal `~`.
  Native font discovery runs on the blocking pool instead of Tauri's event loop, and repository hook
  probes are de-duplicated per runtime/repository across tab changes. The Settings entry is 84.0 KB
  raw with a 160 KB postbuild gate. Stats daily projection is linear for authoritative sorted histories
  with a compatibility path for unordered inputs, and Voice no longer duplicates activation scans.
  The optimized-shell gate now captures five fresh, process-group-cleaned Tauri instances against an
  Electron viewport manifest, uses an isolated parity identifier, and keeps capture windows hidden.
  Pane preloads now run through one cancellable serial queue after a 1.5-second startup settle window,
  so non-cancellable module evaluation cannot overlap in a burst with the first visit. A fresh five-run
  post-fix optimized-shell evidence measured 6-50 ms (50 ms p95) across five independent processes
  with zero long tasks. Failed comparisons now unwind through process cleanup instead of calling
  `process.exit`, so a stale preview server cannot contaminate the next run. Deterministic
  host-state pixel fixtures remain the release evidence still open for this surface.
- The Tauri window adapter now distinguishes macOS red-light close from application Quit. Both pass
  through renderer terminal/unsaved guards; ordinary macOS close hides the main window and Dock
  reopen restores it, while explicit Quit exits. Close requests carry immutable IDs through renderer
  guards, so stale confirmations cannot consume a newer Quit and native close events cannot downgrade
  an in-flight Quit. Rust intercepts both `RunEvent::ExitRequested` and AppKit's optional
  `applicationShouldTerminate:` delegate method, preserving native quit intent until the renderer
  listener is installed and permitting exactly one exit after guard confirmation. A bounded 500 ms
  atomic pending check backs up native push delivery without touching disk or React state. Real signed
  bundle evidence records `nativeQuitRequested=true`, `exitRequested=true`, and `clean=true` after an
  AppleScript/system Quit, so Dock Quit and native application termination cannot bypass the guards.
  Startup reveals only after the renderer page loads,
  restore state uses versioned logical-DIP bounds with HiDPI migration, and macOS traffic-light placement
  follows renderer zoom. The native release runtime now measures spawn-to-committed-first-frame and
  real minimize/unminimize/show/focus latency on macOS with explicit budgets. Window-state debounce
  and synchronous exit writes are serialized so an older delayed write cannot replace the final
  monitor geometry. The current macOS host has one display, so its evidence records multi-display
  restore as unavailable rather than passed; a runner with two displays must relaunch and prove the
  persisted target before release. Remaining window gates are Windows/Linux decoration and lifecycle
  evidence plus that real dual-display macOS relaunch measurement.
- The local Go runtime is bearer-authenticated by default. A cryptographically random token is held
  in the canonical main WebView session, passed to the child process through its environment, and
  supplied by status/resource/event/action/PTY/provider bridges. Browser child WebViews are excluded
  from the parent command capability by explicit webview labels. Release remains blocked on security
  regressions that restore an unauthenticated localhost command surface or broaden child capabilities.
- Renderer breadcrumbs are serialized through the Tauri command boundary. Renderer crash capture,
  submission, and formatting wait for every preceding breadcrumb write; failed best-effort writes do
  not poison the queue or allow later crash records to overtake earlier activity evidence.
- Native emulator providers now start with Tauri services, reconcile authoritative Go device records,
  expose renderer-compatible availability, and implement renderer lifecycle RPCs for list, kill, and
  active-session unregister. Active sessions boot iOS through `simctl` and Android through
  `emulator -avd`; Android startup waits for both the adb transport and `sys.boot_completed=1` within
  a bounded 180-second deadline. Streaming and controls remain routed through Go/Rust, shutdown is
  native, managed sessions detach only after completion, and permissions use the persisted `nativeId`.
  A real `Pixel_API_37_1` boot, readiness check, and cleanup passed locally. Remaining gates are iOS
  live preview/gesture/input/accessibility on a host with an installed simulator, Windows-host
  evidence, provider reconnect tests, physical-device E2E, SSH, and remote-host evidence.
- Release publication now has one owner: `release-cut` calls the reusable Tauri matrix and cannot
  publish until it completes. Root `start`, `dev`, `build`, `build:release`, and platform build scripts
  now resolve to `apps/desktop`; Electron launch/package commands are explicitly named
  `parity:electron:*`. The former Electron Windows/Linux release matrix and manually dispatchable
  macOS publisher have been deleted, and `publish-release` depends only on the Tauri build plus the
  renderer golden parity gate. The draft asset gate treats signed `latest.json` and every platform URL
  it references as authoritative instead of requiring Electron updater manifests and artifact names.
  Nebutra must still deploy and monitor the documented docs/download/changelog/diagnostics/feedback
  routes; client URL migration is not evidence that those external routes exist.
- The repository now exposes Pebble ownership at the root: shipping clients live under `apps/`, the
  Go control plane under `runtime/go`, native Rust/Zig layers under `native/`, cross-language
  contracts under `packages/contracts`, and subsystem maps under `docs/architecture`. The obsolete
  nested `pebble/` implementation container is removed and a layout verifier prevents it from
  returning. The temporary `migration/mobile-relay-client` prototype has been deleted: its isolated
  `/v1/mobile-relay` X25519/HKDF/AES-GCM draft was superseded by the shipping `apps/mobile` client and
  Go runtime's shared Curve25519/XSalsa20-Poly1305 WebSocket RPC contract. The canonical mobile path
  keeps pairing secrets in SecureStore, reconnects and replays subscriptions, carries binary terminal
  and browser frames, and has an in-process encrypted recovery test. The repository layout gate now
  requires both protocol endpoints and rejects restoration of the temporary migration directory.
  Electron remains an explicitly named parity reference until every remaining release gate has a
  Tauri replacement; isolate and delete its source only as those gates close.
- Electron installer production has fully exited the repository. The obsolete builder configuration,
  per-platform Electron packaging commands, and `electron-builder` workspace dependency are deleted;
  the private reference shell retains only dev/build/native-rebuild commands needed to capture the
  remaining reviewed UI and terminal baselines. Tauri is the sole owner of installers, signing,
  notarization, updater manifests, artifact names, and publication.
- The Electron reference no longer carries obsolete Electron Builder contract tests or the retired
  Windows Electron AppHang reproduction harness. Final reference-directory deletion is blocked by
  two evidence migrations only: drive application E2E through Tauri and move computer-use CI
  assertions onto Rust/Go/Tauri ownership. Pixel and settings-performance release verification now
  launches only Tauri and compares its native WebView capture against reviewed immutable baselines;
  refreshing those baselines is an explicit, non-release Electron reference command.
- Public installer names are now a release contract rather than a tauri-action implementation detail:
  macOS publishes one universal DMG, Linux publishes x86_64/aarch64 deb assets, and Windows publishes
  explicit NSIS and MSI assets. The publish gate requires every direct-download installer in addition
  to signed macOS/Windows updater payloads; Homebrew migrates to the universal DMG on the first Tauri
  release, and user-facing download/diagnostic paths use the same names. AppImage publication remains
  blocked by the self-contained Python/GI and clean-VM gates above.
- Runtime Antigravity hooks no longer read or sweep legacy product bundles, their compatibility test
  is removed, historical benchmark fixture paths are normalized, and the Tauri mainline gate scans all
  tracked text sources for reintroduced legacy product identifiers. Git metadata and Roadmap migration
  history are non-shipping audit records, not runtime compatibility.
- Runtime PTY child-process/foreground-process inspection and signals now use real Go session state;
  Windows ConPTY now maps `SIGINT`, `SIGQUIT`, and `SIGHUP` to their native terminal control bytes,
  while `SIGTERM` and `SIGKILL` terminate the complete process tree through `taskkill /t` (force is
  reserved for kill). Unsupported POSIX-only signals remain explicit instead of reporting a false
  success. The Windows cross-compile contract is green; installed-runner evidence must still prove
  control delivery against a real interactive child and descendant cleanup.
  Go also owns the bounded terminal transcript: completed lines carry an absolute cursor across
  chunk eviction, partial lines never advance pagination, UTF-8 split across PTY reads is retained,
  and bare carriage-return redraws replace the current line rather than creating spinner history.
  Tauri and encrypted remote `terminal.read` now consume the same transcript page, report stale
  cursors as truncated, expose truthful oldest/next/latest cursors, and reset the cursor epoch when
  the buffer is cleared instead of reconstructing lines from an arbitrary chunk tail.
  renderer reload replaces stale SSE tasks and channel bindings. Automation startup atomically catches
  up pending dispatches, persists authoritative bounded output snapshots, and never synthesizes success
  output. Browser profile deletion removes validated native storage before metadata. Still-open parity is
  Windows SSH workspace-shell release evidence, per-origin browser media permission engine evidence,
  and the explicit iOS/Windows/device gates listed above.

- `agentTrust.markTrusted` now routes paired SSH workspaces through the encrypted runtime RPC.
  Go atomically updates Cursor, Copilot, and Codex trust artifacts in the remote user's HOME plus
  the remote managed Codex HOME; local workspaces retain the native Rust path. Background sessions,
  direct launches, forks, and workspace creation all preserve the owning `connectionId`, and remote
  failures never fall back to writing local configuration.
- Native Notebook execution now routes paired SSH workspaces through encrypted runtime RPC and runs
  Python on the owning workspace host. The bridge strips desktop-only connection metadata, never
  falls back to local execution, and preserves bounded output, timeout, process-tree cleanup, and
  disconnect cancellation while unrelated terminal/file RPCs continue on the same connection.
- Native `localhostWorktreeLabels` now carries SSH host ownership for remote advertised workspace
  URLs. Go re-scans the selected host's live loopback listeners, creates a reused non-persistent SSH
  tunnel, and routes the stable `.pebble.localhost` label through it while preserving the advertised
  Host header, path, query, WebSocket/HMR proxying, per-connection route isolation, and SSRF checks.
  Transient label tunnels stay out of the user's Ports configuration and terminate on disconnect.
- Connected-SSH `workspaceCleanup` scans now execute on every owning remote runtime and merge with
  the local scan in the canonical React cleanup UI. Remote candidates retain their `connectionId`,
  Git safety evidence and PTY liveness are evaluated on the workspace host, final remote progress is
  published as a snapshot, and disconnect/errors remain explicit instead of falling back locally.
- Remote workspace changes now stream from a long-lived SSH `workspace-watch-json` relay into Go
  runtime SSE and Tauri `workspace.changed` subscribers. Watchers are reference-counted and canceled
  with the last React listener; revision polling runs only while SSE or a target watcher is down and
  stops after push recovery. Revisioned get/patch, CAS conflict handling, target-scoped projection,
  connected-client presence, and external-client changes retain the same canonical snapshot model.
- Claude, Codex, and OpenCode usage history are native in Go/Tauri with opt-in persistence,
  incremental scans, nested-worktree attribution, date/scope queries, model/project breakdowns,
  costs, and recent sessions. Codex preserves cumulative-token and legacy copied-session semantics;
  OpenCode reads session totals plus legacy `session_message`/`message` SQLite generations and tracks
  WAL changes. AI Vault discovery records path-level issues and continues through readable siblings
  when one agent-history directory is protected or corrupt; absent optional agent roots remain silent.
  All 74 preload namespaces now have real Tauri implementations with no tracked
  Electron fallback namespace remaining.
- Complete agent-browser 0.27 debug/inspection parity without spawning its Chromium daemon. Native
  video recording now feeds JPEG screencast frames into the platform MediaRecorder, streams encoded
  chunks to a Rust atomic writer or the Go runtime's worktree/SSH atomic commit path, and supports
  `record start|stop|restart` for WebM/MP4 when the platform codec is available. Browser screencast uses a raw Tauri Channel, Rust capture/ACK
  backpressure, a bounded Go relay, encrypted binary WebSocket delivery, and navigation rebinding.
  Browser child WebViews now install a document-start dirty observer: DOM mutations, input, scrolling,
  resizing, media timeline events, and active Web Animations wake Rust capture immediately while static
  pages perform no 4 FPS screenshot/encode loop. Dirty notifications are rAF-coalesced, native capture
  remains bounded by the requested minimum frame interval, and a two-second safety sample covers canvas
  and platform painting that DOM observers cannot see. Duplicate encoded frames are still suppressed, so
  the Channel, HTTP, encryption, WebSocket, and decode protocol is unchanged. Platform-native dirty-region
  capture remains a performance target. The official MIT React DevTools hook is now injected at document
  start and wrapped without replacing its commit behavior. React tree and inspect share official
  operations IDs and rendererInterfaces in production, with a paired Fiber fallback for unsupported
  renderers. React tree/inspect/render recording/Suspense commands read the
  existing child WebView's real Fiber roots through a document-start hook. Runtime actions and browser state now use the
  native Channel/SSE push pipeline with disconnect-aware polling only as a compatibility fallback.
  Completed recordings replace same-path output atomically: Rust uses durable directory sync plus
  Windows `ReplaceFileW`, while Go local and SSH relay commits use platform replace primitives;
  ordinary file copy remains no-clobber.
  Runtime
  `addinitscript`/`removeinitscript` now retain bounded scripts per browser page, execute them in the
  current document, and reapply only scripts that remain registered after navigation. Repeatable
  `open --init-script <path>` reads through the selected local/SSH runtime and registers every script
  before the first navigation. Trace/profiler
  recording spans child-WebView replacements and exports bounded Performance Timeline segments as
  Chrome Trace Event JSON, including start-time output path retention. Framework-neutral Web Vitals collect LCP, CLS, TTFB, FCP, INP,
  and hydration evidence from the existing child WebView. Core navigation/DOM/network/storage/
  cookie/dialog/download/diff commands plus native `batch` and `session` dispatch are migrated.
- Ephemeral VM orchestration is native in the Go runtime and Tauri preload: recipe catalog/doctor,
  cancellable provision with redacted push logs, atomic runtime persistence, Pebble Server/SSH
  connection registration, failed-attachment cleanup, suspend/resume, destroy, and cross-platform
  manual cleanup commands. Electron remains only the parity reference.
- Jira is native in Tauri: OS-keyring multi-site credentials, bounded/concurrency-limited REST,
  ADF-to-Markdown mapping, resilient multi-site reads, and full issue/comment mutations. The preload
  coverage verifier rejects any reintroduced fallback namespace instead of allowing silent Proxy
  methods.
- Pixel-parity evidence now has a shell-independent PNG gate: Electron and Tauri captures must use
  identical renderer viewport dimensions, channel-level differences are counted against an explicit
  mismatch budget, flat fills retain a strict one-pixel/16-channel comparison, and only detected
  high-contrast glyph/control edges receive a bidirectional two-pixel CoreText raster tolerance.
  Failures produce an uncommitted heatmap. The capture shell has isolated app data and cross-platform process-tree teardown so
  persisted user settings and stale single-instance locks cannot contaminate samples. This complements
  behavioral E2E coverage and prevents
  namespace parity from being mistaken for renderer fidelity. Debug Tauri runs can set an absolute
  `PEBBLE_PARITY_CAPTURE_PATH` to capture the primary WebView after React settles; the hook is absent
  from release builds, rejects non-PNG/non-absolute paths, runs once, and atomically writes pure
  renderer pixels without native shadows or foreground-window dependence. The capture contract now
  proves canonical empty-project Landing, available-update, blank crash-report composer, and
  Settings surfaces through the unchanged React components;
  machine-specific preflight/application persistence is explicitly marked volatile. Capture builds
  never probe or spawn the Go runtime, so short-lived evidence shells cannot collide with the live
  product runtime or write false `runtime-process-exited` crash reports. On macOS the current 3456px
  evidence passes the 1.5% budget at 0.239% for Landing, 0.927% for Update, 0.937% for Crash Report,
  and 1.118% for Settings; five Settings switches measure 7ms p95 with zero over-50ms frame stalls.
  Workspace, terminal, browser, source-control, and checks screenshots remain real-runtime capture
  gates; static Zustand-only fixtures are not accepted as evidence for those runtime-owned surfaces.
  The functional gate now drives real PTY, native child-WebView, Git projection, GitHub/GitLab checks,
  and native-chat fixtures and can capture the macOS window-server browser surface. The hidden
  functional shell still does not composite primary WKWebView content reliably for terminal,
  source-control, or checks screenshots; those captures are diagnostic only until a dedicated
  visible isolated test window produces nonblank, stage-distinct pixels and matching Electron
  fixture references.

## Tauri desktop mainline migration

### Tauri Bootstrap Capability And Terminal Latency Delta

The canonical `main` and optimized preview windows now declare the Tauri core,
notification, process, updater, and deep-link capabilities used during renderer
bootstrap. Development builds also install a bounded native page-load probe so a
real renderer failure can be distinguished from macOS window-only screenshots
that omit the WKWebView GPU surface.

Terminal input no longer waits in both the renderer and Rust. Printable input is
microtask-coalesced, then handed immediately to Rust's ordered per-session queue;
the Rust worker merges queued bytes before the Go runtime round trip. The focused
batching tests and the Tauri mainline verifier guard this ownership boundary.

The production-built Tauri renderer has also been checked in the native macOS
window at a 1708x981-point desktop viewport. The canonical three-column landing
layout, live agent-session history, and Pebble product identity render without a
mock shell; the empty-project action and shortcut legend consistently use the
Chinese product term "平行宇宙" without legacy English workspace labels. Evidence
screenshots remain local test artifacts and are not committed to the repository.

Native protocol routing now handles both runtime pairing and canonical Settings
targets. A second Tauri process forwards links such as `pebble://settings/voice`
through the single-instance bridge, and the existing window opens the real React
Settings surface at the allowlisted pane and optional bounded section target.
Unknown panes remain explicit errors instead of mutating arbitrary renderer state.
This flow has been exercised against the production-built renderer in a live
macOS Tauri window; protocol screenshots remain uncommitted test evidence.

`browser.exec` now owns the pinned agent-browser `diff snapshot`, `diff url`,
and `diff screenshot` workflows without spawning Electron or a second browser
daemon. Snapshot baselines are isolated per native tab or read through a bounded
Rust workspace path; URL comparison navigates and snapshots the existing child
WebView; visual comparison decodes captures with the renderer's native
`ImageBitmap`/canvas path, applies a bounded pixel threshold, releases GPU image
resources, and can persist a PNG diff through the native capture writer. A real
Chromium module run verified a 12-pixel baseline mismatch, 100% mismatch result,
and valid PNG diff output in addition to the focused TypeScript and Rust tests.

Paired runtime/shared-control browser automation now exposes the same native
action subset as the local Tauri adapter instead of silently shrinking to basic
navigation. Held keys, HAR capture, storage, mouse, clipboard, SPA navigation,
bounded page evaluation, viewport sizing, request headers, offline mode, and
HTTP credentials are validated by Go, queued as target-scoped browser actions,
and executed by the existing child WebView. Dotted storage RPC names map to the
canonical renderer commands, and the previously allowlisted-but-rejected
`keyDown`/`keyUp` path is closed. Encrypted WebSocket integration coverage proves
remote storage mutation completion; renderer tests cover key/HAR/eval execution,
and Go race tests cover the expanded queue and shared-control dispatcher.

Remote browser state management now keeps native cookie and dialog semantics as
well. Shared-control cookie get/set/delete/clear commands retain empty values and
HttpOnly, Secure, SameSite, expiry, URL, domain, and path fields through the Go
action queue, then execute against the Rust WebView cookie store rather than
falling back to `document.cookie`. Dialog accept/dismiss actions resolve the
pending native JavaScript dialog, including an intentionally empty prompt value.
Encrypted WebSocket integration tests verify cookie mutation payload and result
round trips; renderer tests verify the exact native command invocations.

Browser and emulator provider completion is push-first, with grouped polling only while the runtime
event stream is disconnected. The bounded terminal-action cache now carries a monotonic generation
cursor: each new command captures the cursor before POST and rejects an older terminal result that
reuses the same action id, while still accepting completion events that arrive between POST and
listener setup. This prevents stale screenshots or command results after runtime/provider restarts.

Tauri browser navigation readiness now comes from each native child WebView's
main-document `PageLoadEvent`, not a fixed 750 ms renderer timer. The Rust host
emits tab-, label-, URL-, and event-scoped lifecycle records; the renderer
subscribes before child creation, rejects stale replacement generations, and
only projects Electron-compatible `dom-ready`/`did-stop-loading` after the
matching native `finished` event. A bounded timeout becomes an explicit
`did-fail-load` instead of a false successful load.

The Rust/Tauri host now installs a process panic hook before entering the native
event loop. Host-thread and async-task panics persist a sanitized `tauri-host`
crash record through the same append-only journal used by renderer, WebKit, and
Go-sidecar failures, including bounded thread and source-location diagnostics.
Secret-like panic text is redacted, recursive hook entry is guarded, and the
previous Rust hook still runs so stderr/backtrace behavior is preserved. This
closes the native-shell gap where a Rust panic previously disappeared from the
next-launch pending crash prompt.

Native startup diagnostics now mark risky setup operations before entering them,
not only after completion, and panic reports include the active session id,
startup stage, and stage timestamp. The macOS termination-selector hook degrades
to a persisted startup report when installation fails instead of returning an
error through AppKit's launch callback, where Rust cannot unwind safely. A Zig
ABI mismatch still fails closed, but exits through Tauri after recording the
exact component and stage rather than producing an opaque `panic_cannot_unwind`.
An immediate same-thread `panic_cannot_unwind` cascade is suppressed for five
seconds after a concrete primary panic, so the generic abort wrapper cannot
replace the actionable root cause as the newest crash prompt.
System `.ips` import is disabled for parity and functional evidence shells because
DiagnosticReports are user-global rather than app-data scoped. The pixel/performance
gate also clears only its dedicated parity crash/session files before a run, so an
old production incident cannot cover a deterministic Landing fixture with a crash
dialog or create a false 80% pixel regression.

Native crash recovery now also covers failures that cannot execute the Rust
panic hook. On macOS, the next healthy launch imports unseen Pebble `.ips`
DiagnosticReports, records bounded DYLD/exception metadata through the same
sanitizer, and deduplicates by incident ID. On every desktop platform a
`tauri-session.json` marker records PID, app version, and the last completed
startup stage; a dead, unclean prior session becomes a
`previous-native-abnormal-exit` report on restart. Explicit Quit and Unix
termination signals persist exit intent before teardown, while `RunEvent::Exit`
marks the completed session clean, so a platform event-loop teardown cannot be
misreported as a crash. Pixel-capture shells are excluded from this lifecycle.
The marker now carries a versioned process identity (PID plus process start
time), executable/launch identity, stage timestamp, and exit-intent timestamp.
Recovery reports include the marker-only decision evidence, so PID reuse cannot
hide a real abnormal exit and an inferred report no longer implies that a native
stack was captured. Debug builds and explicitly marked launch diagnostics do not
participate in cross-restart recovery; release panic capture and macOS `.ips`
import remain independent evidence chains.
Repeated startup calls that observe the same failed Go sidecar are coalesced by
executable, listener, and exit code into one short incident window. A child that
exits during the five-second startup grace is treated as an app-replacement handoff
rather than a crash; only a settled runtime's nonzero exit reaches the pending crash
surface.
Longer-term release hardening still includes a rotating native NDJSON sink and
Crashpad/Sentry Native-class stack capture for platforms without system crash
reports.

Tauri runtime startup now distinguishes a spawned Go child from a ready HTTP
listener. Every native JSON request joins one shared readiness promise, probes
until `127.0.0.1:17777` is accepting requests, and retries a short-lived sidecar
at a bounded 100ms cadence until the eight-second deadline. This covers the old
runtime releasing its port just after an upgraded desktop starts, while persistent
failure still returns the last concrete process error instead of leaking a transient
`Connection refused` into the React UI. The legacy runtime bridge is a re-export of this
single coordinator rather than a second probe/spawn implementation.

Pebble's desktop target is Tauri as the primary app shell, backed by the Go
runtime and Rust host boundary. Electron is a parity reference only while
migration is in progress; new desktop-shell work should move toward Tauri
commands, Rust host adapters, and Go runtime contracts instead of deepening
Electron main-process ownership. `native/zig-system/` is statically linked into
the Tauri Rust host, ABI-checked at startup, and owns the Unix signal primitive
used to stop the Tauri-managed Go runtime.

Project host setup runtime calls now expose the complete native lifecycle through Tauri: canonical
project/setup listing, independent setup creation, existing-folder adoption, updates, and deletion.
Remote callers therefore reach the same Go-backed project API as the local renderer instead of
falling through to `method_not_available` after capability negotiation succeeds.
`project.update` uses that same boundary for validated host, inherited, and WSL runtime preferences,
so a remote Settings mutation persists in Go rather than stopping at renderer state.

Workspace port scan and kill RPCs now delegate to the same Go-backed Tauri API used by the local
ports panel. Shared-control callers retain repository scoping and the runtime's process/port
revalidation instead of falling through to an unmapped method or terminating an unverified PID.

### GitHub Work Item Native Chain

Tauri now routes `github.listIssues`, `github.listWorkItems`, `github.issue`,
`github.workItem`, and `github.workItemByOwnerRepo` through the Go runtime. The
provider filters REST issue rows that are pull-request shadows, merges issue and
pull-request timelines by `updatedAt`, preserves a classified issue-side error
while still returning pull requests, supports bounded search cursors, and keeps
explicit owner/repository lookups available for cross-repository links. Direct
preload calls and runtime RPC dispatch share the same bridge and HTTP routes.

Go project persistence now owns the canonical `issueSourcePreference`, including
explicit `auto` clearing. Native source resolution parses origin/upstream Git
remotes, preserves both candidates in list envelopes, falls back to origin when
upstream is absent, and applies the selected source consistently to issue/PR
lists, count, labels, assignable users, single-item reads, and issue creation.

Core `github.workItemDetails` now runs through Go as well: issue details include
body, comments, assignees, participants, and supported timeline activity; pull
request details include body, conversation comments, checks, files, head/base
SHAs, GraphQL node ID, and participants. The route preserves the canonical
renderer envelope through both direct preload and runtime RPC dispatch.

Issue edits now stay on the stable bound repository and run through Go for
close/reopen reasons, duplicate targets, body patches, title, labels, and
assignees. PR comments use GraphQL thread data plus REST review-summary
fallbacks, preserving resolution, outdated-line, reaction, and bot metadata.
PR file contents read base/head blobs through bounded native provider routes,
including rename paths, binary detection, and added/removed-side skips.

GitHub Projects discovery is now native as well: Go lists bounded viewer and
organization ProjectV2 catalogs with partial-failure reporting, resolves pasted
organization/user URLs and `owner/number` shorthand, preserves `/views/{n}`
selection, and paginates ProjectV2 view summaries for the existing picker UI.
Project drawers now read labels, assignable users, issue types, and work-item
details from explicit repository slugs. Issue/PR edits, issue comment
add/edit/delete, typed ProjectV2 field updates/clears, and issue-type changes
also run through bounded Go provider mutations instead of Electron IPC.

ProjectV2 table views now paginate view definitions and up to 500 ordered
items through Go, preserve typed field values, classify schema drift and
oversized views, and retry without `Issue.parent` when the authenticated
GitHub schema cannot expose sub-issues. Branch-to-PR lookup is also native:
linked PR numbers remain authoritative, branch lookup precedes fallback
metadata, merged fallback visibility honors the current HEAD contract, and
the Tauri bridge returns canonical `PRInfo` state/check/merge fields.

GitHub detail participants are now hydrated in one bounded aliased GraphQL
query, preserving visible login/avatar data if enrichment fails. Tauri also
owns local PR refresh scheduling instead of inheriting the web no-op: requests
coalesce by repository/branch, preserve cache aliases, prioritize active and
manual work, delay post-push probes, bound concurrency, reject stale visible
generations, apply freshness skips and error backoff, and feed canonical refresh
events into the existing renderer store. Branch-to-PR lookup expands
upstream/origin candidates, retries a different tracked remote branch, verifies
merged-PR commit containment, and derives local conflict summaries from bounded
read-only git operations.

Mainline rules:

- `apps/desktop/` is the desktop-shell migration track and must load the
  same React workbench renderer, not a reduced or mock UI.
- Pixel parity is the bar: Tauri may be more reliable, faster, and more native, but
  it must not ship placeholder screens, simplified flows, or UI forks that only
  resemble Electron from a distance.
- Electron is a parity reference only; it is not the destination desktop shell.
- The Tauri shell must keep pixel-level parity with the Electron reference
  while Electron remains available for comparison.
- Existing renderer features should be backed by runtime contracts before the
  corresponding Electron IPC path is retired.
- Tauri release builds generate target-qualified `pebble-runtime` and
  `pebble-relay-worker` Go sidecars (including a lipo-combined macOS universal
  pair), declare them as `externalBin`, and resolve the bundled runtime before
  PATH or source-tree development fallbacks.
- `node config/scripts/verify-tauri-mainline.mjs` must pass when changing the
  Tauri shell, renderer entry, or migration contract.

Migration gates:

The real-runtime migration gate now injects isolated cross-platform `gh` and `glab`
fixtures and proves GitHub PR plus GitLab MR lookup and passing, failing, and pending
Checks through Go normalization, Tauri preload APIs, renderer state, and the unchanged
`ChecksPanel`. Tauri overrides review lookup/checks/details/rerun/comments instead of
falling back to the paired-Web preload. GitHub and GitLab post-creation edits, state and
draft transitions, reviewer changes, merge/auto-merge, comments, discussion resolution,
and viewed-file state now route through the Go provider boundary. Bitbucket, Azure DevOps,
and Gitea creation use their bounded REST adapters; capability detection reuses those adapters'
remote parsers and credential rules so the renderer does not block supported providers before
creation. Live authenticated provider evidence
remains open. Relay-only SSH provider requests now
proxy the original `/v1/providers/*` method, query, body, status, and JSON through the
deployed worker, where the same runtime HTTP handlers execute against the selected remote
project or parallel-universe path instead of returning `ErrRemoteNeedsRelay`.
The namespace audit now measures Tauri assignments rather than counting the Web
baseline as native coverage. It now proves all 74 preload namespaces with no
tracked Web-pairing fallback remaining. Linear uses native Keychain-backed
credentials plus bounded GraphQL transport; telemetry consent and delivery are
native and honor DNT/CI/explicit-disable precedence; E2E controls exist only in
test/gate builds and are removed from production.
Native chat now resolves Claude and Codex transcripts inside approved agent roots,
reads only complete JSONL records, and live-tails atomic replacement/truncation through
Rust `notify`; Electron and Tauri share one TypeScript record decoder so transcript
schema drift cannot produce shell-specific chat history.
Unix `SIGTERM` and `SIGINT` now cross an async-signal-safe atomic bridge into
Tauri's normal exit path, so managed runtime cleanup and `clean-exit` session
markers run before termination instead of generating false native crash reports.
The isolated functional gate also exits through Tauri's normal main-thread path,
does not participate in native session recovery, and is excluded from macOS crash
imports so test process teardown cannot surface as a user crash report.

| Area                                                      | Target owner                                      | Current status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Exit criterion                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window shell, sizing, and app identity                    | Tauri/Rust                                        | Tauri config uses Pebble identity and Electron fallback window dimensions; Tauri now installs native window, settings-event, and menu bridges for close guards, titlebar popup menus, paste, help/settings events, sidebar toggles, Appearance checkbox state, and zoom.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Tauri window controls, titlebar behavior, traffic-light placement, menus, updater menu checks, and shortcut parity match Electron screenshots on macOS, Windows, and Linux.                                                                                                                                                                                                                                       |
| Renderer parity                                           | React in Tauri                                    | Tauri renderer imports the canonical `@/App` and root renderer stylesheet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Desktop Tauri screenshots match Electron reference views for landing, workspace, terminal, browser, source control, checks, settings, update dialogs, and crash surfaces.                                                                                                                                                                                                                                         |
| File/project pickers and shell actions                    | Tauri commands + Rust host                        | Native folder picker commands exist for local project add flows; Tauri now bridges validated open-in-file-manager, open-in-editor/default app, URL/file URI open, path existence, attachment/image/audio/directory pickers, repo-icon PNG import, no-overwrite file copy, local Git base-ref/default-branch lookup, `pebble.yaml` hook checks, setup-script import inspection, issue-command shared/local resolution, and linked-worktree-safe issue-command runner script creation through the existing renderer contracts. Tauri local runtime RPC also maps mobile/CLI `files.list/open/openDiff`, file explorer `read`, `readDir`, preview read, chunk read/write, base64 upload writes, server-directory browsing, write, create file/dir, rename, copy, delete, stat, quick-open listing, text search, and markdown document listing to Go file endpoints and renderer file-open events with workspace path safety, while paired remote runtime environments proxy the same file explorer read/preview/chunk/write/CRUD/search/document RPCs for SSH worktrees instead of touching remote paths from the desktop host. Tauri overrides the web no-op file-watch API with a native Rust `notify` watcher for local worktrees and bridges SSH/remote worktree watches through `runtimeEnvironments.subscribe(files.watch)` into the same `fs:changed` renderer payload. Tauri also resolves terminal-tapped worktree paths and grants local temp-file terminal artifacts through native Rust commands with recent-terminal-output provenance, TTL grants, no-follow reads, stale-file checks, preview, and writeback; paired remote runtime environments proxy the same terminal artifact RPCs and keep remote grant IDs scoped to the originating connection/worktree/path. Relay-only SSH terminal artifacts preserve image, icon, and PDF previews plus text writeback through expiring grants.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Project add/remove, folder workspaces, file attachment flows, repo icon import, markdown image copy, SSH project setup, base-ref pickers, local/remote file-watch refresh, local/paired-remote terminal artifact open/preview/write, local/paired-remote file explorer CRUD/search/preview, and trusted hook prompts run without Electron IPC.                                                                    |
| Runtime RPC, remote environments, and PTY/session control | Go runtime (creack/pty) + Rust/Tauri              | Tauri can start/probe the local Go runtime, call bounded runtime resources, expose native provider list/status/register RPCs through the real Go `/v1/providers` and subsystem status routes, detect installed local CLI agents through the shared `TUI_AGENT_CONFIG` catalog, install/status/remove the managed `pebble-ide` launcher inside a selected WSL distribution through bounded native Rust commands, map the local runtime preflight RPC methods and host capability probes onto real Tauri/Go runtime checks, map SSH target CRUD/import plus connect/disconnect state onto Go `/v1/ssh-targets` probe results so the settings UI gets real `connecting/connected/auth-failed/error/disconnected` transitions instead of a dead unsupported button, and read persisted SSH `lastRequiredPassphrase` state for auto-connect prompt gating instead of returning a fixed false, stream runtime `project.changed`/`worktree.changed` events back into the existing renderer repo/worktree refresh callbacks, emit renderer-correlated create progress events for Tauri worktree creation, map worktree lineage list/set/create paths onto Go runtime state including `workspaceLineage` records for folder/worktree parent keys, persist project groups, folder workspace objects, project order, and basic worktree metadata/sidebar sort order through Go runtime routes, run bounded local nested repo scan/import through Go `/v1/project-groups/scan-nested` and `/v1/project-groups/import-nested` with `.gitignore` filtering, sparse folder subgroups, existing-project reuse, local worktree target normalization, final progress events, cancel-to-`stopped` scan results, and scan/import timeouts aligned to the renderer's bounded UX, bridge paired remote `connectionId` nested repo scan/import through the same `projectGroup.scanNested`/`projectGroup.importNested` runtime environment RPCs instead of touching remote paths from the desktop host, run bounded local `git worktree remove` before deleting Tauri-created worktree records, map local `worktree.activate` onto the existing renderer activation event, map local and SSH-project workspace-backed terminal spawn/write/output/resize/stop/clear-buffer plus renderer-side geometry tracking onto Go process sessions, with SSH sessions hosted as system-OpenSSH child PTYs and target-scoped termination, map local runtime terminal create/list/resolveActive/show/read/send/wait/inspect/clear/stop/stopExact/focus/close/split/resolvePane/agent-status calls onto the same Go sessions, expose local `session.tabs.list/listAll/createTerminal/activate/close/move/updatePaneLayout/setTabProps/subscribe/unsubscribe` snapshots and mutations from Go session records plus a Tauri-side tab state mirror instead of returning empty mock tabs, bridge runtime-backed agent sessions into the existing renderer `agentStatus` protocol with durable tab/leaf metadata for snapshots and failed-session mapping to blocked Activity rows, expose renderer-compatible mobile fit/driver snapshots, subscriptions, and desktop reclaim actions through a Tauri-side state mirror, and generate existing Web/CLI `pebble://pair` offers plus device/runtime-access lists and revocation from Go's TweetNaCl-compatible `/v1/shared-control/*` identity registry instead of empty web mocks or the incompatible mobile-relay envelope protocol. Go shared-control now serves authoritative `session.tabs` streams, desktop JSON terminal streams, and the exact encrypted 16-byte mobile terminal wire path for snapshot/input/output/resize/unsubscribe, with real PTY and race-detector coverage. The Go runtime owns Unix PTY spawn/winsize/resize via `creack/pty`, Windows pseudo consoles via `go-pty`/ConPTY, and tracks alternate-screen transitions, exposes bounded Unix foreground/child-process inspection, and uses bounded Windows CIM lineage inspection. Tauri now also starts/stops a native runtime event push bridge that re-emits Go SSE events into the renderer and keeps polling armed until a connected status arrives, so startup/downstream race conditions degrade to polling instead of dead silence. Tauri now also persists pairing-backed remote runtime environments in `pebble-environments.json`, validates `pebble://pair?...` payloads, redacts secrets in renderer responses, supports list/resolve/remove/disconnect plus one-shot and subscription WebSocket E2EE remote runtime calls through native commands instead of mock local environments, routes passive remote preflight probes through a runtime-environment selector when the connection id is a paired runtime environment, and exposes the canonical speech model catalog, native OpenAI cloud transcription, platform keychain-backed API-key storage, model downloads, and lifecycle listeners. Renderer dictation controls and shortcuts use the native compile-time capability probe: feature-gated sherpa-onnx local models reach the Rust engine, while builds without that feature return a typed unavailable state before recording starts. Go HTTP context-level nested scan cancellation/streaming, legacy SSH relay nested import paths, Electron-style SSH relay agent detection, Tauri SSH relay credential cache, a live Windows WSL CLI install/remove smoke gate and the remaining shared-control RPC allowlist are still explicit parity gates, not fake empty success. | Agent launch, native PTY winsize propagation, durable split-pane layout/session-tab movement/subscriptions, live mobile terminal/browser presence-lock input from runtime RPC, remote runtime subscriptions/shared-control, full linked issue/PR metadata persistence, preserved-branch cleanup after worktree removal, workspace base-conflict events, and SSH relay paths are driven through runtime contracts. |
| Source control and reviews                                | Go runtime + provider adapters                    | Go owns source-control projections and diffs for local/relay-fed workspaces, and Tauri local runtime RPC now maps `github.repoSlug`, offline `github.repoUpstream` from `origin`/`upstream` remotes, `git.status`, `git.checkIgnored`, `git.submoduleStatus`, `git.diff`, `git.history`, `git.localBranches`, `git.checkout`, `git.branchCompare`, `git.commitCompare`, `git.branchDiff`, `git.commitDiff`, stage/unstage/discard, commit, fetch/pull/push/fast-forward/rebase, abort merge/rebase, fork sync, remote file/commit URLs, `git.upstreamStatus`, and conflict-operation fallback to source-control projection/content-diff/history/compare/mutation endpoints so Source Control shows real changed files, branch/ahead/behind state, local branch picker/switching, basic file diffs, history, branch/commit compare summaries, working-tree mutations, hosted links, repository identity, and primary sync actions instead of `method_not_available`. Go now persists the created base SHA for local runtime-created worktrees, exposes a base-status reconcile endpoint, and Tauri fans out local `checking/current/drift/base_changed/unknown` plus publish-remote branch-conflict events through the existing renderer subscriptions. Tauri also maps GitHub PR checks, GitLab MR listing, existing hosted-review branch lookup, hosted-review capabilities, and review creation for GitHub, GitLab, Bitbucket, Azure DevOps, and Gitea through local Go provider routes, including worktree selector resolution. GitHub/GitLab review edits, state/draft transitions, reviewer changes, merge/auto-merge, comments, discussion resolution, and viewed-file state use provider-neutral Go mutation routes. Projection-level status preserves staged/unstaged/untracked area plus rename `oldPath` for local git status and relay-fed projection updates. GitHub API fork-parent fallback when no upstream remote exists, rich conflict/binary/submodule diff metadata, remote/SSH base-status parity, and live authenticated provider evidence remain explicit gates instead of fake successful responses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | GitHub, GitLab, and provider-neutral review surfaces work in Tauri with no Electron-only IPC assumptions.                                                                                                                                                                                                                                                                                                         |
| Browser/webview/automation                                | Rust/Tauri browser adapter + Go state             | Go persists browser tabs/profiles/permissions/downloads and queues `browser.*` actions. Tauri bridges native child WebViews, navigation, screenshots/PDF, dialogs, downloads, cookies, profiles, viewport/device emulation, DOM automation, request interception, authentication, and browser events into the canonical renderer/runtime contracts. Native Firefox, Safari, Chromium-family, and validated JSON cookie import is enabled through the live profile WebView store on supported platforms. Automations persist and schedule through Go instead of web fallback state. Remaining browser gaps are pre-macOS-14 profile isolation and full CDP-backed inspection/high-rate screencast parity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Browser tabs, screenshots, downloads, permissions, design mode, action polling/completion, and automation run through native adapters with mobile/CLI parity.                                                                                                                                                                                                                                                     |
| Deep links and protocol routing                           | Tauri/Rust + renderer runtime environment store   | Tauri registers the `pebble` scheme, filters startup/opened URLs to Pebble protocol links, routes `pebble://pair?...` into the same runtime environment add/status refresh path used by the settings UI, queues cold-start activations until the renderer is ready, and uses native single-instance forwarding so Windows/Linux second launches restore and focus the existing Pebble window instead of losing the URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | macOS, Windows, and Linux app activation deep links open or focus Pebble, add validated runtime environments without exposing secrets, and reject unsupported routes without silent success.                                                                                                                                                                                                                      |
| Computer use and emulator                                 | Rust adapters + Go queues + linked Zig system ABI | Native/browser/emulator action queues are exposed through Tauri commands, and macOS computer-use permission status/setup/reset now goes through the same `Pebble Computer Use.app` helper as Electron via native Tauri commands, with Linux/Windows still returning explicit unsupported permission states instead of fake success.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Accessibility trees, screenshots, safe actions, and iOS/Android device control work through provider queues; low-level platform accessibility primitives are the candidate future Zig scope.                                                                                                                                                                                                                      |
| Updates, release, diagnostics                             | Tauri updater/release service + Go release plans  | Go release plans and Nebutra routes are tracked; Tauri checks `https://github.com/nebutra/pebble/releases.atom`, verifies platform updater manifests before surfacing an available version, fetches Nebutra `whats-new/changelog.json` through Rust/reqwest, and routes the result into the existing UpdateCard status flow instead of a separate popup. Tauri also initializes the native updater/process plugins, maps UpdateCard download progress to signed updater download/install, and relaunches through the native process plugin while preserving the renderer restart-bypass event contract. Renderer error-boundary crash reports, breadcrumbs, dismiss/sent state, copyable details, diagnostic bundle previews/uploads, and crash submissions with NDJSON attachments now flow through native commands instead of web mock APIs. Signed Tauri updater endpoints/public keys and release artifacts remain release-engineering gates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Tauri signing, notarization, updater manifests, Nebutra diagnostics endpoints, release notes, and verified updater download/install are release-blocking checks.                                                                                                                                                                                                                                                  |

### Tauri Window State Parity

Rust now restores and persists the main window independently of Electron. Both
development and packaged configs stop forcing maximized state; the Rust setup
validates saved normal bounds against attached monitor work areas before the
first event-loop paint, restores maximized state separately, and atomically saves
debounced move/resize changes. Minimum-sized teardown geometry and windows with
less than `300×200` visible work-area overlap are discarded using the same
rules as the Electron parity reference.

The canonical renderer can keep its Electron-compatible `-webkit-app-region`
styling while Tauri bridges titlebar pointer input to the native window API.
WKWebView selector fallbacks preserve draggable titlebar/sidebar space, exclude
interactive controls and terminal input, and map titlebar double-click to native
maximize/restore. Explicit capabilities gate both operations instead of relying
on resize-border behavior or WebView-specific CSS interpretation.

### Tauri Feedback Submission Delta

The sidebar feedback dialog no longer inherits the web preload fallback under
Tauri. Its unchanged React flow now invokes a Rust host command that posts to
the Nebutra feedback route with a ten-second timeout and trusted app version,
platform, kernel release, and architecture metadata. Anonymous submissions drop
all renderer-supplied GitHub identity at the native boundary, and all text fields
are bounded before network I/O. The Nebutra project still must implement the
documented `POST /pebble/v1/feedback` production route before public release.

### Tauri Markdown PDF Export Delta

The canonical Markdown editor's PDF action no longer inherits the web fallback.
Rust now loads the renderer-produced, image-inlined HTML into a bounded one-shot
hidden Tauri WebView, waits for every image to settle, and reuses the existing
WKWebView/WebView2/WebKitGTK native PDF backends. The unchanged React flow then
opens a native save dialog with a cross-platform-safe filename. Export windows,
temporary HTML, and platform PDF scratch files are closed or removed on every
terminal path; the implementation does not spawn Electron or a second Chromium
runtime.

### Tauri GitHub Check Details And Rerun Delta

The canonical Checks panel no longer reaches unmapped Tauri runtime methods when
opening check details or rerunning GitHub Actions. Go provider rows now retain
workflow/check identifiers, expose check-run output and annotations, map workflow
jobs and steps, and attach at most three bounded failed-job log tails. Native
provider routes resolve the selected project or parallel universe, preserve
cross-repository owner/repo details, and rerun each unique Actions workflow once
while rerequesting non-Actions check runs by native check ID through non-interactive
`gh api` calls. The Tauri dispatcher maps both
`github.prCheckDetails` and `github.rerunPRChecks` to these Go routes instead of
falling through to `method_not_available`.

### Tauri GitLab Pipeline Job Actions Delta

GitLab pipeline job log expansion and Retry no longer fall through to unmapped
Tauri methods. Go resolves the selected local project or parallel universe,
preserves self-hosted hostname plus arbitrarily nested project paths, and invokes
non-interactive `glab api` trace/retry endpoints. Trace payloads are bounded to
16 MiB with an explicit truncation marker, while retry responses map the
replacement job's pipeline, stage, status, URL, and duration into the unchanged
React dialog contract. Missing project refs fall back to `glab repo view`
instead of assuming GitLab.com.

### Tauri GitLab Issue And Work-Item Read Delta

The canonical GitLab issue picker and combined MR/issue views no longer fall
through to Electron-only IPC. Go resolves the selected local project or parallel
universe to an exact self-hosted host plus nested project path, reads project
issues through non-interactive `glab api`, and preserves labels, author/avatar,
description, timestamps, assignment scope, state, search, and paging filters.
Combined work-item reads fan out MR and issue requests concurrently, sort the
merged rows by update time, retain exact project identity for later mutations,
and preserve Electron's partial-success error envelope when only one side fails.
Both direct `window.api.gl` calls and `gitlab.listIssues` /
`gitlab.listWorkItems` runtime RPC calls share these native routes.

GitLab issue creation, state/title/body/label/assignee updates, comments, and
label discovery now use the same native project boundary. Mutations preserve an
explicit work-item `projectRef` when supplied, so identical issue IIDs on origin
and upstream cannot edit the wrong project. Tauri accepts canonical `repoPath`
selectors by resolving them against registered runtime projects, keeps request
bodies bounded at the HTTP edge, and maps both direct preload methods and
runtime RPC methods to the Go implementation.

The remaining GitLab read methods are native as well. User-scoped pending todos
retain target/project/author metadata; pasted GitLab URLs resolve by explicit
self-hosted host, nested project path, IID, and item type; and the full detail
drawer aggregates description, non-system discussions, inline thread context,
pipeline jobs, reviewers, approvals, assignees, and bounded MR diffs. Supplemental
MR reads fail independently to empty optional sections, while a missing base item
returns `null`, matching the canonical Electron contract without fake detail data.
All 21 canonical `gitlab.*` runtime methods now have Tauri dispatcher mappings.

Local renderer reads no longer inherit the Web compatibility baseline either.
Tauri resolves `projectSlug`, fetches an MR by IID or source branch with durable
linked-IID fallback, fetches a single issue, and paginates inherited project
members for assignee/reviewer pickers. These routes preserve self-hosted host and
nested namespace identity and map pipeline, draft, mergeability, author, SHA, and
target-branch fields into the unchanged Electron renderer contracts.

### Tauri Provider Rate-Limit Delta

The GitHub and GitLab budget indicators no longer inherit the web fallback in
the Tauri shell. Go now probes `gh api rate_limit` and the authenticated
`glab api -i user` endpoint, preserves GitHub core/search/GraphQL buckets, and
parses standard or `X-` GitLab rate-limit headers including numeric and HTTP-date
reset values. Both providers retain Electron's 30-second cache semantics;
self-hosted GitLab entries are hostname-scoped and bounded to 64 records. Tauri
maps both runtime RPC methods and the direct `window.api.gh/gl.rateLimit` calls
to the same native routes, while the HTTP boundary rejects URL/path-shaped host
values before they can reach `glab`.

Provider identity and auth diagnostics now use the same native boundary as the
budget probes. GitHub/GitLab viewer calls return the authenticated CLI identity
instead of fixed `null`, so feedback and crash-report identity remain available
under Tauri. GitHub auth diagnostics preserve account source, active account,
scopes, missing ProjectV2 scopes, environment-token shadowing, and same-host
keyring fallback detection; GitLab diagnostics preserve CLI availability,
authentication state, known hosts, active host, environment-token source, and
the original diagnostic error. Both direct preload calls and runtime RPC calls
share these Go routes. The native parser also corrects Electron's false-positive
case where `has not been authenticated` contained the positive word
`authenticated` and incorrectly marked a GitLab host as logged in.

The Landing and Settings GitHub Star controls now reuse the same bounded Rust
commands as the StarNag prompt. Their historical `window.api.gh` entry points no
longer inherit web fallback values, so status checks and starring behave
consistently across all three canonical React surfaces.

### Tauri Native Menu Localization

Tauri application-menu labels now use the canonical renderer `menu.*` catalogs
instead of a parallel English-only template. Appearance checkboxes, updater,
settings, reload/zoom, developer tools, fullscreen, crash-report, setup, and
feature-tour actions rebuild when the renderer language changes; predefined OS
roles remain owned by the native menu framework.

### Tauri Project Runtime Preference Persistence

Project-level Windows runtime selection no longer appears to save while only
mutating renderer memory. Go project records now validate and persist
`inherit-global`, `windows-host`, or a WSL distro preference. Tauri PATCHes
every runtime source repo represented by the logical project and re-reads the
authoritative projection, so Settings survives refresh and desktop restart.

### Tauri Git Username Resolution

Tauri no longer inherits the web client's empty `repos.getGitUsername` result.
Go resolves local repository username configuration and only consults `gh` for
an effective GitHub remote. SSH projects run the explicit username probe in the
remote repository through `pebble-relay-worker`, preserving host ownership and
the Electron rule that author name/email are not branch-prefix usernames.

### Tauri Project Host Setup Persistence

Tauri now uses Go-owned `project-host-setups` records for host bindings that do
not yet have a repository checkout, while repo-backed local and SSH bindings
remain projections of Go project records. Create, list, update, and delete flow
through real HTTP routes; logical projects are reconstructed from both record
types, so removing the last source repo does not erase an independently
provisioning runtime host. Existing-folder setup stores the logical project id
on the new Go project record and re-reads the joined projection instead of
returning an optimistic renderer-only object.

### Tauri Legacy SSH Terminal Artifact Relay

Legacy SSH targets without a paired runtime environment now resolve terminal
artifact paths through the Go runtime and deployed `pebble-relay-worker`.
Recent PTY output provenance gates grant creation, and expiring host-scoped
grants support bounded text read, image preview, and atomic text writeback with
path, identity, symlink, hard-link, and stale-file checks. Paired runtimes keep
using their native remote RPC path; the desktop host never reads the SSH path.

### Tauri SSH Credential Prompt Delta

Encrypted-key and password SSH targets now use the canonical React credential
dialog under Tauri. A failed native probe emits `onCredentialRequest`, waits
for submit or cancellation, stores a successful answer only in the Go runtime
memory cache, and retries the bounded system-SSH probe. The runtime executable
itself is the cross-platform `SSH_ASKPASS` helper, so secrets never enter argv,
generated scripts, logs, or persisted state; cached credentials enable exactly
one prompt attempt while uncached probes remain BatchMode fail-closed. A
successful prompted connection updates `lastRequiredPassphrase`, matching the
Electron parity reference's deferred reconnect behavior.

### Tauri Star Prompt State Machine

Tauri no longer inherits the web shell's no-op `starNag` API. The canonical
React card/toast surfaces receive native show/hide events from a Tauri bridge
that persists completion, cooldown, doubling thresholds, per-version baselines,
and one agent-value-moment consumption through the native UI document. Agent
working events evaluate the Go-owned lifetime stats summary rather than a
renderer counter. Rust performs bounded, non-interactive GitHub CLI checks and
direct starring for `nebutra/pebble`; unavailable authentication selects the
existing web handoff UX without reporting a false success.

### Tauri Agent Session History

Tauri no longer inherits the web client's fixed-empty AI Vault result. The Go
runtime discovers and parses local Claude, Codex, Copilot, Cursor, Pi, Gemini, Hermes, Rovo,
Grok, OpenClaw, Devin, Droid, and Kimi history into the
canonical session, preview, token, timestamp, cwd, and resume-command shape;
the Tauri preload routes the existing right-sidebar history UI to that native
endpoint and refreshes it on window focus. Discovery is recency bounded,
filters Claude worker/workflow journals from the top-level history, and reports
per-file parse issues instead of collapsing the entire panel to zero sessions.
Cursor discovery is restricted to `agent-transcripts`, and each newly migrated
agent preserves its source-specific resume invocation. The bounded result reserves a dynamic
per-source slice before filling by global recency, so a large Claude/Codex history cannot hide
every session from another installed agent. OpenCode legacy JSON and 1.17+ SQLite storage are both
read through bounded, read-only Go adapters with parent/archive filtering and session-id deduplication.
SSH host scopes now invoke the auto-deployed relay worker so the same Go scanner runs on the
remote machine instead of reading remote paths from the desktop. The runtime rewrites sessions to
their canonical `ssh:<target>` execution host, aggregates All hosts by recency, and returns
target-scoped failures as visible scan issues. The Tauri preload forwards both execution-host scope
and active workspace/project paths to this endpoint. Go parses an additional bounded candidate
window for those paths and unions matching cwd sessions after the global cap, preserving Electron's
guarantee that an older active-project session remains visible. Paired runtime environments expose
the same host-local scan through the encrypted `aiVault.listSessions` RPC. Explicit `runtime:<id>`
scopes route to that environment, while All hosts fans out from the Tauri desktop across local/SSH
and paired runtimes, rewrites each remote result to its canonical runtime host id, globally dedupes,
sorts, and limits the combined history. A disconnected paired runtime contributes a host-scoped scan
issue without hiding sessions returned by healthy hosts.

### Tauri Nested Scan Cancellation Delta

### Tauri Kimi Usage Delta

Tauri now reads Kimi Code's CLI-owned OAuth credential from the same
`KIMI_CODE_HOME` or `~/.kimi-code/credentials/kimi-code.json` path as the CLI
and calls the read-only coding-plan `/usages` endpoint from Rust. The bridge
merges Kimi with Claude and Codex during initial refresh, manual refresh, and
polling while preserving provider-level failure isolation. Pebble never
refreshes or rewrites the Kimi token because refresh-token rotation remains
owned by the Kimi CLI. OpenCode Go, MiniMax, and Gemini are covered by the
subsequent native migration deltas below.

### Tauri OpenCode Go Usage Delta

OpenCode Go usage no longer depends on Electron `net.fetch`. The canonical
renderer reads the configured session cookie and optional workspace override,
then invokes a native Rust command that forwards only `auth` or `__Host-auth`,
resolves workspace candidates through the SST server-function endpoint, and
parses bounded React Flight usage pages into 5-hour, weekly, and monthly
windows. Candidate workspaces retain fallback behavior, malformed workspace
IDs are rejected before network access, and cookies are never included in
returned errors. MiniMax and Gemini are covered by the subsequent native
migration deltas below.

### Tauri MiniMax Usage Delta

The MiniMax settings flow now stores its session Cookie in the OS credential
store through native Tauri commands instead of returning the web client's
unsupported error. Rust reads that credential internally, accepts both Cookie
header and browser object-export forms, requires `_token`, derives the optional
group from `minimax_group_id_v2`, sends the same platform-specific Firefox user
agent and headers as Electron, and maps the configured model to the fixed
5-hour usage window. Save, status, clear, initial refresh, polling, and manual
refresh all run without Electron IPC.

### Tauri Gemini Usage Delta

Gemini quota refresh now runs through native Rust when the user explicitly
enables Gemini CLI OAuth inspection. The adapter reads OpenCode-compatible
Google auth entries or `~/.gemini/oauth_creds.json`, resolves static and bundled
Gemini CLI OAuth client constants across npm, Homebrew, Nix, and Windows global
layouts, refreshes expired tokens, atomically writes refreshed CLI credentials,
loads the Code Assist project, retries quota reads after a 401, and maps
deduplicated model buckets plus the most constrained session summary. Disabled
OAuth remains a true unavailable state and does not inspect credential files.
Kimi, OpenCode Go, MiniMax, Claude, and Codex usage are likewise native, so this
provider usage group no longer depends on Electron IPC.

### Tauri Nested Scan Cancellation Delta

This supersedes the runtime table's older wording that listed HTTP context-level nested scan
cancellation as a remaining gate. Local scans now register their request context by `scanId` in the
Go HTTP server, `/v1/project-groups/scan-nested/cancel` cancels the active walk, replacement scans
cancel the prior same-ID request without stale cleanup removing the replacement, and Tauri's Cancel
action invokes that endpoint while preserving the immediate stopped-state UX.

### Tauri Terminal Title Persistence Delta

Tauri now handles `terminal.rename` through the native session-tab runtime mirror. Custom titles,
including explicit reset to `null`, are projected into canonical renderer snapshots and persisted in
the Go-backed session-tab layout document so they survive renderer reloads and runtime restarts.

### Tauri Clipboard Runtime Delta

Canonical `clipboard.saveImageAsTempFile` and bounded start/append/commit/abort upload RPCs now
persist validated local image bytes through a native Rust command. The Tauri bridge enforces the
same payload limit, chunk ordering, concurrency cap, expiry window, and failed-commit cleanup as the
Electron reference. SSH `connectionId` uploads now route through the Go runtime and its deployed
relay worker; the worker selects the remote host's native system temp directory and returns that
remote path, including Windows hosts, instead of incorrectly handing remote agents a desktop-local
path.

### Tauri Mobile Notification Delta

Tauri desktop notification dispatch now reuses the canonical Electron title/body formatter and
publishes non-test notification events into the Go runtime. The Go event bus forwards transient
`notification.dispatched` events to every paired, ready mobile relay client independently of its
snapshot projection diet, so task-complete and terminal-bell notifications no longer require the
Electron main process. Tauri notification dismissal now publishes deduplicated dismiss events to
the same mobile stream while truthfully reporting zero desktop cancellations because the native
plugin exposes no OS-toast handle API. Consolidating the legacy `notifications.subscribe` RPC
framing onto the Go mobile relay transport remains a protocol cleanup item, not a desktop-delivery
dependency.

### Tauri Lifetime Stats Delta

`stats.summary` now reads Go-runtime-owned lifetime aggregates rather than an empty Tauri fallback.
The runtime persists unique agent launches, completed agent duration, deduplicated hosted review
creation, and the first event timestamp in `runtime-state.json`; natural PTY exit, failure, explicit
stop, SSH agent sessions, and runtime restart all share the same accounting path. Electron's
`StatsCollector` remains a parity reference while the Tauri/Go path is the desktop mainline owner.

### Tauri Skill Discovery Delta

`skills.discover` now runs through a bounded Go-native scanner instead of Tauri's web fallback empty
result. It preserves the Electron source model for Codex, Claude, agent-skills, plugin cache, and
local repository roots; follows common skill-directory symlinks with realpath loop protection;
enforces markdown depth/size and package file-count limits; and returns stable path IDs plus
`SKILL.md` name, description, modification time, provider, and bundled/plugin classification.
Paired remote runtimes execute the same endpoint on the remote host, while local discovery excludes
SSH project paths from desktop filesystem traversal.

### Tauri Memory Diagnostics Delta

`diagnostics.memory` now combines Go session PID metadata with a Rust `sysinfo` process-table sweep.
The collector reports real host memory/load/core metrics, Tauri main-process CPU/RSS, and each live
PTY process subtree grouped by canonical worktree and repository names. A 60-sample Tauri-side ring
restores the app/worktree sparklines without Electron state. Platform WebView renderer processes do
not expose a stable cross-platform PID through Tauri, so the separate renderer bucket remains an
explicit zero instead of guessing; app totals still contain the identifiable native process tree.
The canonical desktop `api.memory.getSnapshot` now calls this same collector directly instead of
inheriting the web preload's all-zero snapshot, so the visible Resource Manager and runtime RPC
share one process attribution and history implementation.

### Tauri Workspace Port Delta

The canonical `workspacePorts` preload API now uses Go runtime endpoints instead of inheriting the
web fallback's `undefined` scan and kill results. The runtime performs bounded native listener
discovery on macOS/Linux (`lsof`) and Windows (`netstat`), batches process metadata lookup, assigns
ports by deepest cwd before command-line evidence, excludes SSH projects from local attribution,
and preserves workspace/container/external classification plus wildcard-host and protocol rules.
Process termination never trusts the renderer PID: Go re-scans immediately, requires the same
workspace-owned PID/port pair, rejects its own process, and then uses platform-native termination.

### Tauri Sparse Preset Delta

Sparse checkout presets are now project-scoped Go runtime records rather than Electron Store data
or Tauri web-fallback calls. List/save/remove validate the same name and repo-relative directory
rules as Electron, preserve creation timestamps on edits, atomically persist in runtime state,
cascade on project deletion, and emit `repo.sparse-presets.changed` for every desktop/runtime client.

### Tauri Workspace Space Delta

The status-bar workspace space manager now runs a real Go runtime analysis instead of the Tauri web
fallback. The cross-platform walker is cancellable, does not follow symlinks, bounds each worktree
to its 20 largest top-level entries, preserves skipped/omitted byte accounting, distinguishes main
and reclaimable worktrees, emits live progress, and marks SSH paths explicitly unavailable until a
relay-side scanner owns remote traversal.

### Tauri WSL Rate Limit Delta

Tauri now fetches Codex usage for a selected WSL target by starting the read-only, untrusted
`codex app-server` inside that distribution through `wsl.exe`. Distro names remain isolated argv
values, and the WSL path never borrows host Codex credentials. Reset-credit redemption is blocked
from crossing account boundaries: Tauri reads the selected distro's Codex `auth.json` and redeems
through Rust with the same target-scoped token and account id.
Claude usage likewise reads the selected distribution's CLI-owned `.credentials.json` through a
bounded native command, then keeps the OAuth token inside Rust while requesting the usage endpoint.
Neither provider reads Windows host credentials for a WSL target.

### Tauri Release Infrastructure Delta

Release packaging requires Nebutra GitHub Actions secrets `TAURI_UPDATER_PUBLIC_KEY`,
`TAURI_SIGNING_PRIVATE_KEY`, and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; the repository cannot create
or recover those production credentials. The release workflow replaces the development placeholder
public key, enables updater artifacts, and now validates the actual `tauri-action` updater JSON after
every platform build. Each platform entry must use a `github.com/nebutra/pebble/releases/download`
URL and contain a non-empty signature before the release job can succeed. Nebutra release operations
must keep those secrets configured and publish the combined `latest.json` at the configured GitHub
release endpoint.

The root package version is the desktop release version. The desktop package, Tauri config, and Rust
package manifest must match it; `verify:tauri-mainline` runs a Cargo-aware version-sync gate before
the structural migration checks so a stale `0.1.0` cannot reach app metadata, crash reports, or the
updater protocol.

The renderer updater bridge now owns explicit single-flight check and download operations. A download
waits for an already-running check, duplicate clicks share the same native updater resource, and a
manual check cannot replace active download progress. Native relaunch is latched after success so
duplicate install events cannot race process shutdown; a rejected relaunch clears only that latch and
preserves the downloaded update for retry. This matches the Electron reference's operation safety
without retaining Electron updater ownership.

Stable checks continue through the configured `/releases/latest/download/latest.json` endpoint, while
explicit RC/perf checks and prerelease installations resolve a canonical Pebble release tag first.
Rust then constrains the endpoint to that tag's GitHub Release `latest.json`, lets the official Tauri
updater create the signed native resource, and rejects manifest/tag version mismatches before download.
The release workflow uses the official `uploadUpdaterJson` input and, after every platform matrix job
finishes, downloads the actual draft-release `latest.json` through the GitHub API. Publication is
blocked unless the manifest version matches the tag and signed entries exist for macOS arm64/x64,
Linux arm64/x64, and Windows x64.

### Tauri Force Reload Delta

The View menu and renderer-policy keyboard shortcut now share the Rust-backed `webview_reload`
command. Force Reload clears native WebView browsing data before reloading on both paths; ordinary
Reload keeps cache state. A browser `window.location.reload()` remains only the failure fallback,
not the primary shortcut implementation.

### Tauri Legacy SSH File Parity Delta

Legacy SSH targets that do not run a paired Pebble runtime can now perform bounded live text-file,
directory-tree, full-list quick-open, binary chunk, stat, and image/text preview reads through the
auto-deployed Go relay worker. Text/base64 writes, chunk append, no-clobber file/directory creation,
rename, copy, upload commit, and recursive/non-recursive delete use a bounded stdin JSON mutation
protocol so large payloads do not enter SSH argv. The Tauri adapter only falls back for methods with
these live relay routes; failures from unsupported remote methods remain visible instead of being
mistaken for local filesystem operations. Remote text search reuses the exact Go matcher used by
local workspaces, including regex, whole-word, glob, binary filtering, and result limits. Remaining
legacy SSH file watches fall back from paired-runtime subscriptions to bounded Go relay metadata
snapshots, diffing create/update/delete events onto the existing `fs:changed` bus without overlapping
polls. Legacy SSH terminal artifacts now use Go runtime-owned, 10-minute grants bound to the SSH
target, worktree, canonical temp path, and file identity; relay reads/previews/writeback revalidate
temp-root scope, hard links, stale replacement, size/binary limits, and preserve permissions during
atomic replacement. This closes the ordinary legacy SSH file-adapter gap without trusting renderer
grant IDs.
SSH project hooks checks, setup-script import inspection, and issue-command read/write now use the
same Go relay file endpoints and canonical parsers as local projects; Tauri no longer returns an
empty import list or fixed error solely because a repo has `connectionId`.

Paired runtime file explorer calls now terminate on the runtime host through the encrypted
shared-control channel. The Go dispatcher resolves the authoritative worktree/project scope and
projects directory reads, bounded text reads, binary previews, chunks, stat, quick-open, search,
Markdown discovery, writes, upload commits, and CRUD into the same renderer contracts as the local
Tauri adapter. Mobile-scoped pairings cannot call these filesystem methods, and all paths retain the
Manager's worktree-bound traversal and symlink checks.

Paired runtime terminal artifacts now terminate on that runtime host as well. Resolution accepts
worktree files directly, but grants worktree-external files only when a live terminal belonging to
the same parallel universe recently emitted the exact path. Native Go grants are temporary-root
scoped, expire after ten minutes, reject hard links and stale file identities, bound text and binary
preview sizes, and preserve permissions during checked replacement. The desktop retains only the
opaque grant ID plus connection/worktree/path binding.

Paired runtime nested repository discovery and import now execute on the paired host through the
encrypted channel. The shared-control dispatcher invokes the same bounded Go scanner/importer as
local HTTP calls, so ignore rules, progress snapshots, grouping, existing-project reuse, and import
results remain identical while the desktop never attempts to walk a remote path.

Paired runtime hosted-review lookup, creation eligibility, and review creation now execute against
the runtime host's repository and provider credentials. Shared-control resolves project/worktree
selectors authoritatively, projects GitHub PR and GitLab MR metadata into the common renderer model,
derives the same dirty/upstream/sync/auth/push eligibility states, and invokes the existing
provider-neutral Go creation path instead of falling through to an unavailable desktop-local RPC.
The same paired provider dispatcher now serves GitHub PR check summaries/details/reruns and GitLab
MR list pagination, keeping the right-sidebar Checks surface and review picker on the runtime host's
CLI credentials and repository rather than the desktop host.

Paired host preflight now has distinct contracts for check, detect, and refresh. Go probes Git,
GitHub CLI and GitLab CLI installation/authentication on the runtime host, reflects existing
Bitbucket/Azure DevOps/Gitea environment configuration, and returns the full refresh metadata object
instead of incorrectly reusing the bare detected-agent array.

Paired runtime review mutations now stay on the runtime host for GitHub and GitLab: title/body/state
updates, reviewer changes, merge and auto-merge, ordinary and inline comments, comment replies,
thread/discussion resolution, and GitHub file-viewed state all route through the existing Go
provider-neutral manager with the renderer's original per-provider payload shapes.

Paired runtime work-item flows now also execute on the runtime host: GitHub/GitLab issue and unified
work-item lists, counts, labels, assignable users, todos, item/details lookup, PR comments, issue
create/update/comment operations, provider viewer/rate-limit/auth diagnostics, and REST-backed
Bitbucket/Azure DevOps/Gitea review lists all resolve through the authoritative paired project and
parallel-universe scope. Branch-to-PR lookup, GitHub PR base/head file contents, GitLab job traces,
and GitLab job retries now use that same host-side scope. The paired Provider runtime-control
surface therefore has no desktop-local fallback methods remaining.

Paired runtimes now expose the complete GitHub Projects v2 catalog and mutation surface from the
runtime host: project resolution/listing, views and table data, repository labels/assignees/issue
types, work-item details, issue/PR/comment updates, Project field set/clear, and issue-type changes.
No Projects v2 call falls back to desktop-local `gh` credentials.

### Tauri Source Control Parity Delta

This section supersedes the older source-control table wording that listed all native AI
text generation as unavailable. Tauri now overrides the web fallback git generation API for
local worktrees: Rust reads staged/base diff context and executes bounded, cancelable agent
plans, while the shared React prompt builders and parsers preserve commit-message and PR-field
output behavior. Remote worktrees obtain commit/PR context through the Go SSH relay worker, and
renderer plus runtime RPC callers share the same generation/model-discovery/cancellation implementation.
SSH repositories now use the auto-deployed Go relay worker for default/base-ref search and PR/MR
start-point resolution. Normal reviews fetch remote-tracking refs and preserve push targets;
cross-repository GitHub PRs and GitLab MRs fetch their provider review refs and return immutable
head SHAs, so review workspace creation no longer falls back to an Electron-only local Git path.
Tauri hosted-review creation and post-creation mutation now cover GitHub and GitLab through
`gh`/`glab`, plus Bitbucket, Azure DevOps, and Gitea through provider-specific REST adapters.
The Tauri eligibility bridge recognizes all five providers, resolves explicit linked review IDs,
and checks REST-backed branches through their native Go list routes, so an authenticated
Bitbucket/Azure DevOps/Gitea project no longer appears as `unsupported_provider` before creation.
Lookup and eligibility share the same capability response, avoiding a duplicate remote-provider
round trip on the first Create Review interaction.
Title/body edits, close/reopen, and supported reviewer mutations share the provider-neutral Go
route instead of falling back to Electron IPC. Template hydration now covers the complete provider
candidate set, Go emits Electron-shaped conflict operation/kind data, binary byte-size/image flags,
and structured submodule pointer SHAs, and relay projections feed remote/SSH base-status drift and
branch-conflict events through the same reconcile endpoint as local worktrees.
The status-overflow recovery flow is native too: Go detects known dependency/build
directories, filters existing ignore rules with mixed-result `git check-ignore`
semantics, and appends allowlisted patterns through registered project/worktree
IDs. Tauri no longer suppresses this UX with fixed `[]`/`false` Web fallbacks;
the writer rejects injected names and symlinked `.gitignore` files.

Tauri Codex host accounts now complete the managed OAuth lifecycle without Electron IPC. Rust owns
isolated app-data homes, canonical config seeding, identity reads, ownership-marker validation, and
trusted deletion. The Go PTY runtime runs the captive `codex login` process with an account-scoped
`CODEX_HOME`; the renderer serializes mutations, persists account summaries and selection, rolls
back failed additions, and supports list/add/reauthenticate/select/remove. New host Codex PTYs,
active host usage reads, and host reset-credit redemption all receive the selected managed home, so
account labels, credentials, and quota cannot diverge. WSL account creation now allocates and
marker-validates the isolated Linux-side home, runs captive login inside the selected distro, reads
identity through its UNC projection, and deletes only after distro-side ownership validation.
Runtime `accounts.list` returns the real stores rather than an empty placeholder. WSL workspace
PTYs now honor the persisted project runtime through the Go host: the renderer supplies only the
Linux inner command/account environment, while Go selects the distro and converts the contained cwd.
WSL usage and reset-credit calls read the same home. Windows release CI
remains responsible for compiling and exercising this Windows-only path.

Claude host accounts now use a temporary config only for captive browser OAuth, capture scoped
Keychain or credentials-file output into the OS credential store, persist only non-secret identity
metadata in settings, and materialize the selected credentials back into the shared Claude runtime
store so conversation history remains unified. Add, reauthenticate, select, remove, cancellation,
system-default snapshot/restore, auth-env stripping, failed-add rollback, and refreshed outgoing
credential read-back no longer require Electron. Claude WSL accounts now create and marker-validate an isolated auth directory
inside the selected distro, perform captive login and credential capture in that distro, retain a
per-distro selection, and inject the selected Linux `CLAUDE_CONFIG_DIR` into new WSL PTYs while
stripping explicit auth variables. Removal is accepted only after distro-side canonical ownership
validation. Accounts-pane usage prefetch now queries every inactive Claude/Codex host or WSL
account directly from its isolated credential source, excludes every runtime-selected account,
publishes fetching states, debounces repeated opens, and isolates per-account failures without
materializing credentials. Host Claude selection now works while existing Claude PTYs remain live:
Rust preserves the outgoing runtime credential blob before materializing the selected account for
new terminals, while reauthentication and active-account removal retain the destructive-operation
gate. Tauri publishes every real account/quota snapshot to a
persisted Go `/v1/accounts/snapshot` resource; Go emits `accounts.changed` and includes the same
snapshot in the encrypted mobile `accounts` projection. Go shared-control owns the streaming
`accounts.subscribe` ready/snapshot/end lifecycle and `accounts.unsubscribe` acknowledgement on
that event source, without a renderer polling loop or fake account record.

Tauri runtime `settings.get` / `settings.update` now read and merge the same native file-backed
settings document as the canonical React renderer. The adapter exposes only the Electron client
settings allowlist, rejects unknown/non-JSON/invalid typed fields, preserves unrelated desktop
settings, and reconciles managed agent hooks when their enablement changes.

Tauri runtime `ui.get` / `ui.set` / `ui.recordFeatureInteraction` now read and write the canonical
native `ui` document. Electron and Tauri parse remote UI mutations with the same extracted Zod
schema, including enum, finite-number, nested workspace, feature-tip, and feature-interaction ID
validation. Feature interaction counters preserve their first timestamp and increment atomically in
the renderer-owned native document.

Tauri runtime `terminal.setDisplayMode`, `terminal.getDisplayMode`, and
`terminal.updateViewport` now use the same mobile fit/driver mirror consumed by the canonical
renderer. Mobile viewport changes update the fit override and resize the real Go PTY; desktop mode
clears the override and calls the runtime reclaim endpoint, so presence locks and terminal geometry
cannot diverge between desktop and mobile projections.

Legacy-compatible Go shared-control now mutates session tabs as well as reading them:
`session.tabs.activate` preserves and persists the renderer-owned layout, while
`session.tabs.close` resolves the canonical tab to its native Go PTY, stops it, selects the remaining
active tab, and publishes the updated snapshot. Remote Web/CLI tab switching and closing therefore
no longer require Electron main or a Tauri-side memory-only response.
`terminal.resolvePane` and `terminal.focus` now resolve the same Go session metadata, so terminal
links and remote focus requests no longer depend on Electron's in-memory pane registry.
`terminal.create` now starts the canonical Go PTY from a real worktree with renderer tab/leaf,
environment, viewport, launch-token, and agent metadata. `terminal.wait` uses Go's native exit and
hook-idle wait primitive on a cancellable goroutine, keeping terminal streams and unrelated RPCs
responsive while a long wait is pending.
`terminal.resolveActive`, `terminal.show`, and `terminal.inspectProcess` now expose authoritative Go
session placement and process metadata. `terminal.stop` and `terminal.stopExact` terminate native
PTYs directly; exact mode validates the complete expected live set or an explicit target-only set
before stopping, then re-reads native session state and reports remaining live PTYs or kill failures
instead of claiming unverified success, so concurrent remote session creation cannot cause accidental
termination or unsafe worktree deletion.
`terminal.split` now creates the second native Go PTY with the source session's project, worktree,
cwd, agent identity, viewport, and tab metadata while allowing command/environment overrides. It
recursively replaces the source leaf in the durable renderer-compatible pane tree, preserves nested
siblings and ratios, and stops the new PTY if layout persistence fails. `terminal.focus` persists the
active tab through `ActivateSessionTab` and propagates storage errors instead of returning a no-op
success.
Go event subscriber teardown was also made race-free: emit and channel close are synchronized by the
manager lock, preventing disconnect-time send/close races across every runtime transport.
`terminal.rename` now persists custom titles in the Go session-tab document. Shared-control
`terminal.setDisplayMode/getDisplayMode` uses the Go driver lock and real PTY resize path: a named
mobile client takes the floor in auto mode, while desktop mode reclaims it, so remote display state
does not depend on Tauri renderer memory.
Tauri phone-fit resize now enters the same Go session state machine with its `clientId`. Go retains
the first desktop viewport across repeated phone re-fits, atomically updates PTY size and driver
ownership, and the HTTP `reclaim-desktop` route restores that retained viewport before releasing the
mobile floor. The renderer map is therefore an event-facing mirror rather than the fit authority.
`session.tabs.createTerminal` now creates and groups that same PTY, preserves after-tab ordering,
and deduplicates reconnect retries by `clientMutationId`. `session.tabs.updatePaneLayout` and
`session.tabs.setTabProps` merge renderer pane trees and tab presentation state into the persisted
Go layout without replacing unrelated session-tab data.
`session.tabs.move` now persists same-group reorder, indexed cross-group moves, and left/right/up/down
splits. The Go runtime creates the same directional split tree used by the renderer and removes
empty group leaves when tabs are recombined, so remote layout mutations survive restart without a
Tauri-side memory mirror.

Tauri runtime `terminal.getAutoRestoreFit` / `terminal.setAutoRestoreFit` now persist the same
`mobileAutoRestoreFitMs` preference in the canonical native settings document. `null` retains the
Electron indefinite-hold meaning, finite values are defensively clamped to 5 seconds through 60
minutes on both read and write, and unrelated settings survive the update.

### Tauri Browser Parity Delta

`browser.exec` now covers the pinned `agent-browser 0.27.0` navigation and
keyboard compatibility surface without launching its Electron/CDP subprocess:
`navigate`, `key`, and `scrollinto` resolve to the canonical native browser
operations, while `keydown` and `keyup` remain distinct through the Go action
allowlist, Tauri runtime dispatch, and child-WebView DOM executor. This keeps
held-modifier workflows ordered instead of degrading them into a complete
keypress. Target/session override commands remain rejected because Pebble owns
the selected child WebView.

This section supersedes the browser table's stale wording that lists Chromium/Safari cookie import
as an open gap or says import affordances must remain hidden. Native Firefox, Safari, and
Chromium-family import is implemented and exposed through the canonical renderer API; the remaining
browser gaps are design-mode/CDP execution, pre-macOS-14 profile isolation, and CDP-backed WebView
inspection.

Browser child WebViews now resolve their native parent through the same configured-primary-window
boundary used by startup, deep-link activation, and optimized previews. Production continues to
prefer `main`, while descriptive dev/optimized labels attach to the actual first shell window. This
closes the optimized Tauri failure where the React browser pane existed but Rust rejected child
WebView creation because no literal `main` window was registered.

Browser download cancellation now uses native handles on every desktop platform: WebKitGTK
`WebKitDownload` on Linux, `WKDownload` on macOS, and the WebView2 download operation on Windows.
Every native handle claims one pending download ID in request order so concurrent same-URL downloads
cannot attach to the same operation. The macOS hook forwards Wry's original navigation delegate
callback, cancels by the exact retained ID, releases completed handles immediately, and bounds
orphaned handles by age and count. Windows and Linux live correlation/cancellation evidence remains
a mandatory platform release-runner gate; cross-compilation or this macOS run cannot satisfy it.

Go shared-control now exposes browser profile create/list/delete, browser tab
list/show/current/create/close, and the native executor's navigation, screenshot/PDF, snapshot,
DOM input, keyboard, scroll, selection, drag/upload, wait, capture, console/network, interception,
geolocation, media, and download commands to paired clients. Lifecycle mutations use authoritative
persisted Go state; commands enter the existing Tauri native-provider queue, and the encrypted RPC
waits for the WebView executor's completed or failed result instead of returning a synthetic queued
success. Shared-control `status.get` advertises `browser.screencast.v1`, and
`browser.screencast` now streams the existing 16-byte browser frame protocol as encrypted binary
WebSocket messages. Frames come from real Tauri native WebView capture through an octet-stream
Channel, wait for renderer ACK after the Go runtime accepts each frame, and use a capacity-one relay
that replaces stale pending frames. Streams rebind after child-WebView navigation and stop on
unsubscribe, tab destruction, or connection close. Platform-native incremental capture remains a
performance enhancement rather than a missing transport.

Mobile browser ownership now follows the same native presence-lock projection as Electron. A
shared-control screencast takes the selected Go browser page for the authenticated device, emits
`browser.driver` over the runtime event stream, and releases only if the ending stream still owns
that page. Tauri maps those events into the canonical browser overlay, hydrates reloads from
`GET /v1/browser/drivers`, and posts desktop take-back to the authoritative Go page route before
updating its local mirror. Browser-only windows explicitly start event delivery without waiting for
a PTY listener. Supported emulator shared-control methods now resolve an authoritative active Go
session, enter the same native action queue consumed by the Rust Android/iOS providers, and wait for
the real provider result with connection cancellation. Device/session changes already project over
`emulator.changed`; iOS accessibility now uses the selected simulator's live serve-sim helper
instead of returning a synthetic success or an outdated platform limitation.

Android emulator accessibility now uses a fresh bounded UIAutomator dump, maps the native adb
serial behind the authoritative Go device record, and returns the parsed tree through the same
cancellable shared-control action queue. Invalid or stale dumps fail explicitly. iOS resolves the
per-device serve-sim state, reads its local AX helper, and bounds normalized output to 500 elements;
the universal helper is an explicitly signed app resource, and Rust sends touch, button, keyboard,
and rotation protocol frames directly without Node or a PATH-installed serve-sim CLI. The separate
native iOS `emulator.exec` validates a bounded argv/timeout payload in both Go and Rust and strips
caller device/worktree overrides. Gesture, tap, typing, button, rotation, CoreAnimation diagnostics,
and memory warnings use the bundled helper protocol directly. Camera injection and permission-query
passthrough retain the bounded `serve-sim` CLI path until their native adapters land. Stdout/stderr are drained concurrently
with 10 MiB bounds, timeout kills and reaps the child, and only valid JSON reaches shared control.

Android `emulator.exec` now accepts only a bounded argv array and runs `adb -s <serial> shell
<argv...>` without a host shell. Go and Rust both enforce payload, argument, timeout, and output
limits; runtime device identity is authoritative, disconnect/timeout cancels the action and kills the
child. Permission grant, revoke, and reset now resolve the selected Go device's persisted `nativeId`
and dispatch bounded cancellable ADB or `simctl privacy` operations through Rust; missing or stale
native identity fails explicitly instead of targeting a guessed local device.

Native browser child WebViews now install platform permission policy on Linux WebKitGTK and
Windows WebView2. Camera/microphone, notifications, persistent storage, and clipboard-read requests
follow the Electron-compatible allow policy; display capture, geolocation, and unknown requests are
denied and projected through the existing sanitized browser notice channel. macOS retains Wry media
handling with TCC as the authoritative gate. Dynamic Go-persisted overrides and HID/WebAuthn
selection remain explicit browser permission gaps.

Browser permission overrides now hydrate from authoritative Go profile/origin records before child
WebView creation and stay current through `browser.changed` push with polling fallback. Native
Linux/Windows handlers consult the timestamped registry per request; `prompt` resets an override and
stale events cannot restore an older decision. macOS remains Wry/TCC-owned.

Hosted-review discovery now resolves GitHub fork parents through the provider API when a contributor
clone has no `upstream` remote. GitLab performs the equivalent parent-first lookup on the original
self-hosted hostname and validates `source_project_id`, preventing same-named branches in another
fork from being selected.

Hosted-review update now supports GitHub base retarget plus draft/ready transitions and GitLab target
branch plus draft/ready updates. Fork PRs retain the parent repository selector; REST-backed providers
reject unsupported mutations explicitly.

Remote file search now carries HTTP cancellation into local traversal and the SSH child process,
bounds searched files and lines, normalizes result paths across desktop platforms, and caps relay
input/output. Other context-free legacy shared-control file mutations and Windows remote-host relay
deployment remain follow-up work.

All SSH file list/read/chunk/write/mutation/stat/watch, clipboard-image, terminal-artifact, and legacy
shared-control file operations now inherit caller cancellation while retaining bounded deadlines.
Compatibility wrappers preserve existing background-context call sites.

Release manifest validation now requires every signed updater URL to target the exact canonical
Nebutra release tag and a non-empty uploaded asset present in that release. Real signing keys,
Developer ID notarization/stapling, Windows Authenticode, and live per-target update installation
remain external release gates.

Release CI now preflights exact sidecar configuration and signing/notarization inputs, enables macOS
hardened runtime, inspects staged sidecar architecture and hashes, verifies Developer ID/team/strict
signature/stapling on macOS and Authenticode on Windows, and uploads deterministic inspection evidence.
The gate intentionally fails unsigned release artifacts rather than claiming local ad-hoc output.

On macOS, child browser WebViews now install native `WKUIDelegate` alert,
confirm, and prompt handlers that retain the real WebKit completion block until
`browser.dialogAccept` or `browser.dialogDismiss` resolves it. The hook is
restricted to registered child browser WebViews so application-renderer
dialogs retain WebKit's default behavior. The canonical runtime RPC now routes
both dialog commands to the live child WebView instead of reporting an
unimplemented method. Linux uses the equivalent WebKitGTK `script-dialog`
object registry, preserving confirm and prompt results before closing the
native dialog. Windows uses WebView2 `ScriptDialogOpening` with a retained
deferral and sets prompt result text before accepting. All three desktop
platforms now route dialog accept/dismiss through the same runtime contract.

Tauri browser cookie import now reads Firefox SQLite snapshots on every desktop platform, parses
Safari `Cookies.binarycookies` from macOS trusted container paths, and imports macOS Chromium-family
profiles from trusted browser-data roots. macOS uses Keychain Safe Storage with
PBKDF2-SHA1/AES-128-CBC; Linux uses Secret Service lookup with the Chromium v10 `peanuts` fallback;
Windows reads the trusted `Local State` key and sends only its protected bytes over stdin to DPAPI,
then decrypts v10/v11/v20 AES-256-GCM values. All paths strip Chromium 127+ host hashes, snapshot
SQLite/WAL state, convert Chromium expiry timestamps, write through the native WebView cookie store,
and reject renderer-provided arbitrary source paths.

Tauri child WebViews now implement the existing renderer's `findInPage` and
`stopFindInPage` contract through bounded Rust commands. The Rust host limits
requests to Pebble-owned browser WebView labels, executes native `window.find`
with a response timeout, and returns normal `found-in-page` match events. This
keeps the existing find UI interactive rather than presenting an enabled control
that cannot complete. Persisted annotation markers also render through a
structured Rust overlay command with bounded geometry validation and native
scroll tracking. The canonical grab runtime is now connected through a bounded,
browser-child-scoped Rust eval command, so hover extraction, click/right-click selection,
cancellation, payload clamping, and annotation creation use the existing renderer UX. Remaining
browser-shell gaps are browser-profile isolation on pre-macOS-14 WebKit,
platform-owned macOS/Linux subresource fulfillment, high-rate screencast performance, and full
CDP-backed inspection parity. macOS WKUIDelegate, Linux WebKitGTK `script-dialog`, and Windows WebView2
`ScriptDialogOpening` adapters preserve synchronous alert/confirm/prompt semantics. Screencast
requires a connection-scoped binary frame lane with cancellation and backpressure; repeated JSON
screenshots are not parity. Manual JSON

`browser.setDevice` now persists the selected profile in each Tauri child-WebView state, applies
the canonical native viewport bounds, and replays script-visible UA/platform/touch/screen/media
identity before `dom-ready` after navigation. This closes document-level responsive-site parity;
mobile profiles now also rebuild the child WebView with Wry's native User-Agent while preserving
URL, history, profile isolation, and bounds, so navigation and subresource requests use that
identity. Synthesized platform touch events remain explicit native/CDP work.

`browser.intercept.enable/disable/list` now drives a Rust tab-scoped interception registry in
addition to the document adapter. The child WebView's native `on_navigation` callback blocks and
records matching top-level requests before navigation commits, preserving patterns across WebView
rebuilds and merging native document records with fetch/XHR records in the existing RPC response.
Windows WebView2 now applies `browser.intercept` to platform-owned image/script/font/media/fetch
requests through `WebResourceRequested`, records the actual request context, and returns an empty
no-store 403 for abort routes. Fulfill routes now carry their bounded body, HTTP status, and content
type into Rust; WebView2 returns those bytes through a native COM `IStream` response rather than
falling back to the page's fetch/XHR shim. Top-level fulfillments now deny the original network
navigation and move the same child WebView onto a bounded, one-shot `pebble-intercept` response
bound to its native label. macOS WKWebView/Linux WebKitGTK subresource fulfillment remains explicit
native work because their content filters do not expose an equivalent per-request list.

`browser.setCredentials` now registers bounded, memory-only credentials with the native child
WebView as well as the document fetch/XHR adapter. macOS resolves WKNavigationDelegate auth
challenges with a session credential, Linux handles WebKitGTK `authenticate`, and Windows fills
WebView2 `BasicAuthenticationRequested`; credentials remain scoped to the WebView label and never
enter Go persistence.

Agent-browser compatibility execution now routes `dialog accept [text]` and `dialog dismiss`
through the native child-WebView dialog resolver. CLI/shared-control `browser.exec` callers and
direct `browser.dialogAccept`/`browser.dialogDismiss` callers therefore resolve the same retained
platform completion object instead of falling into the Tauri unmapped-command error.

cookie-file import, Firefox profile SQLite import, and bounded `browser.eval` page inspection now run
through native Tauri commands.
Rust now creates child WebViews with shared per-profile native data directories on Windows/Linux and
stable WebKit data-store identifiers on macOS 14+. Cookie get/set/delete and default-profile cookie
clearing use Tauri's native cookie store, including HttpOnly, Secure, SameSite, expiry, URL/domain
scoping, and preserve cache and local storage.
Fresh native PTY spawn replay is delivered through the renderer transport callback before
interactive input begins. This closes the Tauri-only blank-terminal failure where the Go PTY and
shell were alive but the login prompt returned during spawn was never painted into xterm.
The runtime provider remains `degraded`, but advertises the working native WebView,
profile-isolation, element-grab, annotation-selection/overlay, find, cookie-clear, native download
start/finish, cross-platform byte progress/cancel, native HTTP Basic challenges, canonical context menus, permission-denied notices,
and macOS/Windows/Linux child-WebView screenshot capture instead of claiming the whole WebView
adapter is missing.

### Tauri Project Clone Parity Delta

Local project cloning now runs in the Go runtime with a dedicated ten-minute budget, streams
Git's carriage-return progress through the existing runtime event channel, and exposes a bounded
abort endpoint. The canonical React add-project flow receives the same phase/percent events and its
Cancel action terminates the active clone while cleaning only the directory claimed by that run.
Remote SSH cloning now uses the auto-deployed Go relay worker. The worker validates and expands the
remote destination, runs argv-based `git clone --progress`, emits structured JSONL phase/percent
events, and returns the canonical remote path used to persist the SSH project. Local and remote
clones share the same ten-minute context, single-clone concurrency slot, progress event topic, and
abort endpoint; cancellation terminates the SSH command without deleting a pre-existing target.

Remote nested scan/import relay fallback is restricted to explicit missing-runtime capability
codes. Paired-runtime permission, validation, transport, and operation failures remain visible and
cannot be replaced by stale relay scan snapshots.

Tauri browser provider actions now execute canonical `browser.snapshot` refs plus click,
double-click, fill, type, focus, clear, keypress, scroll, scroll-into-view, select, check, hover,
select-all, HTML5 drag, bounded condition waits, persistent console/network capture, and bounded
fetch/XHR URL-pattern interception against the live child WebView through native commands. The
provider also matches agent-browser's `get` contract for text/html/value/url/title/count/box/styles
and `is` contract for visible/enabled/checked, including the existing `{ origin, ... }` result shape.
Semantic `find` supports role/text/label/placeholder/alt/title/testid locators with
click/focus/fill/check actions, and keyboard insert-text writes to the focused control without
synthetic key events, matching the Electron agent-browser contract.
Runtime-backed tab current/switch state is scoped per worktree, `--focus` reuses the canonical
browser-pane focus event, and profile show/set/clone update or create real Go runtime tab records so
the existing renderer remounts child WebViews on the selected native profile partition.
Full-page screenshots now capture bounded native WebView viewport segments, suppress repeated
fixed/sticky elements after the first segment, restore page scroll/style state, and stitch the
segments in Rust at device-pixel scale instead of relabeling a viewport screenshot.
Every
child WebView installs fixed 1000-entry capture and interception hooks before page scripts run, and
the Go action queue remains the single completion path for UI, mobile, and CLI callers. Browser and
emulator callers now await `computer.changed` terminal records through the shared native
runtime push stream. A bounded terminal cache closes completion-before-subscribe races; action-list
polling is disabled while push is connected and, during disconnects only, concurrent waits share one
100 ms fallback request per kind prefix rather than polling once per action. Local file upload now
uses a bounded Rust reader (16 files, 32 MiB each, 64 MiB total) and constructs a real
WebView `FileList` for the referenced file input instead of attempting to spoof its path. Cross-origin
frame refs, per-request continue/fulfill overrides, and full CDP inspection remain browser-automation
gaps.
CLI/mobile `browser.download` now registers an absolute non-overwriting destination in the Rust
download registry before clicking a canonical snapshot ref, associates the next native WebView
`DownloadEvent` with that request, and completes the Go provider action only after the native finish
event reports the resolved path. Stale requests release their path reservation after a bounded timeout.
Geolocation overrides now persist inside each live child WebView and implement
`getCurrentPosition`, `watchPosition`, and `clearWatch`; coordinate updates notify existing watchers
and return the same latitude/longitude/accuracy contract as Electron's CDP adapter.
`browser.pdf` now uses each host WebView's native print path: `WKWebView.createPDF` on macOS,
WebView2 `PrintToPdf` on Windows, and a WebKitGTK `PrintOperation` targeting a unique host-owned PDF
file on Linux. Every platform returns bounded, signature-validated bytes through the Go provider
action and removes temporary output after capture.
`browser.exec` now parses quoted agent-browser command strings through a shared Electron/Tauri
argument parser and dispatches migrated navigation, DOM, mouse, storage, cookie, clipboard,
geolocation, screenshot, PDF, eval, upload, download, semantic find, bounded wait, viewport,
console/network log, device, offline, headers, credentials, and media-emulation commands back into
the canonical runtime RPC methods. Session/CDP
target overrides and commands without a native adapter fail explicitly instead of spawning Electron.

Tauri setup terminals now subscribe to runtime events before spawning, retry while the native
runtime is cold-starting, and return an initial tail replay so a shell prompt emitted before SSE
delivery is not lost. Optimized/dev window promotion resolves the configured primary WebView
instead of assuming the production `main` label, so runtime-backed terminals are never left behind
an invisible shell process.

The Tauri Android provider now executes tap, straight-line gesture/swipe, text, hardware-key,
orientation, screenshot, install, launch, and bounded logcat-snapshot actions through validated
`adb` argv. Normalized gesture coordinates are resolved against live `wm size`; button names and
orientations use allowlisted platform values, and text/control limits are enforced before reaching
the device shell. Continuous log streaming remains a subscription concern rather than a long-lived
action-queue claim.
The iOS simctl provider likewise returns bounded unified-log snapshots through `simctl spawn log
show --last` instead of rejecting every logs action. iOS touch, text, hardware-button, and rotation
synthesis still require a native CoreSimulator HID/XCTest host because plain `simctl` exposes none
of those operations.

Zig layer status: `native/zig-system/` (see its README) is built for every Tauri
target and statically linked into the Rust host. Local-speech builds add loader-relative RPATHs for
Sherpa/ONNX (`@loader_path` plus app Frameworks on macOS, `$ORIGIN` plus sibling lib on Linux), so
direct CLI/single-instance launches do not depend on Cargo-injected dynamic-library environment.
target, lipo-combined for universal macOS, tested in release CI, and linked into
the Rust host. ABI version 1 is checked before the window starts, and Unix Go
runtime termination uses its signal primitive. PTY session ownership remains
Go's (`creack/pty`); measured binary transport and low-level accessibility work
are the next candidate Zig boundaries.

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

| Legacy route                                    | Nebutra route                                             | Surface                 | Status                                                                                                       |
| ----------------------------------------------- | --------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `https://onpebble.dev`                          | `https://www.nebutra.com/pebble`                          | Product landing page    | App/README/Homebrew links migrated; nebutra.com must serve it.                                               |
| `https://onpebble.dev/download`                 | `https://www.nebutra.com/pebble/download`                 | Download page           | App/README links migrated; nebutra.com must serve it.                                                        |
| `https://onpebble.dev/docs/*`                   | `https://www.nebutra.com/pebble/docs/*`                   | Mintlify docs           | App/README/mobile links migrated; route list below.                                                          |
| `https://onpebble.dev/whats-new/changelog.json` | `https://www.nebutra.com/pebble/whats-new/changelog.json` | Update changelog feed   | App now reads the Nebutra route; nebutra.com must serve static JSON.                                         |
| `https://onpebble.dev/whats-new/nudge.json`     | `https://www.nebutra.com/pebble/whats-new/nudge.json`     | Update nudge feed       | App now reads the Nebutra route; nebutra.com must serve static JSON.                                         |
| `https://onpebble.dev/media/*`                  | `https://www.nebutra.com/pebble/media/*`                  | Changelog media assets  | Feed media should use this static bucket/object-prefix route.                                                |
| `https://www.onpebble.dev/diagnostics/token`    | `https://www.nebutra.com/pebble/diagnostics/token`        | Crash diagnostics token | Release workflows now compile official builds against the Nebutra route; nebutra.com must serve or proxy it. |
| `https://www.onpebble.dev/v1/feedback`          | `https://www.nebutra.com/pebble/v1/feedback`              | Feedback submission API | App now posts only to the Nebutra route; dynamic POST route or proxy required.                               |
| `https://api.onpebble.dev/v1/feedback`          | `https://www.nebutra.com/pebble/v1/feedback`              | Feedback fallback API   | Legacy fallback removed from app; keep this listed only for external redirect/proxy cleanup.                 |

## Nebutra package namespace backfill

The app-facing package name has moved to `pebble`, but the test harness still
uses an npm alias:

- `@nebutra/playwright-test` -> `npm:@stablyai/playwright-test@^2.1.14`

Do not switch this specifier to `@nebutra/playwright-test` until the Nebutra
package and its transitive `@nebutra/playwright` / `@nebutra/playwright-base`
packages are published or vendored. Once available, update `package.json`,
refresh `pnpm-lock.yaml`, and remove the remaining `@stablyai/*` lockfile
entries.

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

## Agent hook migration status

## Runtime parity table corrections

This section supersedes stale gap wording in the migration table above. Current source and focused
tests prove the following paths are migrated:

- The production renderer/Tauri boundary has an AST-backed coverage gate. It currently proves all
  243 literal runtime methods have either a local domain dispatcher or an explicit remote-only
  owner, and fails mainline verification when a new renderer call can reach the local fallback.
  `orchestration.dispatchShow` now reads the latest Go dispatch record and maps its persisted session
  identity to the existing terminal-link contract instead of returning `method_not_available`.
  Its `preamble` mode is native as well: Go owns one embedded worker protocol used by both real
  injected dispatches and read-only previews, preserves the latest dispatch ID when one exists,
  supports production/development CLI names, and exposes the same result through local HTTP and
  paired shared-control. Tauri no longer throws an unavailable error for this path.
- Paired and mobile shared-control now expose the same `orchestration.dispatchShow` projection. Go
  resolves the latest persisted task dispatch and returns the canonical terminal handle, so clicking
  an orchestration task link focuses the same session whether its runtime owner is local or remote.

- Local nested scans register request contexts and cancel through
  `/v1/project-groups/scan-nested/cancel`; relay-only scans and imports use the deployed worker and
  `/v1/ssh-targets/:id/nested-scan` routes.
- Relay-only agent detection runs through `pebble-relay-worker agent-detect` and feeds the same host
  capability projection as paired runtimes.
- SSH passphrases/passwords are held only in Go's process-memory cache, supplied through bounded
  askpass helpers, consulted by renderer prompt gating, and cleared on reconnect/removal.
- Local Whisper and transducer dictation use the feature-gated sherpa-onnx Rust engine; model
  downloads, cancellation, session audio, finalization, and explicit unavailable builds share the
  canonical speech API.
- Legacy relay terminal artifacts use `terminal-artifact-json` with grant/read/preview/write
  operations and the same recent-output provenance checks as local/paired-runtime paths.
- Hosted-review mutations route through Go's provider-neutral update endpoint: GitHub title/body,
  close/reopen, and reviewer deltas use `gh`; GitLab title/body and close/reopen use `glab`. The
  Tauri dispatcher maps the dedicated `github.updatePRTitle` method as well as the broader update
  methods, so the renderer cannot fall through to `method_not_available`. GitLab full reviewer-list
  replacement preserves numeric IDs and explicit empty-list clearing through `glab api`, and maps
  the server's resulting reviewer rows back to the canonical renderer contract.
- Hosted-review merge mutations now use the provider-neutral Go route as well: GitHub preserves its
  squash default and `merge`/`squash`/`rebase` options through `gh pr merge`; GitLab preserves its
  regular-merge default and strategy flags through `glab mr merge --yes`. Provider CLI execution
  globally disables hidden gh/glab prompts so background runtime requests remain bounded.
- GitHub auto-merge enable/disable now runs through Go without changing Electron semantics. The
  runtime resolves the PR node/head identity, probes the base branch's merge queue, uses the
  `enablePullRequestAutoMerge` GraphQL mutation for ordinary branches so a clean PR cannot merge
  immediately, and reserves `gh pr merge --auto` for merge-queue branches. Disable and the
  actionable already-mergeable error are preserved through the Tauri RPC contract.
- Top-level review conversation comments now use Go provider routes: GitHub issue/PR comments
  preserve cross-repository owner/repo overrides and `gh api` response identity, while GitLab MR
  notes use the selected worktree's `projects/:id` context. Both return canonical author, avatar,
  body, timestamp, URL, and bot metadata to the unchanged React review surfaces.
- Inline review comments now retain full diff-position semantics through Go: GitHub sends commit,
  path, end/start lines, and RIGHT-side fields to the PR review-comment API; GitLab sends base/start/
  head SHAs plus old/new paths and returns the discussion thread identity. Canonical line, range,
  path, author, bot, and thread metadata flow back through the Tauri dispatcher.
- Review thread follow-up mutations now remain native too: GitHub replies target the parent review
  comment while preserving thread/path/line context and cross-repository overrides; GitLab resolves
  or reopens the entire discussion with an explicit boolean through `glab api`.
- GitHub thread resolution now uses the matching GraphQL `resolveReviewThread` or
  `unresolveReviewThread` mutation against the global thread node ID, completing resolve/reopen
  parity on both hosted-review providers without routing back through Electron.
- GitHub review-file read state now maps the canonical boolean API onto GraphQL
  `markFileAsViewed`/`unmarkFileAsViewed` with the PR node ID and repository-relative path, so the
  unchanged diff file list can persist Viewed toggles under Tauri.
- Desktop PTY output remains raw and therefore preserves OSC 8/52/133 bytes for canonical xterm and
  link routing. “Exact renderer-xterm serialization” refers only to mobile rendered-screen
  snapshots, not a missing desktop terminal transport.
- Full-scope paired runtime environments now discover projects and worktrees through encrypted
  `repo.list` / `worktree.list` WebSocket RPCs. Go projects are projected into the canonical
  renderer `Repo` shape and worktrees include the same host, git-level, metadata, and millisecond
  timestamp defaults as the local Tauri bridge. Project-group, folder-workspace, and worktree
  lineage hydration plus group/folder create, update, move, path-status, and delete mutations use
  the same full-scope encrypted channel. Repo add/show/supported-update/remove/reorder and worktree
  show/metadata-update/reorder now share that path as well; folder projects retain `kind: folder`,
  and unsupported repo metadata fields fail explicitly instead of returning fake persistence.
  Repository clone and worktree removal execute real host-side Git operations in the paired runtime,
  including archive-hook policy, force handling, preserved-branch reporting, disk removal, and
  metadata retirement. Basic paired-runtime worktree creation now executes `git worktree add`,
  applies canonical metadata and lineage, returns the full runtime worktree record, and rolls back
  the disk worktree/branch if post-create persistence fails. Cone-mode sparse checkout is applied
  and persisted natively; explicitly approved `pebble.yaml` setup hooks run with bounded host shell
  execution; startup commands/environments run in a background Go PTY; and startup-agent-only calls
  resolve through a Go catalog aligned with the canonical TUI launch commands. Submitted startup
  prompts preserve each agent's argv, prompt flag, interactive flag, or stdin-after-start strategy,
  and `createdWithAgent` survives persistence. Automation-created workspaces now use a random,
  runtime-issued, expiring dispatch token: Go validates the authoritative automation/run/repo
  envelope before Git creation, prevents concurrent replay, releases failed reservations for the
  same create request, consumes successful tokens, and persists server-derived provenance on the
  worktree. Review-before-send startup drafts now preserve the canonical native `--prefill`
  and one-shot environment strategies where supported; other agents use an eight-second bounded
  Go PTY scanner for bracketed-paste enablement plus the Codex composer, OpenCode/Mimo cursor, or
  quiet-render readiness signal, then receive a sanitized bracketed paste without Enter.
  Mobile-scoped tokens remain denied these methods.

Full-scope paired runtimes now answer `preflight.detectAgents` and
`preflight.refreshAgents` with a native Go PATH probe aligned to canonical agent IDs and real
binary aliases; mobile tokens remain forbidden from desktop host discovery. Provider and file
runtime-control methods are now fully exposed on the encrypted paired channel; remaining
shared-control work is tracked from the full method-surface audit rather than those closed categories.

Paired runtimes also answer native-provider list/status/registration and
`preflight.detectWindowsTerminalCapabilities` from the runtime host itself. Tauri resolves the
requested `connectionId` over the encrypted runtime channel and normalizes the remote response;
it returns an empty capability snapshot when that target is unavailable instead of substituting
the controlling desktop's platform, WSL distributions, PowerShell, or Git Bash state.

Relay-only SSH targets now use the same contract without requiring a callback from the remote
host: Go deploys or reuses the purpose-scoped `pebble-relay-worker`, executes its read-only
`terminal-capabilities-json` command over the selected SSH target, and Tauri normalizes that route
as the fallback after paired-runtime RPC. Linux/macOS relay hosts therefore report their real
platform instead of inheriting the desktop. Native relay-worker deployment to Windows SSH hosts
remains a separate cross-platform release gate.

Paired repository default-base and ref search now execute native, timeout-bounded Go git commands
inside the runtime host's authoritative project path. Default-base probing preserves remote HEAD,
main/master fallback and remote-count semantics; search returns both renderer ref names and local
branch projections without routing the remote path through the controlling desktop.

Paired project configuration now owns `pebble.yaml` hook checks, five-source setup-script import
detection, and layered issue-command read/write on the runtime host. Project creation creates and
validates the directory, initializes Git, creates the initial commit, rolls back partial failures,
and is used by both local Tauri and paired runtime-control. PR/MR start-point resolution and
optimistic base prefetch preserve the Rust command's same-repository and fork ref semantics.
Worktree removal persists a project/branch/head cleanup ticket, so safe compare-and-swap branch
deletion remains available after a runtime restart.

Tauri local workspace sessions now bypass the paired-Web sanitizer and persist the complete
renderer session document, including tabs, pane layouts, and byte-bounded inline terminal
scrollback. The native document backend uses a synchronous local write-ahead mirror for the
before-unload path, then coalesces atomic native-file writes; startup detects and replays a newer
mirror over a stale native document. Immediate window close therefore no longer loses the final
session while waiting for the native write debounce, and no Electron sync IPC or scrollback-ref
file is required by the Tauri shell.

External file import no longer inherits the paired-Web empty-result adapter in Tauri. Local
explorer/composer imports use a Rust no-clobber copier that rejects symlinks before creating the
destination tree; paired-runtime and legacy SSH imports use the same Rust staging format with a
25 MiB per-file and 100 MiB aggregate bound. Paired targets receive the existing encrypted runtime
RPC upload, while legacy SSH targets route `files.createDirNoClobber`, chunked base64 writes,
commit, rollback, and terminal `.pebble/drops` staging through the Go relay worker. Windows drops
into local WSL worktrees preserve the Electron distro-aware path conversion without importing any
Electron main module.

This supersedes the earlier status-table wording about a remaining shared-control allowlist. The
mainline verifier compares every Tauri runtime-control `case` against production Go handlers. Its
only exclusions are controller-owned OS permission UI, controller-side secondary SSH detection,
and renderer activation state; adding any other unmapped method fails CI.

Go PTY sessions now maintain a same-size `vt10x` screen state and send final styled cell/cursor state
for alternate-screen mobile snapshots instead of replaying raw TUI cursor history. ANSI/256/RGB
foreground/background colors and text attributes are preserved. Ordinary mobile scrollback snapshots retain raw PTY bytes, truncate only at complete UTF-8 and ANSI/OSC boundaries, and restore an OSC 8 hyperlink that spans the truncation point. The remaining runtime gates are release-level Windows WSL install/remove smoke coverage and a real Linux/macOS amd64/arm64 SSH deployment matrix. These do not justify Electron
ownership of the desktop shell.

The Tauri release matrix executes the Tauri renderer/preload typecheck and Vitest suite, complete Go
runtime suite, and native Rust host tests before packaging on macOS, Linux x64, Linux arm64, and
Windows x64. Platform-only WebKitGTK/WebView2 hooks are therefore runner-executed gates instead of
compile-only checks that can fail late in bundling.
The same matrix runs the real-runtime Tauri gate on macOS and Windows and under Xvfb on both Linux
architectures. It must mount the canonical renderer, execute a real Go-backed PTY command, load a
native child WebView, project source-control state, parse GitHub and GitLab checks, and read a native
chat transcript before release packaging begins. Screenshot fidelity and physical-device evidence
remain separate platform gates.
The macOS release runner also blocks packaging on the Electron/Tauri pixel and Settings-performance
gate. Landing, Settings, Update, and Crash surfaces retain a 1.5% maximum pixel mismatch, while five
Settings first-switch samples enforce a 350 ms P95, a 100 ms maximum long task, and zero long-task
events. The workflow uploads the reference, candidate, diff, samples, and report even when the gate
fails, so pixel parity cannot regress behind a successful functional smoke test.
macOS artifact inspection also launches the final signed app executable for three seconds before a
graceful termination. This makes dyld resolve the packaged Sherpa and ONNX `@rpath` dependencies, so
a signed bundle with missing Frameworks cannot pass release evidence again.
Linux and Windows computer-use no longer stop at a Tauri unsupported result. Their existing native
AT-SPI/Python and UI Automation/PowerShell providers are bundled as Tauri resources and drained by
the same Go action queue as the macOS helper. Rust owns bounded one-shot process execution, cached
element identity, window targeting, bridge-error typing, and projection into the canonical snapshot,
screenshot, list-apps, list-windows, and action contracts. Linux release runners install the real
AT-SPI/PyGObject/xdotool dependencies. Real desktop-session actions on Windows and Linux remain
release-runner evidence requirements; unit projection or resource checks are not substitutes.
The native snapshot cache now matches Electron's bounded lifecycle: at most 32 snapshots retained
for two minutes, with generation-aware alias eviction so refreshed app/window targets are preserved.
Release inspection extracts MSI, NSIS, DEB, and AppImage installers and rejects any package missing
either native provider script; macOS evidence also records both scripts from the signed app bundle.

Tauri runtime TypeScript no longer imports any Electron `packages/product-core/main` module. Notification copy,
speech-model catalog data, and external automation job projections now live in `packages/product-core/shared`; the
Electron paths are compatibility re-exports only. `verify-tauri-mainline` scans every Tauri TS/TSX
import and fails if a new Electron-main dependency is introduced, making Electron removal a
structural invariant rather than roadmap intent.

Tauri now owns all fourteen local managed-hook lifecycles in Rust: Claude/OpenClaude, Codex, Gemini,
Antigravity, Amp, Cursor, Droid, Command Code, Grok, Copilot, Hermes, Devin, and Kimi. Startup and the existing
`agentStatusHooksEnabled` setting install or remove Pebble-owned definitions without overwriting
third-party hooks, and scripts are written before settings are atomically replaced. Gemini also
preserves its JSON stdout contract, millisecond timeout, and stale event cleanup. Cursor preserves
its versioned top-level command schema and cleans both legacy nested and direct commands. Droid
preserves Factory's event/matcher schema and surfaces the global `hooksDisabled` state. Command
Code recovers sanitized hook metadata from ancestor processes or a port-matched endpoint file.
Grok uses its dedicated trusted global `~/.grok/hooks/pebble-status.json` file. Devin parses JSONC,
uses platform-specific config paths, and reports overlapping Claude imports. Kimi uses a bounded
marker block that preserves user TOML byte content and writes a rolling backup. Amp installs its
complete five-event TypeScript plugin with endpoint refresh and a bounded non-blocking queue while
never overwriting a user-owned same-name file. Copilot owns its dedicated 13-event hook file,
preserves user definitions, removes stale managed commands, and writes the executable before the
atomic JSON replacement. Antigravity preserves its dedicated bundle, mixed direct/tool event schema,
passive permission behavior, and event-specific Windows wrappers. Hermes owns YAML enablement,
rolling config backup, marker-protected removal, and the complete bounded ten-event Python plugin.
Codex owns its managed runtime home, resource links or ownership-marked fallback copies, system user
hook mirror, approved/disabled trust remapping, exact SHA-256 identity, and atomic hooks/TOML writes.

The Go runtime now owns the bounded, versioned, purpose-scoped SSH agent-hook bootstrap transport:
saved target options, cached askpass credentials, timeout, stdin delivery, and capped diagnostics no
longer require Electron. Successful Tauri SSH connect now invokes the deployed relay worker on this
best-effort channel. The worker owns source-faithful remote Claude/OpenClaude JSON merging and
executable scripts. Gemini additionally preserves its millisecond timeout and JSON stdout contract;
Cursor uses its direct-command/versioned schema; Droid adds its eight events and matcher semantics,
closing an SSH gap that also existed in Electron. Amp installs its complete bounded five-event
TypeScript plugin without overwriting a user-owned same-name file. Antigravity preserves its mixed
bundle schema and passive outputs; Copilot installs all thirteen event-specific commands. The
dedicated trusted Grok hook file now carries all eight events and three matcher definitions. Command
Code preserves its three-event schema and recovers sanitized metadata from ancestor processes or a
port-matched production/development endpoint file. Hermes, Devin, Kimi, and Codex now preserve their
source-specific YAML/plugin, JSONC, marker-delimited TOML, and trusted-hash contracts. All fourteen
remote formats are migrated. Go now probes the SSH host platform, resolves or CGO-free cross-builds
the matching relay worker, atomically deploys it under `~/.pebble/bin`, and injects that exact path
before connection bootstrap. A real Linux/macOS amd64/arm64 SSH matrix remains a release-validation
gate rather than an implementation placeholder.

Go now also owns SSH local port-forward process lifecycle and durable configuration, restores saved
forwards after a successful Tauri reconnect, migrates legacy rows without IDs, and terminates
target-scoped forwards explicitly. Remote listening-port detection runs in the deployed CGO-free
relay worker on Linux/macOS, and the Add Remote Project directory picker uses a bounded raw
system-SSH listing with the same path/entry contract as Electron. Tauri maps all of these APIs and
change events directly instead of inheriting web-client empty or unsupported implementations.

Packaged Tauri clients now carry the complete CGO-free relay-worker deployment matrix for macOS,
Linux, and Windows on amd64/arm64. Rust gives the Go runtime only the signed Tauri resource directory;
Go resolves a fixed target-qualified filename before the same-host sidecar or development source-build
fallback. A macOS client can therefore bootstrap a fresh Linux/Windows SSH host without shipping the
Go source tree or requiring a compiler on the user's machine. Production builds strip the worker
matrix, sign both bundled Darwin executables with hardened runtime before the app resource seal, and
reject release evidence unless all six packaged architectures plus both Darwin Developer ID
signatures validate. Native runner install/deploy evidence remains a release gate, not an
implementation fallback.

Release inspection now extracts the generated Linux Debian package and Windows MSI into isolated
temporary roots, then requires the complete six-target relay-worker matrix and validates every
installed binary architecture. The matching native release runners also self-extract AppImage and
silently install NSIS into isolated roots, verify the same matrix, and clean up afterward. macOS
inspects the `.app` resource tree directly.

Tauri now also owns the canonical desktop save/download sink. Small generated files and bounded
runtime chunks use a native save dialog, same-directory temporary files, rollback-safe replacement,
and cancellable Rust-held transfer sessions instead of the web client's unsupported methods.
Paired runtimes and legacy SSH projects both stream `files.readChunk` through the Go runtime into
that native sink, so remote downloads do not buffer whole files in React or depend on Electron IPC.

The canonical emulator pane's MJPEG path now terminates in Rust rather than inheriting the web
preload rejection: the native host validates the stream endpoint, bounds partial JPEG state,
throttles delivery to 30 FPS, reconnects interrupted streams, and exposes explicit start/stop plus
frame/error events to the unchanged React hook. Android live video now uses a checksum-pinned
scrcpy 2.4 server, bounded native ADB deployment/forwarding, dual socket lifecycle, H264 codec and
frame metadata parsing, and real access units delivered to the existing WebCodecs canvas. Per-stream
GOP indexes are preserved without mock/JPEG substitution. Cross-subscriber GOP replay, binary
channel transport, and real-device release evidence remain explicit gates.

The fourth native closeout pass also adds Windows OpenSSH relay deployment and execution, remote
worktree creation/base-SHA reconciliation with paired-runtime and relay event projection, and real
provider CLI text generation through Go for commit and pull-request content. Provider execution is
bounded, cancellable, shell-free, and runs on the selected SSH host when requested. Deep-link
routing now covers pairing, settings, tasks, activity, automations, skills, mobile, and space with an
atomic bounded cold-start queue and strict product URL validation. Windows WebView2 request control
supports native pause plus continue/fulfill/fail with request identity and timeout release. WebKit
now applies the same async lifecycle to main-frame `fetch` and asynchronous XHR; parser-loaded
images/scripts/fonts, workers, service workers, WebSockets, synchronous XHR, and real Linux
WebKitGTK host evidence remain explicit release gates.

Settings navigation no longer mutates mount state during render or progressively mounts every pane
in background idle slices. Pointer/focus intent and activation use interruptible React transitions;
the current pane remains interactive until the next pane can commit. React Activity retains visited
pane state while pausing hidden effects, and repository-specific Git/SSH probes are never prewarmed.
The highest-cost panes are independent chunks, the terminal implementation loads only for Terminal
settings, and the production Settings entry fell from about 742.5 KB to 84.0 KB raw. The postbuild
gate keeps that entry below 160 KB and proves Terminal and Repository stay independent chunks while
the remaining search-catalog work continues.

Tauri browser child WebViews now forward the complete canonical grab shortcut surface instead of
leaving `onGrabModeToggle` and `onGrabActionShortcut` on web no-op listeners. Each child receives the
effective platform/user keybinding snapshot at creation, preserves normal page copy in editable or
selected text, and forwards bounded toggle plus active-grab `C`/`S` actions over the native
navigation signal channel. Native subresource parity remains platform-specific: Windows WebView2
intercepts all platform resource loaders, while macOS/Linux currently cover top-level navigation
plus document-start fetch/XHR interception; native image/script/font/media abort/fulfill on WebKit
is still a release gate.

Custom Pet assets no longer fall through the Web preload proxy in Tauri. Rust now owns bounded
image and `.codex-pet` bundle selection, UUID-scoped storage, MIME preservation, manifest/default
animation validation, decoded sprite-grid bounds, symlink/canonical-path containment, atomic bundle
promotion, base64 resource reads, and deletion. The existing React status-bar/settings surfaces and
blob cache consume the same `CustomPet` contract without a Tauri-only UI.

The third native closeout pass removes another set of production-path gaps. Browser screencast
delivery ACKs native capture immediately and forwards through a bounded latest-frame-wins slot,
preventing HTTP latency from building an unbounded visual backlog. Android emulator permission
grant, revoke, reset, cancellation, timeout, and typed errors now execute through bounded native
ADB commands; iOS permission mutation uses bounded cancellable `simctl privacy`, while synthetic
input remains an explicit unsupported capability rather than a mock success. Runtime
HTTP calls share a startup/readiness gate and recover a crashed local runtime, replaying only safe
GET requests. Hidden Settings uses React Activity to retain state while pausing effects, and native
window dragging is restricted to canonical drag regions without stealing controls or traffic lights.

The desktop-owned runtime now has one loopback-only endpoint contract shared by process startup,
HTTP RPC, SSE, and PTY input. Normal Tauri exit explicitly stops and reaps the child; the Go runtime
also watches its desktop parent PID and releases its port after a crash or force-quit. The isolated
real-runtime gate uses a dynamic loopback port and temporary data directory, imports a real Git
repository, registers its main worktree, mounts the real terminal, and proves shell execution from
PTY output. The same gate loads a deterministic page in a native child WebView, captures a real
guest PNG, and verifies staged, unstaged, untracked, and renamed Git projections through the
canonical preload API. Store injection and parity-capture shells do not satisfy this gate. The same
gate now drives an isolated `gh` executable through Go PR lookup/check normalization and mounts the
unchanged Checks sidebar with passing, failing, and pending rows. macOS functional evidence now
assigns gate ownership only to the visible optimized renderer and captures every surface through an
onscreen layer-zero WindowServer window without its shadow; this avoids hidden-main contention and
WKWebView snapshots that can omit GPU content. The same temporary repository, browser server, and provider
fixtures also drive an isolated Electron reference process at a deterministic 1200 by 800 content
viewport. Terminal, Source Control, and Checks now use normalized shared state and an enforced 1.5%
cross-shell pixel mismatch budget; local macOS evidence passes at 0.50%, 0.65%, and 1.31%
respectively. Captures are also required to be full-size, nonblank, color-distributed, and distinct;
each run writes structured evidence and a diagnostic diff and fails above budget.
Browser parity remains functional plus nonblank-pixel gated because Electron's Playwright capture
does not composite guest `<webview>` pixels while Tauri's WindowServer capture includes the native
child WebView. Nonblank screenshots alone are not accepted for the comparable renderer surfaces.

Local runtime authentication now survives Tauri's launch-to-primary WebView handoff: trusted local
WebViews share one origin-scoped credential, and Rust retains the actual managed runtime listen/token
pair as the authority for PTY writes. This prevents reloads or multiple WebViews from silently
sending terminal input with a rotated token. Explicit GitLab MR links also take precedence over a
same-branch GitHub PR, with a regression test covering the provider collision.

Updater checks now reject placeholder signing keys, foreign release endpoints, and tag/version or
artifact-directory mismatches before download. The release matrix proves macOS universal
architecture, Developer ID, hardened runtime, nested signatures and stapling; Windows PFX private
key, code-signing EKU, timestamped SHA-256 Authenticode; Linux ELF/DEB architecture; and one-to-one
updater payload signatures. Production installation and distribution still require the real Apple,
Windows, and Tauri updater secrets plus live runner evidence; those external gates are not simulated.

Tauri PTY management now reads and mutates the same Go runtime sessions as the terminal data plane:
the Settings session table, single/all termination, and Rust-owned runtime restart no longer inherit
the web client's successful no-op adapter. Native close interception is installed before React and
queues startup close requests until editor/terminal guards subscribe. Cold Settings pane imports are
contained inside each section so the sidebar and section chrome remain responsive. Release sidecar
preparation also discovers the Developer ID identity imported by `tauri-action` and fails early when
a configured Apple certificate is unavailable to `codesign`.

The nested PTY contract is native as well: renderer delivery tracks bounded per-session in-flight
output, consumes xterm ACKs, prioritizes active/visible panes, and reports real pressure diagnostics.
Replay has an explicit Tauri subscription channel, while reconnect gaps continue through the durable
runtime-event polling fallback. Renderer buffer serialization now uses generation-safe pane ownership,
request/response timeouts, and an exact xterm snapshot before falling back to the Go terminal screen.
The isolated real-runtime gate proves terminal output, browser, source-control, and checks behavior
with these delivery controls enabled.

Remaining native implementation work is deliberately visible rather than represented by inert UI.
Windows Tauri now owns the native tray lifecycle, Open/Quit menu, restore gesture, and guarded
`minimizeToTrayOnClose` path. macOS/Linux WebKit image/script/font/media subresource fulfillment
remains a typed platform limitation. Release completion still requires the real Windows/Linux window,
Windows WSL install/remove, Linux/macOS SSH architecture, emulator/device, and Linux WebKitGTK host
evidence described above.

## Remaining rename/productization gaps

## Repository extraction status

The shipping Pebble repository no longer presents a root Electron application or an ambiguous
root `src/` tree. The canonical layout is now `apps/desktop`, `apps/mobile`,
`packages/product-core`, `runtime/go`, and `native/*`. The root package has no Electron `main`
entry, Electron-only dependencies and build tooling live in the private
`@pebble/electron-reference` workspace, and repository verification prevents the old paths from
returning.

Two retirement boundaries remain explicit:

- `packages/product-core/relay` remains a Node relay compatibility implementation until the Go
  runtime owns every deployed SSH/runtime operation and the corresponding platform evidence.
- `migration/electron-reference` remains non-shipping parity evidence until Windows, Linux, SSH,
  browser-subresource, and emulator/device gates have native replacement evidence. It can then be
  deleted as one isolated package without restructuring Pebble again.

### Product vocabulary contract

Chinese product UI names a Pebble-managed Git workspace/worktree **平行宇宙**. This gives parallel
agent work a memorable, low-burden concept without weakening the underlying production-grade Git
isolation. A repository remains a **项目**, agent continuity remains a **会话**, detachable surfaces
use **浮动工作台**, and non-Git folder mode uses **文件夹空间**. Linear, OpenCode Go, and other
third-party workspace concepts keep **工作区**. Internal identifiers and wire contracts remain
`worktree`; this is a deliberate product-language boundary, not a risky protocol rename.

The repository now has no legacy product identifier in tracked or working-tree source outside this
historical roadmap. `legacy-brand-identifier-scan.mjs` checks tracked paths and text for standalone,
CamelCase, environment-prefix, and hidden-directory forms while excluding ordinary identifiers such
as `ForCandidate` and `ErrorCard`. Project-owned ignore rules cover Rust, Zig, Go sidecar, native
helper, and desktop staging outputs; generated caches and obsolete Electron/Tauri build copies are
not part of the source tree. Removing the remaining Electron parity harness is a separate retirement
gate and must follow replacement of its cross-platform visual and behavioral evidence.

The product API contract is now physically owned by `packages/product-core/shared/preload-api-types.ts`; Electron's
preload consumes that contract instead of owning or re-exporting it. The canonical renderer has no
relative import that resolves into `packages/product-core/main` or `packages/product-core/preload`, and its browser surface uses a
shell-neutral WebView contract rather than Electron namespace types. Browser grab payloads, guest
scripts, and worktree-name sanitization are shared product modules. `verify-tauri-mainline` resolves
renderer and Tauri imports and rejects any new dependency on Electron main, while native preload
coverage still proves all 74 namespaces and 243 renderer methods are mapped.

Repository cleanup follows dependency direction rather than cosmetic moves:

1. **Complete:** applications, runtime, native hosts, contracts, and architecture docs live under
   `apps/`, `runtime/`, `native/`, `packages/`, and `docs/architecture/`; the nested product directory
   is forbidden by `verify-pebble-repository-layout.mjs`.
2. **Complete:** shared contracts and the canonical renderer no longer depend on Electron main or
   preload implementation files.
3. **Complete:** Electron main and preload now live together under
   `migration/electron-reference/src/` as an explicitly non-shipping parity reference. This
   move must preserve the cross-platform behavioral and pixel evidence until native replacement
   evidence exists; symlinks and compatibility forwarding directories are not acceptable.
   The first relay extractions are complete: audited PTY overlay mirroring/removal, POSIX shell
   startup environment discovery, Windows Git Bash/WSL detection, PowerShell 7 availability,
   recursive filesystem watcher exclusions, shell-ready parsing/templates, OMP shell wrapping, and
   Windows foreground-process resolution, SSH framing/multiplexing, and streamed file reads now live
   in `packages/product-core/shared`. Relay source and relay-owned tests have zero imports that resolve into
   `packages/product-core/main`; the repository-layout gate enforces that boundary. The cross-layer Agent hook
   roundtrip now lives under `tests/integration` because it intentionally proves relay-to-Electron
   parity rather than belonging to relay production ownership. CLI hook installation is also
   extracted: 14 managed agent installers and their platform-neutral file mutation primitives live
   in `packages/product-core/agent-hooks`, and `packages/product-core/cli` has no import or tsconfig whitelist into Electron main. The
   repository-layout gate enforces both boundaries. Repository scripts, workflows, cross-layer
   evidence, and TypeScript projects now address the parity reference at its migration path; the
   same gate forbids `packages/product-core/main` and `packages/product-core/preload` from returning. Worktree path, metadata merge,
   linked-work-item, and branch-name logic were promoted to `packages/product-core/shared`, so the canonical Web
   project no longer includes implementation files from the Electron reference.
4. **Exit gate:** remove the Electron reference area, Electron-only dependencies, scripts, workflow
   jobs, and fixtures once macOS, Windows, and Linux native release evidence replaces every parity
   gate. Negative brand-scan fixtures may retain rejected legacy strings because they prove those
   identifiers cannot return to shipping source; they are not runtime dependencies.

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
