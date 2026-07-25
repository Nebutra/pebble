# Release Signing

## Scenario: macOS Notarization And Tauri Updater Signing

### 1. Scope / Trigger

- Trigger: changing Tauri bundle configuration, macOS nested resources,
  release credentials, updater manifests, or release artifact verification.
- The release trust chain spans `tauri.conf.json`, `tauri.macos.conf.json`, the
  reusable GitHub workflow, platform bundle preparation, and artifact evidence.

### 2. Signatures

- Pre-bundle hook: `node scripts/prepare-macos-bundle-resources.mjs`.
- API-key preparation: `node config/scripts/prepare-apple-api-key.mjs`.
- Release preparation: `node config/scripts/prepare-tauri-release-config.mjs`.
- Preflight: `node config/scripts/verify-tauri-release-preflight.mjs <platform>`.
- Artifact inspection: `node config/scripts/verify-tauri-release-artifacts.mjs
--platform <platform> --target-triple <triple> --output <path>`.

### 3. Contracts

- Updater environment, required on release runners:
  `TAURI_UPDATER_PUBLIC_KEY`, `TAURI_SIGNING_PRIVATE_KEY`, and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- macOS environment: `MAC_CERTS` maps to `APPLE_CERTIFICATE`,
  `MAC_CERTS_PASSWORD` maps to `APPLE_CERTIFICATE_PASSWORD`, and
  `APPLE_TEAM_ID` plus `PEBBLE_MAC_RELEASE=1` are required. Notarization uses
  exactly one complete mode: preferred `APPLE_API_KEY`, `APPLE_API_ISSUER`, and
  runner-temporary `APPLE_API_KEY_PATH`, or fallback `APPLE_ID` and
  `APPLE_APP_SPECIFIC_PASSWORD` (as `APPLE_PASSWORD`).
- GitHub stores `.p8` contents only in `APPLE_API_KEY_P8`. The macOS preparation
  step creates a unique directory below absolute `RUNNER_TEMP`, writes the key
  with exclusive creation and mode `0600`, and exports only its absolute path
  through absolute `GITHUB_ENV`.
- `bundle.createUpdaterArtifacts` must be `true` in the prepared release config.
- The main app uses `resources/build/entitlements.mac.plist`; the nested
  computer-use helper uses `resources/build/entitlements.computer-use.mac.plist`.
- `tauri.macos.conf.json` adds the helper app as a macOS-only resource. Tauri's
  RFC 7396 merge preserves the base resource map.
- Release runners prepare host Go sidecars before native Cargo tests. The macOS
  leg also builds the computer-use helper with ad-hoc identity `-` before Cargo
  evaluates Tauri resource paths; `beforeBundleCommand` later rebuilds it with
  the release identity before the outer app is sealed.
- Updater public-key rotation is not routine maintenance: installed clients pin
  the key, so rotation requires an explicit compatibility and rollout plan.

### 4. Validation & Error Matrix

- Missing or placeholder updater value -> fail before packaging and name only
  the invalid environment keys; never print their values.
- Prepared config public key differs from the environment -> fail preflight.
- Missing, partial, or mixed Apple notarization mode, or
  `PEBBLE_MAC_RELEASE != 1` -> fail the macOS leg without printing values.
- Non-UUID `APPLE_API_ISSUER`, relative/newline-containing runner paths, or an
  unsafe `APPLE_API_KEY_PATH` -> fail without echoing the rejected value.
- `APPLE_API_KEY_P8` on a non-macOS runner -> fail before writing any file.
- Missing macOS pre-bundle hook, helper resource, hardened runtime, or main
  entitlements path -> fail preflight.
- Missing ad-hoc helper before macOS Cargo tests -> fail before native tests;
  using the ad-hoc helper as the final bundled resource -> fail signing inspection.
- Ad-hoc signature, wrong Team ID, missing entitlement, invalid updater
  signature, or unstapled app/DMG -> fail artifact inspection.

### 5. Good/Base/Bad Cases

- Good: the helper is signed before Tauri seals the outer app; the app and DMG
  carry stapled tickets; updater payload signatures verify against the pinned key.
