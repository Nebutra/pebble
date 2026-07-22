export const browserRendererSpecs = [
  'floating-mobile-emulator-tab.spec.ts',
  'notification-settings.spec.ts',
  'pr-comments-sidebar-cards.spec.ts',
  'source-control-create-pr.spec.ts',
  'tab-close-navigation.spec.ts',
  'tabs.spec.ts'
]

export const browserSystemSpecs = ['tasks-page.spec.ts']

export const browserInteractionSpecs = []

export const browserVisualSpecs = []

export const retiredLegacySpecReplacements = {
  'agent-session-live-force-exit-resume.spec.ts': [
    {
      path: 'runtime/go/internal/runtimecore/session_hook_state_test.go',
      contract: 'TestSessionWaitExitResolvesOnProcessExit'
    },
    {
      path: 'runtime/go/internal/runtimecore/session_driver_lock_test.go',
      contract: 'TestReclaimSessionForDesktopReleasesLock'
    }
  ],
  'agent-session-quit-resume.spec.ts': [
    {
      path: 'runtime/go/internal/runtimecore/session_hook_state_test.go',
      contract: 'TestSessionHookStateTransitionsGateWait'
    }
  ],
  'app-menu-paste-ownership.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/lib/app-menu-paste.test.ts',
      contract: 'lets an owned terminal paste event claim the menu action synchronously'
    }
  ],
  'droid-notification.spec.ts': [
    {
      path: 'apps/desktop/src-tauri/src/commands/notifications.rs',
      contract: 'pub fn show_native_notification('
    },
    {
      path: 'packages/product-core/renderer/src/components/terminal-pane/use-notification-dispatch.test.ts',
      contract: "describe('dispatchTerminalNotification'"
    }
  ],
  'daemon-live-session-preservation.spec.ts': [
    {
      path: 'runtime/go/internal/runtimecore/session_tab_layout_test.go',
      contract: 'TestSessionTabLayoutPersistsAcrossStoreReload'
    },
    {
      path: 'runtime/go/internal/runtimecore/session_tabs_snapshot_test.go',
      contract: 'TestSessionTabsSnapshotUsesPersistedLayoutAndLiveSessionPlacement'
    }
  ],
  'daemon-slow-health-check-preservation.spec.ts': [
    {
      path: 'runtime/go/internal/runtimecore/session_semantics_test.go',
      contract: 'TestSessionStatusListPollStaysCheap'
    }
  ],
  'daemon-slow-init-pty-gate.spec.ts': [
    {
      path: 'runtime/go/internal/runtimecore/manager_test.go',
      contract: 'TestSessionRunsCommand'
    },
    {
      path: 'runtime/go/internal/runtimecore/session_hook_state_test.go',
      contract: 'TestSessionHookStateTransitionsGateWait'
    }
  ],
  'editable-context-paste-ownership.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/lib/text-control-paste-ownership.test.ts',
      contract: 'resolves only focused editable text controls as owned paste targets'
    }
  ],
  'feature-wall.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/feature-wall/FeatureTourPreview.test.tsx',
      contract: "describe('FeatureTourPreview first-run copy'"
    }
  ],
  'folder-setup-shallow-priority.spec.ts': [
    {
      path: 'runtime/go/internal/runtimecore/nested_repo_scan_cancel_test.go',
      contract: 'TestScanNestedReposContextCancelProducesStoppedResult'
    },
    {
      path: 'runtime/go/cmd/pebble-relay-worker/nested_repo_scan_test.go',
      contract: 'TestRunScanNestedPostsScanResult'
    }
  ],
  'folder-setup.spec.ts': [
    {
      path: 'runtime/go/internal/runtimecore/manager_test.go',
      contract: 'TestNestedRepoScanAndImport'
    },
    {
      path: 'runtime/go/internal/runtimecore/nested_repo_scan_cancel_test.go',
      contract: 'TestImportNestedReposContextCancelImportsNothing'
    }
  ],
  'golden-core-flows.spec.ts': [
    {
      path: 'config/scripts/run-tauri-real-runtime-gate.mjs',
      contract: 'result.terminalMounted'
    },
    {
      path: 'apps/desktop/src-tauri/src/commands/functional_gate.rs',
      contract: 'pub fn functional_gate_write_evidence('
    }
  ],
  'helpers/agent-hook-endpoint.ts': [
    {
      path: 'runtime/go/internal/runtimehttp/agent_hook_routes_test.go',
      contract: 'TestAgentHookIngestRouteUpdatesSessionHookState'
    }
  ],
  'helpers/pebble-restart.ts': [
    {
      path: 'config/scripts/run-tauri-real-runtime-gate.mjs',
      contract: 'waitForCleanExit(shell, 10_000)'
    },
    {
      path: 'apps/desktop/src-tauri/src/commands/functional_gate.rs',
      contract: 'pub fn functional_gate_restore_and_focus('
    }
  ],
  'helpers/terminal-pty-write-spy.ts': [
    {
      path: 'apps/desktop/src-tauri/src/commands/runtime_pty_input.rs',
      contract: 'pub async fn write_runtime_pty_input('
    },
    {
      path: 'packages/product-core/renderer/src/components/terminal-pane/terminal-pty-paste-writer.test.ts',
      contract: "describe('terminal PTY paste writer'"
    }
  ],
  'helpers/tauri-test-application.ts': [
    {
      path: 'apps/desktop/src-tauri/src/commands/functional_gate.rs',
      contract: 'pub fn functional_gate_restore_and_focus('
    },
    {
      path: 'config/scripts/run-tauri-real-runtime-gate.mjs',
      contract: 'functional Tauri shell did not complete its clean shutdown'
    }
  ],
  'mobile-banner.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/lib/pane-manager/mobile-fit-overrides.test.ts',
      contract: "describe('scenario: mobile disconnect restores all terminals'"
    }
  ],
  'runtime-surface-parity-reference.spec.ts': [
    {
      path: 'config/scripts/run-tauri-real-runtime-gate.mjs',
      contract: 'Tauri ${nativeDragOnly'
    },
    {
      path: 'config/scripts/tauri-real-runtime-screenshot-evidence.test.mjs',
      contract: 'validateTauriRuntimeScreenshots'
    }
  ],
  'resource-usage-warm-reattach.spec.ts': [
    {
      path: 'runtime/go/internal/runtimecore/session_driver_lock_test.go',
      contract: 'TestSessionDriverTransitionsEmitEvents'
    },
    {
      path: 'runtime/go/internal/runtimecore/session_semantics_test.go',
      contract: 'TestSessionStatusListPollStaysCheap'
    }
  ],
  'settings-agent-awake.spec.ts': [
    {
      path: 'apps/desktop/src-tauri/src/commands/agent_awake.rs',
      contract: 'fresh_current_runtime_work_activates_until_the_two_hour_boundary'
    },
    {
      path: 'packages/product-core/renderer/src/components/settings/AgentsPane.test.tsx',
      contract: 'toggles the keep-awake setting with the next value'
    }
  ],
  'settings-skill-detection.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/hooks/useInstalledAgentSkills.react.test.tsx',
      contract: 'ignores stale discovery results after the discovery target changes'
    },
    {
      path: 'runtime/go/internal/runtimecore/skills_test.go',
      contract: 'TestSkillScannerFindsMetadataAndAvoidsSymlinkLoops'
    }
  ],
  'setup-guide-sidebar.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/setup-guide/use-setup-guide-progress.test.ts',
      contract: "describe('getSetupGuideProgressReady'"
    },
    {
      path: 'packages/product-core/renderer/src/components/settings/settings-setup-guide-progress-hook.test.tsx',
      contract: 'uses the same setup progress path as the main sidebar'
    }
  ],
  'tauri-settings-parity-reference.spec.ts': [
    {
      path: 'config/scripts/run-tauri-pixel-performance-gate.mjs',
      contract: 'tests/e2e/baselines/desktop'
    },
    {
      path: 'config/scripts/tauri-approved-pixel-baselines.test.mjs',
      contract: 'approved desktop pixel baselines'
    }
  ],
  'tab-rename-paste-ownership.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/tab-bar/SortableTab.rename-shortcut.test.tsx',
      contract: "describe('SortableTab rename shortcut signal'"
    },
    {
      path: 'packages/product-core/renderer/src/lib/app-menu-paste.test.ts',
      contract: 'pastes large clipboard text into a focused text control without leaking event data'
    }
  ],
  'terminal-codex-skill-preview-artifact-repro.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/terminal-pane/terminal-webgl-atlas-recovery.test.ts',
      contract: "describe('terminal WebGL atlas recovery'"
    },
    {
      path: 'config/scripts/run-tauri-real-runtime-gate.mjs',
      contract: "['terminal', 'browser', 'source-control', 'checks']"
    }
  ],
  'terminal-document-visibility-webgl-recovery.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/terminal-pane/terminal-visibility-resume.test.ts',
      contract: 'schedules the repaint on window-wake recovery'
    },
    {
      path: 'apps/desktop/src-tauri/src/commands/functional_gate.rs',
      contract: 'pub fn functional_gate_minimize('
    }
  ],
  'terminal-large-paste-responsiveness.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/terminal-pane/terminal-paste-coordinator.test.ts',
      contract: 'streams large paste through bounded PTY chunks and yields between chunks'
    }
  ],
  'terminal-osc-color-queries.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/terminal-pane/terminal-capability-replies.test.ts',
      contract: 'answers OSC foreground and background color queries from the active theme'
    }
  ],
  'terminal-paste-ownership.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/terminal-pane/terminal-paste-coordinator.test.ts',
      contract: 'cancels before writing when the target changed during async clipboard read'
    }
  ],
  'terminal-restart-persistence.spec.ts': [
    {
      path: 'runtime/go/internal/runtimecore/session_tab_layout_test.go',
      contract: 'TestSessionTabLayoutPersistsAcrossStoreReload'
    },
    {
      path: 'runtime/go/internal/runtimecore/session_tabs_snapshot_test.go',
      contract: 'TestSessionTabsSnapshotUsesPersistedLayoutAndLiveSessionPlacement'
    }
  ],
  'terminal-shortcuts.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/lib/terminal-shortcut-capture-notification.test.tsx',
      contract: "describe('showTerminalShortcutCaptureNotification'"
    },
    {
      path: 'packages/product-core/renderer/src/components/terminal-pane/terminal-pty-paste-writer.test.ts',
      contract: 'prefers acknowledged PTY writes when available'
    }
  ],
  'terminal-split-pane-paste-ownership.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/terminal-pane/terminal-paste-coordinator.test.ts',
      contract: 'cancels before writing when the target changed during async clipboard read'
    },
    {
      path: 'runtime/go/internal/runtimecore/session_tab_pane_split_test.go',
      contract: 'TestReplaceSessionPaneLeafPreservesNestedSibling'
    }
  ],
  'terminal-tui-wheel-reports.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/terminal-pane/pty-input-write-queue.test.ts',
      contract: 'coalesces a dense burst of wheel reports instead of one write per macrotask turn'
    }
  ],
  'terminal-windows-shell-paste-ownership.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/terminal-pane/terminal-bracketed-paste.test.ts',
      contract: 'keeps bracketed paste behavior for multi-line paste after Ctrl+C'
    },
    {
      path: 'packages/product-core/renderer/src/components/terminal-pane/terminal-paste-coordinator.test.ts',
      contract: 'forces small Windows multiline paste through bracketed terminal input'
    }
  ],
  'worktree.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/runtime/worktree-create-base.test.ts',
      contract: "describe('resolveWorktreeCreateBaseBranch'"
    },
    {
      path: 'packages/product-core/renderer/src/store/slices/worktrees.test.ts',
      contract: 'passes linked work item and creation agent metadata through the create IPC payload'
    }
  ]
}

