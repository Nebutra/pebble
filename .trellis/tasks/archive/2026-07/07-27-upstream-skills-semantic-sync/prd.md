# Maintain upstream skills and semantic sync

## Goal

Keep Pebble's eight bundled agent skills semantically current with the retired upstream project while preserving Pebble's Go/Tauri architecture, branding, cross-platform behavior, SSH workflows, and provider-neutral product contracts. Establish a repeatable upstream semantic-sync process so future upstream releases become reviewable Pebble maintenance work instead of an ad hoc migration.

## Background

- Pebble diverged from the retired upstream at `v1.4.124-rc.8` (`dacb84bbb5e2f17ce8a7dc02017663a7e395570e`) and migrated at Pebble commit `6d40781742d9153caddee05e7466430f11e6258f` on 2026-07-08.
- The audited upstream repository is configured from neutral owner/repository fields; its latest stable is `v1.4.158`, latest prerelease is `v1.4.159-rc.0`, and audited main head is `58ef46d2522da100f1b49cac25413f0b42290b46`.
- GitHub issue #38 tracks the overall semantic port, release issues track each post-fork release, and issue #39 tracks skill drift.
- Pebble owns eight skills: `computer-use`, `linear-tickets`, `orchestration`, `pebble-cli`, `pebble-emulator`, `pebble-emulator-android`, `pebble-linear`, and `pebble-per-workspace-env`.
- Current upstream uses hybrid skills: installable discovery stubs route to version-matched full guides returned by the installed CLI. Pebble currently ships only standalone `skills/*/SKILL.md` files.
- Pebble's packaged CLI is routed through the Go `pebble-control` binary; the Tauri executable forwards supported commands to it.

## Requirements

### R1: Current Pebble skill semantics

- Port all post-fork upstream skill guidance that remains applicable to Pebble.
- Translate retired-upstream names, commands, environment variables, URLs, and architectural assumptions to Pebble contracts.
- Explicitly adapt Electron daemon/preload guidance to Pebble's Go runtime and Tauri host instead of performing textual replacement.
- Preserve macOS, Linux, Windows, WSL, local, SSH, and remote-runtime behavior.
- Preserve Claude, Codex, Cursor, OpenCode, Pi, Grok, Droid, Copilot, and other supported agent workflows where upstream guidance applies.
- Keep Linear and review guidance compatible with GitLab and other supported providers rather than introducing GitHub-only product concepts.

### R2: Localized hybrid skill infrastructure

- Add Pebble-owned discovery stubs, full guides, generated manifests, release mappings, and snapshot metadata.
- Add `pebble skills get <skill-name>` to the packaged Go CLI and development CLI path.
- Resolve a guide that matches the installed Pebble application version, with a documented deterministic fallback when an exact mapping is unavailable.
- Keep installation through `npx skills add https://github.com/nebutra/pebble --skill <names> --global` working.
- Ensure release bundles contain every resource needed by `pebble skills get` without network access.
- Generate checked-in resources reproducibly and fail verification when generated output is stale.

### R3: Upstream semantic-sync pipeline

- Add scheduled and manually dispatchable automation that fetches upstream releases and main-branch changes from the last audited state.
- Persist the last audited upstream commit and tag in a reviewable state file.
- Classify changes by Pebble ownership boundary, including renderer/shared, Electron main/preload, daemon/runtime/relay, mobile, build/release, and skills.
- Produce structured JSON and readable Markdown reports containing upstream commits/PRs, changed paths, semantic-port risk, and suggested Pebble verification.
- Create or update GitHub issues idempotently and batch API work to respect rate limits.
- Permit draft PR creation only for deterministic candidate changes that pass configured checks; never merge automatically or directly mutate protected/production branches.
- Treat Electron main/preload/daemon changes as semantic Go/Tauri ports requiring human review.
- Make the analyzer locally runnable without GitHub credentials; issue and draft-PR publication must be a separate optional step.

### R4: Operability and documentation

- Document how maintainers regenerate skill assets, retrieve a guide, run a semantic audit, inspect reports, and advance the upstream checkpoint.
- Record provenance so every Pebble guide revision and sync report identifies the upstream ref used as evidence.
- Keep secrets out of generated artifacts and logs.

## Acceptance Criteria

- [ ] `pebble skills get` returns each of the eight localized full guides from both development and packaged CLI layouts.
- [ ] Installed `skills/*/SKILL.md` files are lightweight Pebble stubs that route agents to the matching guide and retain useful fallback instructions.
- [ ] Generated manifests and snapshots cover all eight skills and are reproducible on macOS, Linux, and Windows.
- [ ] The current full guides incorporate applicable upstream skill changes through audited upstream main `58ef46d2522da100f1b49cac25413f0b42290b46` without reintroducing retired product identity or Electron-only assumptions.
- [ ] Skill retrieval works offline and exact-version, prerelease, and unmapped-version behavior is covered by tests.
- [ ] A local semantic-sync run from the fork baseline produces deterministic JSON and Markdown reports and a proposed next checkpoint.
- [ ] Re-running publication for the same upstream range updates canonical issues rather than creating duplicates.
- [ ] Automation never auto-merges, and unsafe architecture-specific changes cannot enter the draft-PR path.
- [ ] Focused unit tests, generation checks, CLI build checks, and repository quality gates pass.
- [ ] Maintainer documentation explains initial bootstrap and recurring operation.

## Out of Scope

- Automatically porting all 1,326 post-fork upstream commits in this task.
- Automatically merging upstream changes or bypassing normal review and release gates.
- Replacing Pebble's Go/Tauri architecture with the upstream Electron daemon architecture.
- Building a provider-hosted backend service for semantic synchronization; GitHub Actions and repository artifacts are sufficient for this phase.
