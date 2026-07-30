# Fix duplicate repository setup-script validation

## Goal

Prevent the same repository path from becoming multiple runtime projects and
repair existing duplicate state without losing worktrees or user configuration,
so repository-scoped features such as `pebble.yaml` validation remain reliable.

## Background

- Dogfood state contained two local projects for
  `/Users/tseka_luk/workspace/code/forks/pebble`.
- The restored `activeRepoId` referenced the newer duplicate while the restored
  `activeWorktreeId` belonged to the older project.
- Both runtime project IDs could read `pebble.yaml`; the file and setup command
  were valid. The failure came from inconsistent project identity/state.
- Pebble targets local, SSH, macOS, Linux, and Windows paths. Deduplication must
  not merge equal-looking paths owned by different hosts.

## Requirements

- R1. Creating or importing a project must be idempotent for an existing
  normalized project identity: location kind, host ID, and path.
- R2. Runtime startup must reconcile legacy duplicate projects. Preserve one
  deterministic canonical project and migrate owned worktrees, project host
  setups, group membership, sparse presets, and other direct project references.
- R3. Reconciliation must not merge local and SSH projects or projects on
  different SSH hosts.
- R4. Duplicate worktrees for the same path must collapse deterministically
  without deleting the canonical worktree's session/tab state.
- R5. Renderer repository refresh must correct a restored active repo when the
  active worktree belongs to another currently available repo.
- R6. Existing repositories with distinct normalized identities must remain
  unchanged.
- R7. Setup-script validation must resolve against the reconciled repository and
  stop showing a retry-only error for valid `pebble.yaml` state.

## Acceptance Criteria

- [ ] Re-importing the same local path returns the existing project and does not
      create another main worktree.
- [ ] Reloading a persisted state with duplicate same-path projects leaves one
      project and one canonical same-path worktree with migrated references.
- [ ] Same paths on separate SSH hosts remain separate projects.
- [ ] Fetching repositories repairs an `activeRepoId` that conflicts with the
      owner of `activeWorktreeId`.
- [ ] Existing Go runtime and focused renderer tests pass.
- [ ] `git diff --check` passes and unrelated worktree changes remain untouched.

## Out Of Scope

- Automatically deleting repository directories or Git worktrees.
- Combining projects from different runtime environments or SSH hosts.
- Redesigning the setup-script prompt UI.