const tauriTerminalEvidence = [
  {
    path: 'config/scripts/run-tauri-real-runtime-gate.mjs',
    contract: '!result.terminalMounted'
  },
  {
    path: 'runtime/go/internal/runtimecore/manager_test.go',
    contract: 'TestSessionRunsCommand'
  }
]

const tauriChildWebviewEvidence = [
  {
    path: 'apps/desktop/src-tauri/src/commands/browser_child_webview.rs',
    contract: 'pub fn browser_child_webview_create('
  },
  {
    path: 'config/scripts/run-tauri-real-runtime-gate.mjs',
    contract: '!result.browserLoaded'
  }
]

const nativeFilesystemGitEvidence = [
  {
    path: 'runtime/go/internal/runtimecore/manager_test.go',
    contract: 'TestFileServiceReadsWritesAndBlocksEscapes'
  },
  {
    path: 'runtime/go/internal/runtimecore/source_control_projection_test.go',
    contract: 'TestSourceProjectionFromGitStatusReadsRepository'
  },
  {
    path: 'config/scripts/run-tauri-real-runtime-gate.mjs',
    contract: '!result.sourceControlProjected'
  }
]

const nativeSshEvidence = [
  {
    path: 'config/scripts/run-ssh-native-gate.mjs',
    contract: "'SSH|Ssh|Relay|Remote|PortForward'"
  },
  {
    path: 'runtime/go/internal/runtimecore/session_workspace_ssh_smoke_test.go',
    contract: 'TestStartSessionRunsSshProjectThroughSystemSshPty'
  }
]

