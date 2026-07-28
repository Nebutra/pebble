import { useAppStore } from '@/store'
import { buildAgentStartupPlan, type AgentStartupPlan } from '@/lib/tui-agent-startup'
import type {
  LaunchAgentBackgroundSessionArgs,
  LaunchAgentBackgroundSessionResult
} from '@/lib/agent-background-session-contract'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { showAutomationPromptNotSentToast } from '@/lib/agent-background-session-timeout-toast'
import { resolveAgentBackgroundLaunchHost } from '@/lib/agent-background-session-launch-host'
import { BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT } from '@/constants/terminal'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import {
  registerEagerPtyBuffer,
  subscribeToPtyExit
} from '@/components/terminal-pane/pty-dispatcher'
import { subscribeToPtyData } from '@/components/terminal-pane/pty-data-sidecar-subscriptions'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import {
  getRemoteRuntimeTerminalHandle,
  subscribeToRuntimeTerminalData,
  toRemoteRuntimePtyId
} from '@/runtime/runtime-terminal-stream'
import { createAgentStatusOscProcessor } from '../../../shared/agent-status-osc'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-types'
import { createSshBackgroundStartupDelivery } from '@/lib/ssh-background-startup-delivery'
import { shouldUseShellReadyStartupDelivery } from '../../../shared/codex-startup-delivery'
import {
  publishAgentBackgroundSessionTab,
  reserveAgentBackgroundSessionIdentity
} from '@/lib/agent-background-session-tab-adoption'

