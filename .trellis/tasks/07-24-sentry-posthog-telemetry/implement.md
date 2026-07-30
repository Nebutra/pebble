# Implementation plan

## 1. Runtime configuration and Sentry adapter

- [x] Add the official Rust Sentry dependency without the automatic panic hook.
- [x] Add a focused Sentry reporting module with release/distribution metadata,
      consent state, release-health lifecycle, startup transaction, event
      normalization, renderer stack parsing, attachment support, and tests.
- [x] Initialize the Sentry client before Tauri setup and keep its guard alive
      until the event loop exits.

## 2. Consent and crash sources

- [x] Expose an internal effective-consent query from the telemetry owner.
- [x] Synchronize Sentry sessions when opt-in, opt-out, or banner acknowledge
      changes the persisted state.
- [x] Forward Rust panic, native process, WebView, and React boundary records only
      after local persistence succeeds.
- [x] Finish startup performance at the Ready event and close sessions at exit.

## 3. Manual crash submission

- [x] Replace the crash-only feedback POST with a scoped Sentry event and optional
      redacted NDJSON attachment.
- [x] Preserve anonymity, duplicate prevention, local status transitions, bounded
      timeout/flush, and deterministic errors.
- [x] Keep ordinary feedback and independent diagnostic upload/delete unchanged.

## 4. Release artifacts and CI

- [x] Add repository-local Sentry CLI tooling and scripts for renderer source-map
      upload/removal and native debug-file upload.
- [x] Enable hidden production source maps and split line-table release symbols.
- [x] Wire Sentry runtime, org, project, and auth configuration into the release
      workflow without exposing secret values.
- [x] Extend workflow/release script tests to pin fail-closed behavior and matching
      release/distribution identifiers.

## 5. Operations and documentation

- [x] Update Roadmap/reference documentation with the vendor split, remaining
      Pebble server responsibilities, credentials, quotas, and rollout checks.
- [ ] Create/configure PostHog and Sentry projects when console authentication is
      available; add project configuration to GitHub Secrets/Variables.
- [ ] Verify a first RC event flow before stable promotion.

## Validation

- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features`
- `pnpm --filter @pebble/desktop typecheck`
- `pnpm --filter @pebble/desktop exec vitest run`
- `pnpm exec vitest run config/scripts/tauri-release-workflow.test.mjs`
- Focused tests for new Sentry release helpers
- `pnpm verify:tauri-mainline`
- `git diff --check`

## Risk and rollback points

- SDK panic integration must remain disabled; otherwise hook order and duplicate
  reports can regress native recovery.
- Source maps must be deleted before Tauri bundles `dist`; otherwise release
  artifacts expose source.
- Debug-symbol upload must scan only the explicit matrix target directory.
- Manual crash reports must not transition to sent before bounded SDK flush.
- If release CI blocks unexpectedly, remove only the Sentry build configuration;
  local crash reporting and PostHog are independent rollback boundaries.