const nativeWindowsRuntimeEvidence = [
  {
    path: 'runtime/go/internal/runtimecore/manager_test.go',
    contract: 'TestProjectWindowsRuntimePreferencePersists'
  },
  ...tauriTerminalEvidence
]

const nativeTerminalSpecs = [
  'activity-agent-pane-isolation.spec.ts',
  'artificial-opencode-terminal-load.spec.ts',
  'automation-hidden-terminal-first-mount.spec.ts',
  'chinese-ime-chat-input-repro.spec.ts',
  'dead-terminal-repro.spec.ts',
  'dead-terminal-stress.spec.ts',
  'floating-workspace-reopen-webgl-recovery.spec.ts',
  'floating-workspace-shared-glyph-atlas.spec.ts',
  'terminal-attention.spec.ts',
  'terminal-codex-cursor-jitter-repro.spec.ts',
  'terminal-codex-hidden-startup-background.spec.ts',
  'terminal-codex-home.spec.ts',
  'terminal-codex-local-typing-latency.spec.ts',
  'terminal-column-desync-repro.spec.ts',
  'terminal-cursor-inactive-style.spec.ts',
  'terminal-foreground-redraw-freeze.spec.ts',
  'terminal-hidden-tui-visual-restore.spec.ts',
  'terminal-history-size-typing-latency.spec.ts',
  'terminal-image-paste-webgl-recovery.spec.ts',
  'terminal-long-table-scroll-restore.spec.ts',
  'terminal-opencode-emoji-table-rendering.spec.ts',
  'terminal-output-scheduler.spec.ts',
  'terminal-panes.spec.ts',
  'terminal-pinned-viewport-worktree-switch.spec.ts',
  'terminal-raw-emoji-table-scroll-restore.spec.ts',
  'terminal-tab-switch-sigwinch-restore.spec.ts',
  'terminal-tab-switch-visual-restore.spec.ts',
  'terminal-tui-wheel-drain.spec.ts',
  'terminal-typing-latency.spec.ts'
]

