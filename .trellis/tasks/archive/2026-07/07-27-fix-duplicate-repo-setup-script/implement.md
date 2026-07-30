# Implementation Plan

1. Add a runtime project identity comparator using existing path normalization.
2. Make `CreateProject` and main-worktree creation idempotent.
3. Reconcile duplicate projects and worktrees during `NewManager` hydration,
   migrating direct project references before the manager begins serving.
4. Add Go tests for repeat import, persisted duplicate migration, distinct SSH
   hosts, and clean-state reload.
5. Add renderer reconciliation for active repo/worktree ownership and focused
   store tests.
6. Run focused Go tests, focused Vitest, Go formatting/vet where applicable,
   TypeScript typecheck for touched renderer code, and `git diff --check`.

## Risk Points

- Do not delete filesystem paths while merging records.
- Do not merge remote projects solely by path.
- Preserve sessions and tab layouts attached to the canonical worktree.
- Do not include unrelated pairing, Windows runtime, or Trellis bootstrap edits
  in any eventual commit.
