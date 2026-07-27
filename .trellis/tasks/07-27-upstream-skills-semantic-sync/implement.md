# Upstream skills semantic sync implementation

## Implementation checklist

- [x] Inventory the eight current Pebble guides against current upstream stubs/guides and record per-guide semantic adaptations.
- [x] Add canonical `skill-guides/` content and generated discovery stubs for all eight Pebble skills.
- [x] Add the deterministic skill artifact generator, generated manifests, release mapping, snapshot registry, and embedded Go guide source.
- [x] Add generator unit tests and stale-output verification.
- [x] Implement `pebble skills get` in `runtime/go/cmd/pebble-control` with version resolution, text, and JSON behavior.
- [x] Route `skills` through the packaged Tauri CLI and cover routing with Rust tests.
- [x] Regenerate `skills/*/SKILL.md` as localized hybrid stubs and verify existing install commands remain unchanged.
- [x] Add an upstream checkpoint, semantic ownership/risk rules, collector, classifier, JSON/Markdown reporter, and local CLI.
- [x] Add an idempotent GitHub issue publisher with stable markers, batched queries, empty-range behavior, and tests.
- [x] Add scheduled/manual GitHub Actions workflow in report-only/default mode; keep draft PR generation disabled and auto-merge absent.
- [x] Document skill maintenance, guide retrieval, upstream audits, checkpoint advancement, publication, and recovery.

## Validation

- [x] Focused Vitest for bundled skill generation.
- [x] `node config/scripts/generate-bundled-skill-guides.mjs`
- [x] `go test ./cmd/pebble-control` from `runtime/go`
- [x] `cargo test packaged_cli` from `apps/desktop/src-tauri`
- [x] `pnpm run build:cli`
- [x] Focused semantic-sync script tests and a local dry run against the audited upstream range.
- [x] `pnpm run typecheck`
- [ ] `pnpm run lint` (task files pass targeted oxlint; repository-wide run is blocked by pre-existing max-lines violations).
- [x] `pnpm test` (1,871 files / 15,968 tests passed).

## Review gates

- [x] No full guide references retired product branding.
- [x] No guide assumes Electron main/preload/daemon ownership.
- [x] Cross-platform, WSL, SSH, remote runtime, and Git provider constraints are preserved.
- [x] Generated artifacts are byte-for-byte reproducible.
- [x] Issue publication is idempotent and does not create duplicate canonical tracking issues.
- [x] No workflow contains an auto-merge or direct protected-branch mutation path.

## Risk and rollback points

- Commit or review the guide infrastructure before enabling scheduled publication.
- If packaged guide retrieval fails, keep installable skills on standalone full content until CLI packaging passes on all release targets.
- If issue publication cannot prove idempotence, ship report artifacts only and leave publication disabled.
- Draft PR generation remains disabled until a separate reviewed allow-list is populated.