const nativeFilesystemGitSpecs = [
  'add-project-default-checkout.spec.ts',
  'combined-diff-scroll-restore.spec.ts',
  'diff-note-delete.spec.ts',
  'diff-note-edit.spec.ts',
  'file-open.spec.ts',
  'git-no-upstream-polling-churn.spec.ts',
  'github-cli-stall-repro.spec.ts',
  'large-diff-freeze-repro.spec.ts',
  'project-group-manual-sort.spec.ts',
  'setup-script-import.spec.ts',
  'source-control-commit-draft-persistence.spec.ts',
  'source-control-commit-message-ai.spec.ts',
  'source-control-discard-confirmation.spec.ts',
  'source-control-pr-generation-switch.spec.ts',
  'workspace-space-git-status.spec.ts',
  'worktree-lifecycle.spec.ts',
  'worktree-recent-sort.spec.ts'
]

const nativeSshSpecs = [
  'ssh-ai-vault-session-history.spec.ts',
  'ssh-codex-display-artifacts-repro.spec.ts',
  'ssh-docker-relay-perf.spec.ts',
  'ssh-localhost.spec.ts',
  'ssh-pi-compatible-agent-title.spec.ts'
]

const nativeWindowsRuntimeSpecs = [
  'windows-project-runtime-smoke.spec.ts',
  'windows-terminal-env-icons.spec.ts'
]

