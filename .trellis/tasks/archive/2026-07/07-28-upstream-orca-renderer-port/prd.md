# Port upstream orca renderer/shared commits

## Goal

Bring Pebble's shared renderer code current with the retired upstream project's
`renderer` + `shared` changes accumulated since the last audited checkpoint, without
reintroducing Electron-era assumptions or upstream product identity.

## Background

- Upstream: `github.com/stablyai/orca`, tracked via `config/upstream-sync/state.json`.
- Last audited upstream commit: `58ef46d2522da100f1b49cac25413f0b42290b46` (2026-07-27).
- New upstream head at analysis time: `77d4c64f7a05e7fb2caa48e3d0acad5db39ff1f2`.
- Range contains 101 commits / 1446 changed paths.
  - 62 high-risk (`src/main/`, `src/preload/`, `src/relay/`, `src/runtime/`) — these
    require manual Go/Tauri semantic ports per `docs/upstream-semantic-sync.md` and are
    explicitly **out of scope** here.
  - 27 commits touch only `src/renderer/` and `src/shared/`, which map directly onto
    Pebble's `packages/product-core/renderer/` and `packages/product-core/shared/`.
- Literal `git cherry-pick` is impossible (no shared history); porting is done by
  per-file three-way merge using the upstream pre-image as the merge base.

## Requirements

### R1: Port scope

- Port the 27 pure renderer/shared commits, in upstream chronological order.
- Skip `1fcbf8e5fe6b` (dashboard-popout): the `dashboard-popout` component directory does
  not exist in Pebble, so the fix has no target surface.
- Do not port `src/main/`, `src/preload/`, `src/relay/`, `src/runtime/`, `mobile/`, or
  build-release changes in this task.

### R2: Pebble contract preservation

- Keep Pebble branding, naming, and CLI/product identity; do not reintroduce upstream
  product names into user-visible strings or module identifiers.
- Preserve Pebble's Go runtime / Tauri host contracts — do not add Electron-only APIs
  (`ipcRenderer`, `window.electron`, Electron-specific preload shapes).
- Preserve macOS / Linux / Windows behavior; keep platform checks rather than hardcoding
  `metaKey`.
- Preserve SSH and remote-runtime behavior; do not assume local-only execution.
- Keep source-control features provider-neutral (GitLab and others, not GitHub-only).

### R3: Working tree isolation

- The tree carries unrelated in-progress remote-runtime work (77 paths). Only files
  actually touched by this port may be staged and committed.
- i18n locale JSON files are modified by both the in-progress work and this port; only
  upstream-introduced keys may be added, leaving local edits intact.

### R4: Checkpoint bookkeeping

- Advance `config/upstream-sync/state.json` `lastObserved` to the newly analyzed head.
- Do **not** advance `lastAudited` past the ported range, since the high-risk desktop-host
  and runtime commits in it remain unported.

## Acceptance Criteria

- [ ] All 26 in-scope commits are ported or explicitly recorded as not-applicable with a reason.
- [ ] No conflict markers (`<<<<<<<`, `>>>>>>>`) remain in the tree.
- [ ] Typecheck passes for the renderer/shared packages.
- [ ] Tests covering ported files pass.
- [ ] Lint passes on changed files; no `max-lines` disable is introduced.
- [ ] No Electron-only API or upstream product identity is introduced by the port.
- [ ] Commits contain only files touched by this port.
- [ ] `config/upstream-sync/state.json` `lastObserved` reflects the analyzed head and
      `lastAudited` is unchanged.
