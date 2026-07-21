import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useAppStore } from '@/store'
import {
  measureTauriWindowLifecycle,
  type WindowLifecycleMeasurement
} from './tauri-window-lifecycle-measurement'
import {
  type GateConfig,
  captureGateSurface,
  runtimeTailContains,
  terminalText,
  waitFor,
  writeEvidence,
  writeProgress
} from './tauri-real-runtime-gate-evidence'
import { verifyNativeBrowser } from './tauri-real-runtime-gate-browser'
import {
  verifyNativeChatTranscript,
  verifyProviderBackedChecks
} from './tauri-real-runtime-gate-checks'

export async function runTauriRealRuntimeGate(): Promise<void> {
  const startedAt = performance.now()
  try {
    // Why: Tauri merges the functional window with the hidden base `main`
    // window. Only the visible isolated window may own capture/evidence stages.
    if (getCurrentWindow().label !== 'optimized') {
      return
    }
    const config = await invoke<GateConfig | null>('functional_gate_config')
    if (!config) {
      return
    }
    await writeProgress('renderer-ready')
    const windowLifecycle = await measureWindowLifecycle(config)
    await waitFor(() => useAppStore.getState().workspaceSessionReady)
    await writeProgress('session-ready')
    normalizeParityRendererState()
    if (
      String(import.meta.env.VITE_TAURI_REAL_RUNTIME_NATIVE_INPUT_ONLY) === 'true' ||
      String(import.meta.env.VITE_TAURI_REAL_RUNTIME_NATIVE_DRAG_ONLY) === 'true'
    ) {
      if (!config.browserUrl) {
        throw new Error('native input gate browser URL is unavailable')
      }
      // Why: trusted child-WebView input is independent of repository/runtime
      // import; coupling them hid native-input failures behind runtime startup.
      const browserEvidence = await verifyNativeBrowser(
        'functional-native-input-worktree',
        config.browserUrl
      )
      await writeEvidence({
        status: 'passed',
        durationMs: Math.round(performance.now() - startedAt),
        windowLifecycle,
        ...browserEvidence
      })
      return
    }
    const repo = await useAppStore.getState().addRepoPath(config.repoPath)
    if (!repo) {
      throw new Error('real repository import failed')
    }
    await writeProgress('repository-imported')
    await useAppStore.getState().fetchWorktrees(repo.id, { requireAuthoritative: true })
    const worktree = useAppStore.getState().worktreesByRepo[repo.id]?.[0]
    if (!worktree) {
      throw new Error('real repository produced no worktree')
    }
    useAppStore.setState((current) => ({
      worktreesByRepo: {
        ...current.worktreesByRepo,
        [repo.id]: (current.worktreesByRepo[repo.id] ?? []).map((entry) =>
          entry.id === worktree.id ? { ...entry, name: 'main' } : entry
        )
      }
    }))
    await writeProgress('worktree-loaded')

    useAppStore.getState().setActiveWorktree(worktree.id)
    await writeProgress('worktree-activated')
    const tab =
      useAppStore.getState().tabsByWorktree[worktree.id]?.[0] ??
      // Why: a functional fixture is not a user interaction. Recording the
      // feature here adds persistence work during bootstrap and races PTY mount.
      useAppStore.getState().createTab(worktree.id, undefined, undefined, {
        recordInteraction: false
      })
    await writeProgress('terminal-tab-created')
    useAppStore.getState().setActiveTab(tab.id)
    useAppStore.getState().setActiveTabType('terminal')
    useAppStore.getState().setRightSidebarTab('explorer')
    useAppStore.getState().setRightSidebarOpen(false)
    const { syncTauriBrowserPageWebviews } =
      await import('@/components/browser-pane/tauri-browser-page-webview')
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50))
    syncTauriBrowserPageWebviews()
    await writeProgress('terminal-tab-activated')
    const ptyId = await waitFor(() => {
      const state = useAppStore.getState()
      return state.tabsByWorktree[worktree.id]?.find((entry) => entry.id === tab.id)?.ptyId || null
    })
    await writeProgress('pty-created')
    await waitFor(() => document.querySelector(`[data-pty-id="${CSS.escape(ptyId)}"]`) !== null)
    await writeProgress('terminal-mounted')
    // Why: a mounted xterm can precede shell readiness. Writing during that
    // gap reproduces the lost first command and long input latency regression.
    await waitFor(() => terminalText(ptyId).includes('repo'))
    await writeProgress('terminal-shell-ready')

    const marker = `PEBBLE_REAL_RUNTIME_${crypto.randomUUID()}`
    const encoded = btoa(marker)
    const commandAccepted = await window.api.pty.writeAccepted(
      ptyId,
      `node -e "console.log(Buffer.from('${encoded}','base64').toString('utf8'))"\r`
    )
    if (!commandAccepted) {
      throw new Error('native PTY input queue rejected the gate command')
    }
    await waitFor(() => runtimeTailContains(ptyId, marker))
    const clearAccepted = await window.api.pty.writeAccepted(ptyId, 'clear\r')
    if (!clearAccepted) {
      throw new Error('native PTY input queue rejected clear')
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1_000))
    await writeProgress('terminal-command-executed')
    const terminalCaptureBytes = await captureGateSurface(config, 'terminal')
    const browserEvidence = config.browserUrl
      ? await verifyNativeBrowser(worktree.id, config.browserUrl)
      : {}
    await writeProgress('browser-verified')
    const browserCaptureBytes = await captureGateSurface(config, 'browser')
    useAppStore.getState().setActiveTab(tab.id)
    useAppStore.getState().setActiveTabType('terminal')
    const sourceControlEvidence = await verifySourceControl(worktree.id, worktree.path)
    await writeProgress('source-control-verified')
    useAppStore.getState().setRightSidebarTab('source-control')
    useAppStore.getState().setRightSidebarOpen(true)
    await waitFor(() => document.querySelector('[data-parity-surface="source-control"]'))
    await waitFor(() => {
      const text =
        document.querySelector('[data-parity-surface="source-control"]')?.textContent ?? ''
      return ['README.md', 'staged.txt', 'untracked.txt', 'renamed.txt'].every((name) =>
        text.includes(name)
      )
    })
    const sourceControlCaptureBytes = await captureGateSurface(config, 'source-control')
    const checksEvidence = await verifyProviderBackedChecks(
      config,
      repo.id,
      worktree.id,
      repo.path,
      ptyId
    )
    await writeProgress('checks-verified')
    const nativeChatEvidence = await verifyNativeChatTranscript()
    await writeProgress('native-chat-verified')
    await writeEvidence({
      status: 'passed',
      durationMs: Math.round(performance.now() - startedAt),
      repoId: repo.id,
      worktreeId: worktree.id,
      ptyId,
      terminalMounted: true,
      commandExecuted: true,
      terminalCaptureBytes,
      browserCaptureBytes,
      sourceControlCaptureBytes,
      windowLifecycle,
      ...browserEvidence,
      ...sourceControlEvidence,
      ...checksEvidence,
      ...nativeChatEvidence
    })
  } catch (error) {
    await writeEvidence({
      status: 'failed',
      durationMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function measureWindowLifecycle(config: GateConfig): Promise<WindowLifecycleMeasurement> {
  if (!Number.isFinite(config.launchEpochMs) || Number(config.launchEpochMs) <= 0) {
    throw new Error('functional gate launch timestamp is unavailable')
  }
  return measureTauriWindowLifecycle(Number(config.launchEpochMs))
}

function normalizeParityRendererState(): void {
  document.documentElement.classList.remove('dark')
  document.documentElement.classList.add('light')
  useAppStore.setState((current) => ({
    // Why: persisted navigation must not keep the functional terminal hidden
    // after the gate activates its tab.
    activeView: 'terminal',
    activeWorktreeId: null,
    folderWorkspaces: [],
    projectGroups: [],
    projects: [],
    repos: [],
    rightSidebarOpen: false,
    settings: current.settings
      ? {
          ...current.settings,
          floatingTerminalEnabled: false,
          showMobileButton: false,
          terminalGpuAcceleration: 'off',
          terminalQuickCommands: [],
          theme: 'light'
        }
      : null,
    setupGuideSidebarDismissed: true,
    settingsPageOpen: false,
    worktreesByRepo: {}
  }))
}

async function verifySourceControl(
  worktreeId: string,
  worktreePath: string
): Promise<Record<string, unknown>> {
  const status = await window.api.git.status({ worktreePath })
  const expected = [
    ['README.md', 'modified', 'unstaged'],
    ['staged.txt', 'added', 'staged'],
    ['untracked.txt', 'untracked', 'untracked'],
    ['renamed.txt', 'renamed', 'staged']
  ] as const
  for (const [path, fileStatus, area] of expected) {
    if (
      !status.entries.some(
        (entry) => entry.path === path && entry.status === fileStatus && entry.area === area
      )
    ) {
      throw new Error(`source control did not project ${area} ${fileStatus} ${path}`)
    }
  }
  // Why: hidden functional windows can throttle the normal three-second poll;
  // project the already verified native result through the same product store.
  useAppStore.getState().setGitStatus(worktreeId, status)
  return {
    sourceControlProjected: true,
    sourceControlEntryCount: status.entries.length
  }
}
