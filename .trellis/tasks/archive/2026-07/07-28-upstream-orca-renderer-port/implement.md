# Implementation plan — upstream orca renderer/shared port

Conflict counts are dry-run estimates against `HEAD`; they shrink as earlier commits land.

## Batch A — clean / near-clean (conflicts ≤ 2)

- [ ] 02. `560f853a4037` c=0 — fix(editor): save floating workspace markdown files (#10985)
- [ ] 04. `a1ad4714e9e2` c=0 — fix(gitlab): render item descriptions and comments with document markdown variant (#9161)
- [ ] 12. `7f3c95a585c2` c=0 — fix(git-history): stop reading the option marker as the resolved ref name (#10906)
- [ ] 18. `f1d54c123b97` c=0 — fix(file-explorer): commit inline rename on outside click, stop double-click flicker (#10867)
- [ ] 21. `55e98e8182f3` c=0 — fix(native-chat): auto-grow the composer input up to 8 lines (#10848)
- [ ] 22. `dbbeae3512bc` c=0 — fix(terminal): clear retained overlay for editor tabs (#11030)
- [ ] 03. `c140a5111848` c=2 — fix(worktrees): resolve a two-host project by the worktree's own host (#10986)
- [ ] 05. `2bb3276a35d5` c=1 — fix(cmd-j): focus the destination workspace's own terminal after a jump (#10695)
- [ ] 06. `c0734f039dee` c=2 — fix(terminal): disarm stale TUI modes when a pane confirms return to shell (#9608)
- [ ] 07. `ab60045371a5` c=1 — fix(shortcuts): gate Cmd/Ctrl+N folder-workspace jumps on path status (#10748)
- [ ] 08. `a065db154c91` c=2 — fix(sidebar): spin the worktree dot while Claude Code is thinking (#10684)
- [ ] 09. `0ab5f499cb99` c=2 — fix(cmd-j): restore focus when issue match routing declines (#11010)
- [ ] 10. `3716a7bb49dd` c=1 — fix(markdown): render task continuations as text (#11008)
- [ ] 15. `a72068015f75` c=1 — fix(panes): stop a stray touch hijacking a mouse divider drag (#11013)
- [ ] 16. `edc6cc007dd7` c=2 — fix(new-workspace): center agent selection in create dialog (#11020)
- [ ] 17. `b31617452558` c=1 — fix(panes): stop a stray mouse hijacking a touch divider drag (#11021)
- [ ] 20. `872a9c3930b7` c=1 — fix(terminal): make copy work in the HTTP web client (#10534)
- [ ] 26. `3f5098a0f2fb` c=1 — fix(workspaces): hide false repo error for remote servers (#11050)
- [ ] 27. `700cde83e030` c=1 — i18n: translate orchestration page and workflow messages (#11097)

## Batch B — heavy conflicts

- [ ] 01. `b59f893ee28f` c=12 — fix(tab-bar): keep tab menu items on one line, give every item an icon (#10882)
- [ ] 19. `b60164396046` c=4 — fix(sidebar): stop worktree cycling from reopening collapsed groups (#10513)
- [ ] 23. `e4b113b11d94` c=3 — fix(native-chat): keep known sessions loading until flush (#11032)
- [ ] 25. `9de4519c820d` c=6 — fix(terminal): gate the developer menu behind Option, unblock manual parking (#11091)
- [ ] 13. `974447175f66` c=14 — feat(terminal): add manual parking developer action (#11016)
- [ ] 24. `e73b1a1dd096` c=17 — feat(new-workspace): type-ahead Project and Run-on pickers (#11062)
- [ ] 14. `1fd0f731fc0d` c=28 — fix(automations): bind agent terminal output before publishing; SSH folder workspaces on own host (#10818)

Port 13 before 25 (25 builds on manual parking). Port 15 before 17 (same divider file).

## Not applicable

- 11. `1fcbf8e5fe6b` — dashboard-popout: component directory absent in Pebble.

## Per-commit procedure

1. Three-way merge every mapped file (see `design.md`).
2. Resolve conflict markers by hand, keeping Pebble's Tauri/Go and remote-runtime contracts.
3. Review each hunk against the five-point lens in `design.md`.
4. `rg -n '^<<<<<<<|^>>>>>>>' packages/product-core` must be empty.

## Validation

```bash
pnpm typecheck
pnpm exec vitest run <ported test files>
pnpm lint
rg -n 'ipcRenderer|window\.electron' packages/product-core/renderer/src packages/product-core/shared
```

## Review gates

- After Batch A: full typecheck + targeted tests before committing.
- After Batch B: full typecheck + targeted tests + lint before committing.
- Before each commit: `git status --short` review so only ported paths are staged.

## Commit shape

- `fix(renderer): port upstream renderer fixes through <upstream short sha>` (Batch A)
- `feat(renderer): port upstream terminal parking and workspace picker work` (Batch B)
- `chore(upstream-sync): advance observed upstream checkpoint`

## Rollback points

Each batch commit is independent and touches only ported paths; revert a batch commit to
undo it without disturbing the unrelated in-progress remote-runtime changes.
