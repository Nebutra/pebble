# Complete Tauri Migration Implementation Plan

## Phase 1: Decouple Easy Consumers

- [x] Move the legacy daemon fixture version behind an explicitly named E2E
  owner and remove direct imports from Electron main source.
- [x] Replace the Electron-owned agent-hook integration import with Go runtime
  HTTP/session-state coverage and canonical relay replay tests.
- [x] Replace renderer tests that read Electron preload source with Tauri coverage.
- [x] Remove unnecessary Electron builds from computer-use jobs.
- [ ] Map every Electron computer/RPC test assertion to existing Rust/Go/CLI tests;
  add missing native assertions, then remove the old test list and path filters.
- [x] Update `computer-e2e-workflow.test.mjs` to enforce native ownership.

## Phase 2: Establish Native And Renderer Test Transports

- [x] Reject a Playwright `ElectronApplication` compatibility shim: it cannot
  drive macOS WKWebView and would create false cross-platform coverage.
- [ ] Add a release-excluded WebdriverIO embedded Tauri transport for native
  lifecycle tests, initially single-worker with deterministic profile cleanup.
- [ ] Prove launch, DOM/store readiness, backend execution, graceful quit, force
  kill/relaunch, and process-tree cleanup on macOS, Linux, and Windows.
- [ ] Add a browser Playwright harness with a typed mock preload for renderer-only
  behavior; classify specs by native API usage rather than fixture shape.
- [ ] Keep Rust functional gates for native evidence that does not require DOM
  automation, reusing their isolated data and native input evidence.

## Phase 2B: Close Computer-Use Native Contract Gaps

- [ ] Add helper socket transport/lifecycle tests, including reconnect, timeout,
  child teardown, token cleanup, and malformed/stale response handling.
- [ ] Add injectable permission-command tests for status, targeted open, reset,
  timeout, cleanup, missing helper/app, and non-macOS behavior.
- [ ] Add desktop bridge/script tests for typed failures, output limits, timeout,
  capability/cache/target normalization, and action metadata.
- [x] Restore typed error parity for `invalid_argument`, `window_not_focused`,
  and `screenshot_failed` where the native mapper previously lost them.
- [x] Add a canonical UTF-8 paste byte ceiling before native dispatch.
- [x] Add provider queue serialization tests; completion failure now invalidates
  registration and stop interrupts the active batch.

## Phase 3: Migrate Application E2E

- [ ] Add `tauri-functional` and `tauri-visible` native projects; do not claim
  universal headless support for hidden/throttled WebViews.
- [ ] Migrate renderer-only specs to browser Playwright, starting with the
  comments sidebar card layout contract.
- [ ] Migrate Electron-main-coupled specs to WDIO embedded Tauri or Rust gates;
  remove ElectronApplication types and helpers.
- [ ] Migrate restart, crash, native dialog, notification, power, PTY, and hook
  helpers without weakening assertions.
- [ ] Change global setup and CI artifacts from Electron output to Tauri test output.

## Phase 4: Migrate Evidence And Benchmarks

- [ ] Move terminal golden, release evidence, terminal perf, scale perf, and SSH
  scripts/workflows to the Tauri projects.
- [ ] Replace runtime-surface and settings Electron capture with approved Tauri
  baselines and Tauri-only refresh commands.
- [ ] Port startup, idle CPU, and daemon cold-start benchmarks to Tauri/native
  executables and native milestone logs.
- [x] Retire the Electron/Chromium-only Linux Wayland GPU sandbox gate and forbid
  its workflow/scripts from returning.
- [x] Retire the zero-caller app.asar telemetry verifier after confirming Tauri
  native/renderer telemetry contracts own the behavior.
- [ ] Update per-workspace environment recipes to build/run Tauri.

## Phase 5: Delete The Legacy Shell

- [ ] Remove `parity:electron:*`, Electron runtime installation/rebuild scripts,
  workspace membership, lint/typecheck/Vitest includes, and PR install steps.
- [x] Replace all `@electron-toolkit/tsconfig` inheritance with repository-owned
  TypeScript configurations and remove Electron source from Vitest/lint ownership.
- [x] Remove Electron-only dependencies and regenerate `pnpm-lock.yaml`.
- [ ] Delete Electron-specific helpers/specs and `migration/electron-reference/`.
- [x] Remove ignored/generated Electron output.
- [ ] Invert layout/mainline/brand gates to forbid legacy paths, dependencies,
  project names, and scripts.
- [x] Remove the retired product identifier from executable code, comments,
  fixtures, task history, documentation, and repository paths.
- [x] Uninstall the retired desktop application and remove its CLI, processes,
  user data, preferences, workspace aliases, hooks, plugins, and agent skills.

## Phase 6: Complete Release Signing

- [x] Wire the main macOS entitlements file into the Tauri bundle configuration.
- [x] Prepare and stage the macOS computer-use helper before Tauri bundling so
  the release action includes its signed nested app in the notarized bundle.
- [x] Require the updater private key password alongside the private/public key
  contract before release packaging, without persisting secret material.
- [x] Keep Apple notarization credentials mapped to the official Tauri
  environment variables and fail fast when any required value is absent.
- [x] Extend release workflow and artifact contract tests for nested signing,
  entitlements, updater artifacts, and stapled app/DMG notarization.
- [x] Document the exact repository/organization secret names and the rule that
  updater key rotation requires an explicit migration plan.
- [x] Materialize `APPLE_API_KEY_P8` into a macOS runner temporary file and map
  `APPLE_API_KEY`, `APPLE_API_ISSUER`, and `APPLE_API_KEY_PATH` to Tauri.
- [x] Validate a complete API-key notarization set or a complete Apple ID
  fallback set, rejecting partial/mixed credentials without printing values.
- [x] Extend workflow, preflight, documentation, and mainline tests for both
  notarization credential modes.

## Phase 7: Move To The Pebble Product Subdomain

- [x] Change runtime feeds, feedback, diagnostics, privacy, docs, download,
  release-note, renderer/shared, mobile, Homebrew, and public README links to
  `https://pebble.nebutra.com` without the former `/pebble` prefix.
- [x] Update updater URL canonicalization, release workflow contracts, focused
  tests, and mainline assertions while keeping GitHub release URLs unchanged.
- [x] Document DNS/TLS readiness and redirect-versus-reverse-proxy compatibility
  requirements without performing remote provider configuration.

## Validation Gates

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] Browser Playwright renderer suites and Tauri functional/visible suites on
  supported hosts
- [ ] `pnpm test:e2e:computer` platform matrix
- [ ] Tauri terminal golden/performance and SSH suites
- [ ] Tauri production build and release contract tests
- [x] macOS entitlements, release preflight, release workflow, artifact
  inspection, and updater manifest contract tests
- [x] App Store Connect API-key materialization and notarization-mode tests
- [x] Real App Store Connect API credentials authenticated with `notarytool`
- [x] `pnpm verify:tauri-mainline` and repository layout verification
- [ ] Repository-wide executable-reference scan returns no Electron legacy owner
- [x] Repository-wide identity and path scan returns no retired product residue
- [x] `git diff --check`
