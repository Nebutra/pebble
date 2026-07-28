# Port log — upstream range `58ef46d…`..`77d4c64f`

Upstream: `github.com/stablyai/orca`. 101 commits total; 27 touch only `src/renderer/` +
`src/shared/` and were evaluated here. The other 74 are desktop-host / runtime / relay /
mobile / build-release and stay out of scope per `docs/upstream-semantic-sync.md`.

## Ported

| upstream | change |
| --- | --- |
| `a1ad4714e9e2` | gitlab: render item descriptions/comments with the document markdown variant |
| `2bb3276a35d5` | cmd-j: focus the destination workspace's own terminal after a jump; module renamed to `workspace-activation-terminal-focus` |
| `ab60045371a5` | shortcuts: gate Cmd/Ctrl+N folder-workspace jumps on path status via exported `activateAndRevealWorkspace` |
| `0ab5f499cb99` | cmd-j: restore focus when issue match routing declines |
| `3716a7bb49dd` | markdown: render task continuations as text (`RichMarkdownTaskList`) |
| `7f3c95a585c2` | git-history: stop reading the option marker as the resolved ref name |
| `edc6cc007dd7` | new-workspace: center agent selection in the create dialog |
| `f1d54c123b97` | file-explorer: commit inline rename on outside click; stop double-click rename flicker |
| `872a9c3930b7` | terminal: make copy work in the HTTP web client, with a real failure toast |
| `55e98e8182f3` | native-chat: auto-grow the composer input up to 8 lines |
| `dbbeae3512bc` | terminal: clear retained overlay for editor tabs |
| `3f5098a0f2fb` | workspaces: hide the false repo error for remote servers (host gate ported into Pebble's inline effect) |
| `700cde83e030` | i18n: orchestration page and workflow messages |

### Pebble adaptations applied while porting

- `worktree-creation-flow.ts` — kept Pebble's `stillActive` guard, adopted the renamed focus helper.
- `worktree-activation.ts` — kept Pebble's richer registration comment on `setWorktreeNavActivator`.
- `use-terminal-pane-context-menu.ts` — kept `PEBBLE_PANE_KEY` in the comment instead of the upstream name.
- `AgentCombobox` — adopted `AgentIconLabel` centering without upstream's `emptyLabel` prop, which Pebble does not expose.
- `WorktreeJumpPalette` — dropped the `focusFallbackSurface(previousFocusElementRef.current)` hunk; Pebble's fallback takes no argument and has no such ref.
- `native-chat-composer-autogrow.test.tsx` — rebuilt the props against Pebble's `NativeChatComposerFieldProps`.
- `file-explorer-inline-rename-flow.test.tsx` — added a `useAppStore.getState` mock; Pebble resolves the rename target's owning host through the store.
- `palette-activation-focus-routing.test.ts` — removed the scoped-fallback case Pebble cannot satisfy.
- i18n — new orchestration strings use Pebble naming; zh uses Pebble's established «平行宇宙» term.

## Not applicable

| upstream | reason |
| --- | --- |
| `560f853a4037` | editor: Pebble has no `editor-file-operation-owner` module; saves route by the file's own `runtimeEnvironmentId`, so the floating-workspace failure mode does not exist. |
| `c140a5111848` | worktrees: Pebble already resolves by the worktree's own `hostId` (`settingsForExecutionHostOwner`), and `settingsForWorktreeOwner` degrades instead of throwing, so neither half applies. |
| `c0734f039dee` | terminal: Pebble has no confirmed-shell-foreground subsystem (`confirmForegroundProcess` / `onConfirmedShellForeground`), so the fix has no hook point. |
| `a065db154c91` | sidebar: Pebble has no `titleStatusIsAgentAttributable` gate and no `terminal-tab-activity-status` module; the dot already spins for any spinner title. |
| `a72068015f75`, `b31617452558` | panes: Pebble matches drag pointers strictly by `pointerId` and never adopted the loose primary-pointer fallback these two commits tighten. |
| `1fcbf8e5fe6b` | dashboard: the `dashboard-popout` component directory does not exist in Pebble. |

Upstream modules deliberately **not** imported, because they would graft an upstream
subsystem Pebble replaced: `worktree-operation-route.ts`, `editor-file-operation-owner.ts`,
`terminal-tab-activity-status.ts`, `useEphemeralVmRecipeOptions.ts` (carries the upstream
`OrcaVmRecipe` type), `git-binary-compatibility.test.ts`, `pane-divider-stray-touch.test.ts`.

## Batch B

### Ported

| upstream | change |
| --- | --- |
| `b60164396046` | sidebar: stop worktree cycling from reopening collapsed groups |
| `b59f893ee28f` | tab-bar: keep tab menu items on one line and give every item an icon |

Adaptations:

- `worktree-keyboard-cycle.ts` was written against Pebble's row model. Upstream's version
  takes a `pinnedDisplayPolicy` and calls `getPreferredWorktreeRows` from
  `worktree-sidebar-row-preference.ts`; Pebble has neither, so the helper dedupes the
  rendered rows directly. `repoOrder` became unused on the viewport and was dropped, as
  upstream did.
- Tab menus: Pebble has no "Close Others"/"Close Tabs To The Left" on the browser tab and
  routes splits through `TabWorkspaceLayoutMenuSection`, not upstream's
  `TerminalTabSplitMenuSection`, so those hunks and that module were dropped. Icons were
  added to Pebble's own icon-less items using upstream's icon choices for the same
  actions, in Pebble's `mr-1.5 size-3.5` convention. The consistency guard was widened to
  accept that convention and Pebble's older `w-3.5 h-3.5` ordering.

### Not applicable

| upstream | reason |
| --- | --- |
| `e4b113b11d94` | native-chat: Pebble's loading guard is already unconditional (`if (loading)`), so known sessions already stay loading; upstream's `liveStatusOverride` takes five arguments to Pebble's two. |
| `974447175f66`, `9de4519c820d` | terminal manual parking: Pebble's `Terminal.tsx` carries no `parkedTerminalWorktreeIds` / `terminalParkingRevision` state, so the developer action and its Option gate have nothing to hang off. Porting would mean rebuilding the parking subsystem — new feature work, not fork maintenance. |

### Not attempted

| upstream | size |
| --- | --- |
| `e73b1a1dd096` | new-workspace type-ahead pickers: 11 new modules, 21 conflicts, rewrites `NewWorkspaceComposerCard` and `ProjectCombobox`. |
| `1fd0f731fc0d` | automations / agent background sessions: 31 conflicts across `launch-agent-background-session` and SSH folder-workspace host routing. |

Both are feature-scale ports into subsystems Pebble reworked; they need their own task.