- Good: native tests see host sidecars and an ad-hoc macOS helper, while the
  production bundle hook replaces the helper with its release-signed build.
- Base: Linux and Windows merge only the base config and never invoke Swift or
  Apple signing tools.
- Bad: copying the helper after bundling invalidates the outer resource seal;
  rotating the updater key without migration strands installed clients.
- Bad: relying on `beforeBundleCommand` alone leaves Cargo's earlier resource
  validation without the macOS helper on a clean runner.
- Bad: writing the `.p8` to a predictable path permits symlink replacement;
  placing its contents in `GITHUB_ENV` persists secret material across steps.

### 6. Tests Required

- `prepare-tauri-release-config.test.mjs`: assert all updater signing values are
  present, non-placeholder, and never persisted into Tauri config.
- `prepare-macos-bundle-resources.test.mjs`: assert speech libraries and the
  helper are prepared in order on macOS and skipped elsewhere.
- `prepare-apple-api-key.test.mjs`: assert unique runner-temp containment,
  exclusive `0600` creation, exact multiline P8 preservation, path-only
  `GITHUB_ENV` export, missing variables, path injection, and non-macOS refusal.
- `verify-tauri-release-preflight.test.mjs`: assert environment, config, helper,
  entitlements, updater, complete/exclusive notarization modes, issuer UUID,
  safe key path, and platform gates.
- `verify-tauri-macos-signing.test.mjs` and artifact tests: assert Developer ID
  metadata, required entitlements, strict nested signatures, updater signatures,
  and stapled app/DMG tickets.
- `tauri-release-workflow.test.mjs`: assert platform-gated credential wiring and
  `PEBBLE_MAC_RELEASE=1`, runner-temporary API-key materialization, and ordering
  of host sidecars -> ad-hoc macOS helper -> Cargo tests -> release bundle build.
- Run `verify:tauri-mainline`, relevant lint/typecheck, and `git diff --check`.

### 7. Wrong vs Correct

#### Wrong

```yaml
env:
  APPLE_CERTIFICATE: ${{ secrets.MAC_CERTS }}
```

This exposes Apple-only inputs to every matrix leg and does not place the nested
helper into the bundle before sealing.

#### Correct

```yaml
env:
  APPLE_CERTIFICATE: ${{ matrix.platform == 'macos' && secrets.MAC_CERTS || '' }}
  PEBBLE_MAC_RELEASE: ${{ matrix.platform == 'macos' && '1' || '' }}
```

The macOS platform override owns its pre-bundle helper resource, while shared
updater signing inputs remain available to every updater-producing release leg.

## Scenario: Sentry Release Artifacts

### 1. Scope / Trigger

- Trigger: changing stable/RC observability credentials, Vite source maps,
  Cargo release debug information, or the desktop release matrix.

### 2. Signatures

- Observability preflight:
  `node config/scripts/verify-observability-release-config.mjs`.
- Renderer postbuild:
  `node apps/desktop/scripts/upload-sentry-renderer-artifacts.mjs`.
- Native upload:
  `node config/scripts/upload-sentry-native-debug-files.mjs`.
- Release identity: `pebble@<version>`.
- Distribution identity: `<stable-or-rc>-<target-triple>`.

### 3. Contracts

