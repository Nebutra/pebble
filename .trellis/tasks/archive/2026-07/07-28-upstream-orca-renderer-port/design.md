# Design — upstream orca renderer/shared port

## Why not `git cherry-pick`

Pebble and upstream share no git history (Pebble was re-rooted at the Tauri migration),
so `git cherry-pick <sha>` cannot resolve. `git apply` of a path-rewritten patch also
fails for 25 of 27 commits because Pebble's copies of these files have diverged.

## Porting mechanism

Per changed file in an upstream commit, run an explicit three-way merge:

| merge slot | content |
| --- | --- |
| base ("upstream-base") | `git show <sha>^:<upstream path>` |
| theirs ("upstream-new") | `git show <sha>:<upstream path>` |
| ours ("pebble") | current file at the mapped Pebble path |

`git merge-file -L pebble -L upstream-base -L upstream-new ours base theirs` produces the
merged result, leaving standard conflict markers where Pebble diverged. This gives real
three-way semantics without importing upstream objects into Pebble's repository.

Tooling lives in the session scratchpad (`port.py`); it is analysis scaffolding, not a
repository deliverable.

## Path mapping

| upstream | pebble |
| --- | --- |
| `src/renderer/…` | `packages/product-core/renderer/…` |
| `src/shared/…` | `packages/product-core/shared/…` |

Anything outside those two prefixes is out of scope for this task.

## File-status handling

- **Added upstream, absent in Pebble** → write upstream content verbatim, then review for
  Electron-only APIs and upstream identity.
- **Modified, Pebble copy identical to upstream base** → fast-forward to upstream content.
- **Modified, Pebble copy diverged** → three-way merge; resolve markers by hand.
- **Added upstream, already present in Pebble** → treat as a conflict and reconcile manually.
- **Deleted upstream** → delete only if Pebble has no local reason to keep the file.
- **Added into a directory Pebble does not have** → signals the feature is absent from
  Pebble; skip the commit and record the reason.

## Ordering

Commits are ported in upstream chronological order. Several are dependent
(`974447175f66` manual parking → `9de4519c820d` developer-menu gating; the two
`pane-divider-stray-*` fixes; `e73b1a1dd096` type-ahead pickers → later new-workspace
changes). Applying them in order means later commits merge against an already-updated
Pebble tree, which shrinks their conflict surface below the dry-run estimate.

## Review lens for every ported hunk

1. Electron leakage — `ipcRenderer`, `window.electron`, Electron preload shapes. Pebble
   routes through the Tauri host and Go runtime instead.
2. Upstream product identity in strings, keys, module names, URLs.
3. Platform assumptions — hardcoded `metaKey`, POSIX-only path joins.
4. SSH / remote-runtime assumptions — anything presuming local execution.
5. Provider neutrality — GitHub-only naming for generic review concepts.

## Rollback

Each commit batch is a separate git commit touching only ported paths, so `git revert` of
a batch is self-contained. The unrelated in-progress remote-runtime changes are never
staged, so they are unaffected by any revert.

## Checkpoint policy

`lastObserved` advances to `77d4c64f7a05e7fb2caa48e3d0acad5db39ff1f2`. `lastAudited` stays
at `58ef46d…`: the range still contains 62 unported high-risk desktop-host/runtime commits,
and `docs/upstream-semantic-sync.md` only permits advancing the audited checkpoint once a
range has been fully reviewed or implemented.