const nativeOwnershipEntries = [
  ['browser-tab.spec.ts', tauriChildWebviewEvidence],
  ...nativeTerminalSpecs.map((spec) => [spec, tauriTerminalEvidence]),
  ...nativeFilesystemGitSpecs.map((spec) => [spec, nativeFilesystemGitEvidence]),
  ...nativeSshSpecs.map((spec) => [spec, nativeSshEvidence]),
  ...nativeWindowsRuntimeSpecs.map((spec) => [spec, nativeWindowsRuntimeEvidence])
]

export const nativeSpecEvidence = Object.fromEntries(nativeOwnershipEntries)

export const rendererSpecEvidence = {
  'onboarding.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/onboarding/OnboardingFlow.test.tsx',
      contract: 'renders onboarding inside a centered modal shell'
    },
    {
      path: 'packages/product-core/renderer/src/components/onboarding/use-onboarding-flow-persistence.test.ts',
      contract: 'preserves explicit focus notification suppression when completing onboarding'
    }
  ],
  'right-sidebar-windows-titlebar.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/right-sidebar/right-sidebar-titlebar-drag-regions.render.test.tsx',
      contract:
        'keeps the rendered top activity strip draggable, context-menuable, and only controls no-drag'
    }
  ],
  'settings-display-name-ime.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/settings/RepositoryPaneDraftInput.test.tsx',
      contract: 'keeps draft text while the store still holds the previous value (IME regression)'
    },
    {
      path: 'packages/product-core/renderer/src/components/settings/RepositoryPaneDraftInput.test.tsx',
      contract: 'persists once with the confirmed value on compositionend'
    }
  ],
  'tab-rename.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/tab-bar/SortableTab.rename-shortcut.test.tsx',
      contract: 'opens the inline rename input and consumes the matching store signal'
    },
    {
      path: 'packages/product-core/renderer/src/components/tab-bar/SortableTab.rename-shortcut.test.tsx',
      contract: 'ignores IME composition Enter before committing the custom tab title'
    }
  ],
  'tab-sidebar-closed-overlap.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/worktree-creation/WorktreeCreationPanel.test.tsx',
      contract: 'reserves collapsed left-titlebar space before the faux tab'
    }
  ],
  'usage-overview.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/stats/usage-overview-model.test.ts',
      contract: 'combines provider totals without double-counting cached input'
    },
    {
      path: 'packages/product-core/renderer/src/components/stats/usage-overview-model.test.ts',
      contract: 'reports disabled providers as an empty overview'
    }
  ],
  'workspace-back-forward-navigation.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/store/slices/worktree-nav-history.test.ts',
      contract: 'moves the index without mutating the history array on success'
    },
    {
      path: 'packages/product-core/renderer/src/store/slices/worktree-nav-history-view-entries.test.ts',
      contract: 'replays task detail entries through the same back/forward stack'
    }
  ],
  'worktree-lineage.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/sidebar/WorktreeList.lineage-child-real-card.test.tsx',
      contract: 'keeps expanded child cards in the parent title column'
    },
    {
      path: 'packages/product-core/renderer/src/store/slices/worktrees.test.ts',
      contract: 'fetches persisted lineage into the renderer store'
    }
  ],
  'settings-search-responsiveness.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/store/slices/settings-search-state.test.ts',
      contract: 'updates the search input immediately and debounces the applied filter'
    },
    {
      path: 'packages/product-core/renderer/src/components/settings/settings-search.test.ts',
      contract: 'rejects oversized pasted searches before reading settings entries'
    }
  ],
  'markdown-ordered-list-exit.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/editor/rich-markdown-list-continuation.test.ts',
      contract: 'exits a loaded trailing empty ordered-list item into a body paragraph'
    },
    {
      path: 'packages/product-core/renderer/src/components/editor/rich-markdown-key-handler.test.ts',
      contract: 'exits loaded trailing empty ordered-list items on Enter'
    }
  ],
  'markdown-prose-reflow.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/editor/rich-markdown-empty-paragraph-delete.test.ts',
      contract: 'Backspace in an inserted empty paragraph preserves soft-wrapped prose'
    },
    {
      path: 'packages/product-core/renderer/src/components/editor/rich-markdown-normalize.test.ts',
      contract: 'leaves hard-wrapped document prose as one paragraph'
    }
  ],
  'worktree-scroll-to-current.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/sidebar/worktree-scroll-to-current-button.test.ts',
      contract: 'scrolls upward to reveal a mounted current workspace card above the viewport'
    },
    {
      path: 'packages/product-core/renderer/src/components/sidebar/worktree-scroll-to-current-button.test.ts',
      contract: 'does not scroll when the current workspace card is already fully visible'
    }
  ],
  'worktree-smart-sort.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/components/sidebar/smart-sort.test.ts',
      contract: 'ranks blocked above done regardless of which stateStartedAt is newer'
    },
    {
      path: 'packages/product-core/renderer/src/components/sidebar/smart-sort.test.ts',
      contract: 'uses the smart comparator once a PTY is alive'
    }
  ],
  'worktree-switch-responsiveness.spec.ts': [
    {
      path: 'packages/product-core/renderer/src/store/slices/worktrees.test.ts',
      contract: 'moves focus out of a registered webview before switching worktrees'
    },
    {
      path: 'packages/product-core/renderer/src/store/slices/store-cascades.test.ts',
      contract: 'keeps the current right sidebar tab when switching worktrees'
    }
  ]
}

