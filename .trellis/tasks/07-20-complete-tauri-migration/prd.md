# Complete Tauri migration and remove legacy shell

## Goal

Remove Electron parity dependencies and obsolete Orca-related repository directories after migrating remaining E2E and computer-use ownership to Tauri/Rust/Go.

## Background

Pebble's shipping desktop, installers, updater, release publication, 74 preload
namespaces, and 243 renderer runtime methods are Tauri-owned. The remaining
legacy shell is `migration/electron-reference/` (about 20 MB and 1,511 source
files), referenced by 103 files outside that directory. Those references are
test, CI, benchmark, parity, workspace, or historical contracts rather than
shipping runtime imports.

Repository-wide identity auditing found no project directory named Orca and no
runtime invocation of an `orca` CLI. Exact Orca strings are negative brand
regression fixtures and must remain. The environment-provided Orca CLI is an
external developer tool, not Pebble product code.

## Requirements

- Replace Electron-only Playwright ownership with browser Playwright for
  renderer contracts and release-excluded embedded Tauri automation or Rust
  functional gates for native lifecycle evidence.
- Migrate all application E2E, terminal golden/performance, SSH, pixel evidence,
  and release gates from `electron-headless`/`electron-headful` to Tauri-owned
  projects or approved immutable Tauri baselines.
- Remove Electron builds and Electron-reference unit tests from computer-use CI;
  preserve equivalent Rust, Go, CLI, and native-provider assertions.
- Move directly imported contracts such as `PROTOCOL_VERSION` and agent-hook
  integration ownership to canonical non-Electron packages or native services.
- Migrate startup, idle CPU, daemon cold-start, and terminal-scale benchmarks to
  Tauri executables and native startup milestones.
- Remove Electron-only Linux GPU sandbox and telemetry/app.asar verification or
  replace them with platform-relevant Tauri checks.
- Remove every executable/config/workspace dependency on
  `migration/electron-reference/`, then delete that directory and generated
  Electron output.
- Remove Electron-only dependencies and scripts, regenerate the lockfile, and
  invert repository verification so the legacy directory and dependencies
  cannot return.
- Preserve legitimate third-party dependencies until replaced on evidence:
  `@nebutra/playwright-test` currently resolves from `@stablyai/playwright-test`
  and is not an Orca product identity.
- Preserve negative Orca brand fixtures and historical evidence that actively
  prevents regression; remove stale user-facing, executable, or path ownership.
- Preserve macOS, Linux, Windows, SSH, and remote-host behavior.
- Complete the Tauri-owned macOS Developer ID signing and notarization path,
  including nested executable resources, hardened-runtime entitlements, and
  stapled-ticket verification before release publication.
- Complete Tauri updater signing configuration without committing or rotating
  private key material. Release CI must fail before packaging when the updater
  public key, private key, or private-key password is missing or placeholder.

## Acceptance Criteria

- [ ] `migration/electron-reference/` and Electron-generated `out/main` /
  `out/preload` artifacts are absent.
- [ ] No workspace member, package script, CI workflow, TypeScript/Vitest config,
  benchmark, test import, or skill recipe references the deleted directory.
- [ ] No direct dependency on `electron`, `electron-vite`, `electron-builder`,
  `electron-updater`, `@electron/rebuild`, or `@electron-toolkit/*` remains.
- [ ] Renderer Playwright and Tauri functional/visible E2E run with deterministic
  profile isolation and teardown on every supported host.
- [ ] Release-blocking terminal golden and runtime-surface evidence no longer
  build or launch Electron.
- [ ] Computer-use CI validates Rust/Go/CLI/native ownership without an Electron build.
- [ ] Startup, daemon, idle CPU, terminal performance, SSH, and pixel gates use
  Tauri/native executables or approved Tauri-owned evidence.
- [ ] Repository gates reject reintroduction of the legacy directory, Electron
  dependencies, Electron project names, and parity scripts.
- [ ] Exact Orca references are limited to negative regression fixtures or
  clearly historical non-shipping records; no project path is Orca-owned.
- [ ] Full lint, typecheck, unit/integration tests, Tauri E2E matrices, computer
  E2E, release contract tests, and repository verifiers pass.
- [ ] macOS release builds carry the repository-owned entitlements, include the
  signed computer-use helper, use Developer ID signing, notarize the app and
  DMG, and reject missing or unstapled notarization evidence.
- [ ] Tauri updater artifacts are generated and cryptographically verified
  against the configured public key; signing secrets remain Actions-only and
  are validated before the build starts.

## Out Of Scope

- Removing the external Orca desktop-control CLI from the developer machine.
- Removing `@stablyai/playwright-test` without a published, verified replacement.
- Deleting historical benchmark measurements solely because they once contained
  local Orca paths; sanitized Pebble-owned fixtures remain useful evidence.
- Breaking persisted crash/telemetry schema fields solely because their names
  describe historical Electron versions.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
