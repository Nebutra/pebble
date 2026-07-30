# Design

## Identity

The Go runtime owns project identity. Compare projects after existing path
normalization using `(locationKind, hostId, path)`. Local paths use the runtime's
host normalization; SSH paths remain remote-host strings and are scoped by host
ID. Project names are metadata, not identity.

## Create Path

`CreateProject` checks for an existing identity while holding the manager lock.
When found, it returns that project without emitting a second change or writing
another record. `CreateProjectWithMainWorktree` checks whether the returned
project already has its main-path worktree before creating one.

## Startup Migration

After loading persisted state, group projects by normalized identity. Keep the
oldest project (created timestamp, then ID) as canonical. Rewrite direct project
references from duplicate IDs to the canonical ID. For duplicate same-path
worktrees, keep the oldest worktree and rewrite session/layout references where
the state model exposes them; otherwise migrate unique worktrees to the canonical
project. Remove duplicate project records only after references are rewritten.
Persist once when reconciliation changes state.

## Renderer Recovery

After repository and worktree data are available, derive the owner repo of the
restored active worktree. If that owner exists and differs from `activeRepoId`,
select the owner. This is a recovery invariant, not path-based renderer dedupe;
the runtime remains the identity owner.

## Compatibility

- Never merge across location kind or SSH host ID.
- Preserve canonical IDs to minimize invalidated renderer/session references.
- Do not touch filesystem worktrees.
- Existing clean state is a no-op and does not rewrite the runtime state file.

## Rollback

The change is isolated to project creation/startup reconciliation and renderer
selection repair. Reverting it leaves persisted state readable because the
schema does not change.
