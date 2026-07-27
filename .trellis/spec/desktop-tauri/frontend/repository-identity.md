# Repository Identity And Recovery

## Scenario: Runtime Project Identity Reconciliation

### 1. Scope / Trigger

- Trigger: changing project import, runtime state hydration, worktree ownership,
  or restored renderer repository/worktree selection.

### 2. Signatures

- Runtime creation: `Manager.CreateProject(CreateProjectRequest)`.
- Main-worktree creation: `Manager.CreateProjectWithMainWorktree(context.Context, CreateProjectRequest)`.
- Runtime migration: `reconcilePersistedProjectIdentities(*persistedState) bool`.
- Renderer recovery: `reconcileActiveRepoWithWorktree(...)`.

### 3. Contracts

- Runtime project identity is `(locationKind, hostId, normalizedPath)`.
- Local paths use `normalizeLocalPath`; SSH paths remain remote-host paths and
  are always scoped by `hostId`.
- Re-importing an existing identity returns its project without creating a new
  project event or main worktree.
- Startup keeps the oldest project and same-path worktree, then rewrites typed
  persisted project/worktree references before serving requests.
- Migration never removes filesystem directories or Git worktrees.
- When restored `activeRepoId` conflicts with the owner of
  `activeWorktreeId`, the available worktree owner is authoritative.

### 4. Validation & Error Matrix

- Empty or non-absolute path -> `ErrInvalidPath`.
- SSH project without `hostId` -> creation error.
- Same local normalized path -> existing project.
- Same SSH path and same host -> existing project.
- Same SSH path on different hosts -> distinct projects.
- Active worktree owner absent from fetched repositories -> retain only a
  separately valid active repository; otherwise clear it.

### 5. Good/Base/Bad Cases

- Good: importing `/code/pebble` twice yields one project and one main worktree.
- Base: legacy duplicate state is collapsed at startup and saved once.
- Good: `/srv/pebble` on `host-a` and `host-b` remains two projects.
- Bad: renderer deduplicates repositories by path without runtime host context.

### 6. Tests Required

- Go: repeated project/main-worktree creation returns the original IDs.
- Go: persisted duplicate local projects migrate references and preserve the
  canonical worktree layout.
- Go: equal SSH paths on different hosts remain separate.
- Renderer: repository refresh selects the active worktree's available owner.
- Run `go test ./internal/runtimecore/...`, focused renderer Vitest, desktop
  typecheck, `go vet ./...`, and `git diff --check`.

### 7. Wrong vs Correct

#### Wrong

```go
project.ID = newID("proj")
m.projects[project.ID] = project
```

#### Correct

```go
if existing, ok := m.findProjectByIdentityLocked(identity); ok {
    return existing, false, nil
}
```