export async function launchAgentBackgroundSession(
  args: LaunchAgentBackgroundSessionArgs
): Promise<LaunchAgentBackgroundSessionResult | null> {
  const { agent, worktreeId, prompt, launchSource, title, onData, onExit, onAgentStatus } = args
  const store = useAppStore.getState()
  // Why: folder workspaces never land in worktreesByRepo, so allWorktrees() reported
  // them absent and every folder-workspace automation died at resolution.
  const worktree = store.getKnownWorktreeById(worktreeId)
  const repo = worktree ? store.repos.find((entry) => entry.id === worktree.repoId) : null
  if (!worktree) {
    throw new Error('The target workspace is no longer available.')
  }
  // Why: a folder workspace has a synthetic repoId with no repo row, so every
  // repo-derived launch input silently degraded to a local default and SSH folder
  // workspaces ran their agent on the client instead of their own host.
  const launchHost = resolveAgentBackgroundLaunchHost({
    store,
    worktreeId,
    worktreePath: worktree.path,
    repo
  })
  const preflight = TUI_AGENT_CONFIG[agent].preflightTrust
  if (preflight && worktree.path && window.api.agentTrust?.markTrusted) {
    try {
      await window.api.agentTrust.markTrusted({
        preset: preflight,
        workspacePath: worktree.path,
        ...(launchHost.connectionId ? { connectionId: launchHost.connectionId } : {})
      })
    } catch {
      // Best-effort: continue with launch. The user can still accept the trust menu.
    }
  }
  const cmdOverrides = store.settings?.agentCmdOverrides ?? {}
  const agentArgs = resolveTuiAgentLaunchArgs(agent, store.settings?.agentDefaultArgs)
  const agentEnv = resolveTuiAgentLaunchEnv(agent, store.settings?.agentDefaultEnv)
  // Why: preserve the SSH signal so remote launch routing remains relay-owned.
  const { platform: launchPlatform, isRemote } = launchHost
  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'

  let startupPlan: AgentStartupPlan | null = null
  let pasteDraftAfterLaunch: string | null = null
  if (hasPrompt && isFollowupPath) {
    startupPlan = buildAgentStartupPlan({
      agent,
      prompt: '',
      cmdOverrides,
      agentArgs,
      agentEnv,
      platform: launchPlatform,
      isRemote,
      allowEmptyPromptLaunch: true
    })
    pasteDraftAfterLaunch = trimmedPrompt
  } else {
    startupPlan = buildAgentStartupPlan({
      agent,
      prompt: hasPrompt ? trimmedPrompt : '',
      cmdOverrides,
      agentArgs,
      agentEnv,
      platform: launchPlatform,
      isRemote,
      allowEmptyPromptLaunch: !hasPrompt
    })
  }
  if (!startupPlan) {
    return null
  }

  // Why: automation runs should start without revealing the workspace.
  // Background-mount the hidden worktree first so its off-screen terminal surface
  // gets a measurable layout box and the eager PTY buffer flushes on the first
  // mount — mirroring the renderer-backed Codex startup path in useIpcEvents.
  window.dispatchEvent(
    new CustomEvent(BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT, {
      detail: { worktreeId }
    })
  )
  // Why: reserve identities before the spawn so the tab can be published already bound
  // to its live PTY; see agent-background-session-tab-adoption for the failure it closes.
  const reserved = reserveAgentBackgroundSessionIdentity({
    store,
    agent,
    worktreeId,
    launchConfig: startupPlan.launchConfig,
    env: startupPlan.env
  })
  const { reservedTabId, leafId, paneKey, launchToken, launchRegistration, paneEnv } = reserved
  const sshConnectionId = launchHost.connectionId
  const sshStartupDelivery = createSshBackgroundStartupDelivery({
    command: sshConnectionId ? startupPlan.launchCommand : null,
    waitForShellReady:
      Boolean(sshConnectionId) &&
      shouldUseShellReadyStartupDelivery({
        command: startupPlan.launchCommand,
        startupCommandDelivery: startupPlan.startupCommandDelivery
      }),
    write: (ptyId, data) => window.api.pty.write(ptyId, data)
  })
  // Route by the worktree's owner host, not the focused runtime.
  const runtimeTarget = getActiveRuntimeTarget(
    getSettingsForWorktreeRuntimeOwner(store, worktreeId)
  )
  let ptyId = ''
  try {
    if (runtimeTarget.kind === 'environment') {
      // Why: runtime environments execute on the server; using local pty.spawn
      // would silently run automation on the client for a remote workspace.
      const created = await callRuntimeRpc<{ terminal: RuntimeTerminalCreate }>(
        runtimeTarget,
        'terminal.create',
        {
          worktree: toRuntimeWorktreeSelector(worktreeId),
          command: startupPlan.launchCommand,
          launchConfig: startupPlan.launchConfig,
          launchToken,
          launchAgent: agent,
          ...(startupPlan.startupCommandDelivery
            ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
            : {}),
          env: paneEnv,
          title,
          tabId: reservedTabId,
          leafId,
          // Why: local renderer owns the hidden tab; remote runtime should not reveal UI.
          presentation: 'background'
        },
        { timeoutMs: 15_000 }
      )
      ptyId = toRemoteRuntimePtyId(created.terminal.handle, runtimeTarget.environmentId)
    } else {
      const result = await window.api.pty.spawn({
        cols: 120,
        rows: 40,
        cwd: worktree.path,
        command: startupPlan.launchCommand,
        ...(!startupPlan.startupCommandDelivery
          ? {}
          : { startupCommandDelivery: startupPlan.startupCommandDelivery }),
        env: paneEnv,
        launchConfig: startupPlan.launchConfig,
        launchToken,
        launchAgent: agent,
        connectionId: sshConnectionId,
        worktreeId,
        tabId: reservedTabId,
        leafId,
        telemetry: {
          agent_kind: tuiAgentToAgentKind(agent),
          launch_source: launchSource ?? 'unknown',
          request_kind: 'new'
        }
      })
      ptyId = result.id
      if (result.launchConfig) {
        store.registerAgentLaunchConfig(paneKey, result.launchConfig, launchRegistration)
      }
    }
  } catch (error) {
    store.clearAgentLaunchConfig(paneKey)
    throw error
  }
  const tab = await publishAgentBackgroundSessionTab({
    store,
    worktreeId,
    reserved,
    ptyId,
    runtimeTarget,
    ...(title ? { title } : {})
  })
  if (agent === 'command-code' && hasPrompt && !isFollowupPath) {
    // Why: Command Code does not expose a prompt-start hook; seed working for
    // hidden prompt launches so sidebar/activity surfaces do not stay idle.
    store.setAgentStatus(
      paneKey,
      {
        state: 'working',
        prompt: trimmedPrompt,
        agentType: agent
      },
      undefined,
      undefined,
      undefined,
      { launchConfig: startupPlan.launchConfig, launchToken }
    )
  }
  let exitHandled = false
  let unsubscribeExit = (): void => {},
    unsubscribeData = (): void => {}
  const handleExit = (ptyId: string, code: number): void => {
    if (exitHandled) {
      return
    }
    exitHandled = true
    unsubscribeExit()
    unsubscribeData()
    sshStartupDelivery.clear()
    useAppStore.getState().clearTabPtyId(tab.id, ptyId)
    useAppStore.getState().clearAgentLaunchConfig(paneKey)
    onExit?.(ptyId, code)
  }
  const processAgentStatus = createAgentStatusOscProcessor()
  const handleData = (data: string): void => {
    data = sshStartupDelivery.handleData(data)
    onData?.(data)
    sshStartupDelivery.schedule(ptyId)
    const processed = processAgentStatus(data)
    for (const payload of processed.payloads) {
      useAppStore.getState().setAgentStatus(paneKey, payload, undefined, undefined, undefined, {
        launchToken
      })
      onAgentStatus?.(payload)
    }
  }
  if (runtimeTarget.kind === 'environment') {
    unsubscribeData = await subscribeToRuntimeTerminalData(
      store.settings,
      ptyId,
      `desktop:background:${tab.id}`,
      handleData
    )
    const terminal = getRemoteRuntimeTerminalHandle(ptyId)
    if (!terminal) {
      throw new Error('Runtime terminal id is invalid.')
    }
    void callRuntimeRpc<{ wait: { exitCode?: number | null } }>(
      runtimeTarget,
      'terminal.wait',
      { terminal, for: 'exit' },
      { timeoutMs: 24 * 60 * 60 * 1000 }
    )
      .then((result) => handleExit(ptyId, result.wait.exitCode ?? 0))
      .catch(() => {})
  } else {
    registerEagerPtyBuffer(ptyId, handleExit)
    unsubscribeData = subscribeToPtyData(ptyId, handleData)
    // Why: opening the workspace attaches a real terminal transport and disposes
    // the eager exit handler. This sidecar keeps automation completion tracking
    // alive regardless of whether the tab is hidden or mounted.
    unsubscribeExit = subscribeToPtyExit(ptyId, (code) => handleExit(ptyId, code))
  }

  if (pasteDraftAfterLaunch !== null) {
    void pasteDraftWhenAgentReady({
      tabId: tab.id,
      content: pasteDraftAfterLaunch,
      agent,
      submit: true,
      onTimeout: () => showAutomationPromptNotSentToast(agent)
    })
  }

  return { tabId: tab.id, paneKey, ptyId, startupPlan }
}
