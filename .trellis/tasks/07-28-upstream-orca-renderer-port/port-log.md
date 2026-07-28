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

## Batch C — the two feature-scale commits, split by what Pebble can carry

### `e73b1a1dd096` — new-workspace type-ahead pickers

**Project picker: ported.** Pebble's `ProjectCombobox.tsx` was within 37 lines of the
upstream pre-image, and the new implementation is self-contained (type-ahead hook, styles,
matching, recency, row components). Taken wholesale along with its 297-line test.
`onAddProject` is optional upstream, so Pebble simply does not pass it and the pinned
"Add a new project" row is skipped — Pebble's composer owns that affordance elsewhere.

**Run-target picker: not ported.** Upstream extracted its run-target block into
`RunTargetCombobox` / `RunTargetField` / `RunTargetSubmenus` / `run-target-options`, built
around a host-connect model Pebble does not have: upstream passes
`readonly ProjectHostSetupOption[]` (ready + needs-setup, with connect buttons, connect
timeouts and an add-host submenu), while Pebble's composer passes
`readyProjectHostSetupOptions` and keeps a simpler inline `WorkspaceRunTargetCombobox`.
`run-target-options.ts` also carries the upstream `OrcaHooks` type. Those five modules and
the composer's 572-line extraction were left out, and the composer's clean-merged hunks
that assumed the new picker were reverted.

i18n: only the `ProjectCombobox` keys were taken. Upstream shipped them untranslated in
es/ja/ko/zh; they were translated here to match each locale's existing project wording.

### `1fd0f731fc0d` — automations

This commit fixes three defects. Pebble has all three, but only two are portable.

**Ported — folder-workspace resolution.** `launchAgentBackgroundSession` resolved the
target through `store.allWorktrees()`, which reads only `worktreesByRepo`, so every folder
workspace read as absent and its automation died at resolution. Now uses
`store.getKnownWorktreeById`, which is folder-aware.

**Ported — SSH folder-workspace launch routing.** A folder workspace's synthetic
`folder-workspace:<groupId>` repoId has no repo row, so `repos.find(...)` returned null and
platform, remote-ness, trust marking and the SSH connection id all degraded to a local
default — the agent ran on the client while the files lived on the SSH host. Added
`agent-background-session-launch-host.ts` (upstream's resolver, whose dependencies all
exist in Pebble) and routed the launcher through it. Upstream's own test file did not
cover the SSH-folder case, so a regression test for it was added here.

**Not ported — bind the PTY before publishing the run tab.** Pebble has this defect
(`createTab` at the top, `updateTabPtyId` only after the awaited spawn, leaving a window
where the store holds a tab with `ptyId: null`). Upstream's fix needs
`reserveAgentBackgroundSessionIdentity` / `adoptAgentBackgroundSessionTab`, which require
`store.createTab` to accept `{ id, initialPtyId }` — Pebble's accepts only
`{ index, activate, recordInteraction }` — plus `isTerminalTabPresent`,
`bindAutomationTerminal` and `retire-unowned-background-terminal`, none of which Pebble
has. That is a change to the tabs slice and a new ownership layer, not a merge; it needs
its own task.