- Runtime secrets: `PEBBLE_POSTHOG_WRITE_KEY` and `PEBBLE_SENTRY_DSN`.
- CI-only Sentry management inputs: `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and
  `SENTRY_PROJECT`; they must never be compiled into the application.
- `PEBBLE_SENTRY_DIST` must exactly match the release channel and matrix target.
- Configured stable/RC renderer builds emit hidden maps, upload minified files
  and maps, then delete every `.map` before Tauri bundles `dist`.
- Cargo release builds retain split line-table debug information. Native upload
  scans only `apps/desktop/src-tauri/target/<matrix release directory>`.
- Sentry release-health sessions use release and environment; the Sentry session
  protocol has no distribution field. Error events, startup transactions, and
  uploaded artifacts carry the target-specific distribution.

### 4. Validation & Error Matrix

- Either vendor runtime key missing -> fail stable/RC preflight.
- DSN configured but auth/org/project/dist incomplete -> fail and print only
  missing variable names.
- Distribution differs from `<channel>-<target-triple>` -> fail before build.
- Native release directory is absolute, escapes Cargo target, or is missing ->
  fail before invoking Sentry CLI.
- Sentry CLI failure -> redact auth token, DSN, and PostHog key from output.
- Source-map upload failure -> fail postbuild before packaging; do not ship maps.

### 5. Good/Base/Bad Cases

- Good: renderer and native artifacts use one release and matrix-specific dist.
- Base: development or unconfigured builds emit no maps and perform no upload.
- Bad: uploading debug files from the whole repository or leaving `.map` files
  in the packaged renderer directory.

### 6. Tests Required

- `sentry-release-config.test.mjs`: no-op builds, exact release/dist, incomplete
  credentials, DSN validation, directory containment, and output redaction.
- `tauri-release-workflow.test.mjs`: preflight/build/native upload share the same
  DSN, project, release channel, target triple, and distribution expression.
- Run an unconfigured renderer production build and assert postbuild succeeds
  without Sentry network configuration.
- Run `verify:tauri-mainline`, Rust tests, formatter, and `git diff --check`.

### 7. Wrong vs Correct

#### Wrong

```yaml
TAURI_RELEASE_TARGET_RELEASE_DIR: ../../
```

#### Correct

```yaml
TAURI_RELEASE_TARGET_RELEASE_DIR: universal-apple-darwin/release
```

The explicit contained directory keeps each matrix leg from uploading unrelated
build products or repository contents.

## Scenario: Cross-Platform Release Runtime Validation

### 1. Scope / Trigger

- Trigger: changing Go runtime sessions, release-test subprocesses, Windows
  process signaling, worktree hooks, or shutdown persistence.

### 2. Signatures

- Runtime shutdown: `func (m *Manager) Shutdown()`.
- Exit barrier: `func (s *processSession) waitForExitHandling(context.Context) bool`.
- Hook configuration: `configureWorktreeHookProcess(*exec.Cmd)`.
- Windows resolver: `windowsSystemExecutable(name string) string`.

### 3. Contracts

- `exitHandled` closes only after process cleanup and synchronous exit-event
  persistence finish.
- `Shutdown()` signals every session, then waits under one five-second budget;
  a stuck OS wait must not hang application exit forever.
- Unix hook cancellation kills the process group. Windows tree termination
  resolves `taskkill.exe` from `SystemRoot/System32`, then `PATH`, and falls
  back to `Process.Kill()` if the tree command fails. Every runtime `taskkill`
  call site uses the resolver.
- Cross-platform tests use native absolute paths, set `HOME` and `USERPROFILE`
  when isolating home state, and normalize only CRLF when output is otherwise exact.

### 4. Validation & Error Matrix

- Exit callback completes -> shutdown observes persisted stats before returning.
- Exit callback exceeds the shared deadline -> shutdown returns without hanging.
- Windows `PATH` omits System32 -> resolve through `SystemRoot`.
- `taskkill.exe` fails -> kill the direct process as the bounded fallback.
- Output differs beyond CRLF vs LF -> fail the exact assertion.

### 5. Good/Base/Bad Cases

- Good: cancellation terminates descendants holding inherited output pipes,
  then bounded shutdown joins exit persistence.
- Base: an already-exited session closes its barrier immediately.
- Bad: killing only the shell leaves descendants holding pipes; waiting on an
  unbounded channel can hang Pebble shutdown and the release job.

### 6. Tests Required

- `go test ./...` and `go vet ./...` on the host platform.
- `GOOS=windows GOARCH=amd64 go test -exec=/usr/bin/true ./...` compiles every
  Windows-only file and test package.
- Exit-barrier tests cover completed and cancelled contexts.
- Shared-control wait tests use `terminal.stopExact` so shell line discipline
  cannot obscure the long-poll concurrency contract.

### 7. Wrong vs Correct

#### Wrong

```go
exec.Command("taskkill", "/pid", pid, "/t", "/f")
<-session.exitHandled
```

#### Correct

```go
exec.Command(windowsSystemExecutable("taskkill.exe"), "/pid", pid, "/t", "/f")
session.waitForExitHandling(shutdownContext)
```