// Why: ordinary Chrome can exercise the typed renderer boundary, but these
// markers require native process, filesystem, PTY, SSH, or child-WebView evidence.
export const nativeBrowserForbiddenPatterns = [
  {
    label: 'native API namespace',
    pattern: /window\.api\.(?:fs|git|pty|ssh|repos|worktrees|wsl|runtime|browser)\b/
  },
  {
    label: 'native E2E helper',
    pattern: /helpers\/(?:terminal|docker-ssh|file-explorer|worktree-registration)/
  },
  { label: 'SSH runtime helper', pattern: /ssh-codex-/ },
  { label: 'child WebView execution', pattern: /<webview|executeJavaScript/ },
  { label: 'host process or filesystem fixture', pattern: /node:(?:child_process|fs)/ }
]

// These projects all use the typed browser bridge. Native Tauri evidence is
// explicitly owned by nativeSpecEvidence instead of browser mocks.
export const browserPlaywrightProjects = {
  'browser-renderer': browserRendererSpecs,
  'browser-system': browserSystemSpecs,
  'browser-interaction': browserInteractionSpecs,
  'browser-visual': browserVisualSpecs
}

export const allOwnedSpecs = [
  ...Object.values(browserPlaywrightProjects).flat(),
  ...Object.keys(rendererSpecEvidence),
  ...Object.keys(nativeSpecEvidence)
]
