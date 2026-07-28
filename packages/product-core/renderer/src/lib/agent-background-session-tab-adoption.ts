import type { useAppStore } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { makePaneKey, type PaneKey } from '../../../shared/stable-pane-id'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { callRuntimeRpc, type getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getRemoteRuntimeTerminalHandle } from '@/runtime/runtime-terminal-stream'
import type { TuiAgent } from '../../../shared/types'

type Store = ReturnType<typeof useAppStore.getState>
type RuntimeTarget = ReturnType<typeof getActiveRuntimeTarget>
type LaunchConfig = Parameters<Store['registerAgentLaunchConfig']>[1]
type LaunchRegistration = NonNullable<Parameters<Store['registerAgentLaunchConfig']>[2]>

export type ReservedBackgroundSessionIdentity = {
  reservedTabId: string
  leafId: string
  paneKey: PaneKey
  launchToken: string
  launchRegistration: LaunchRegistration
  paneEnv: Record<string, string>
}

/**
 * Mints the tab, pane and launch identities a background agent session needs
 * *before* its PTY is spawned, so they can be baked into the spawn environment.
 */
export function reserveAgentBackgroundSessionIdentity(args: {
  store: Store
  agent: TuiAgent
  worktreeId: string
  launchConfig: LaunchConfig
  env: Record<string, string> | undefined
}): ReservedBackgroundSessionIdentity {
  // Why: agent hook callbacks are keyed by pane, and background automation tabs never
  // mount a TerminalPane to inject this env for us. createBrowserUuid (not
  // crypto.randomUUID) because the latter is undefined in non-secure browser contexts —
  // the LAN web client served over plain HTTP.
  const reservedTabId = createBrowserUuid()
  const leafId = createBrowserUuid()
  const paneKey = makePaneKey(reservedTabId, leafId)
  const launchToken = createBrowserUuid()
  const launchRegistration = { agentType: args.agent, launchToken, tabId: reservedTabId, leafId }
  args.store.registerAgentLaunchConfig(paneKey, args.launchConfig, launchRegistration)
  return {
    reservedTabId,
    leafId,
    paneKey,
    launchToken,
    launchRegistration,
    paneEnv: {
      ...args.env,
      PEBBLE_PANE_KEY: paneKey,
      PEBBLE_TAB_ID: reservedTabId,
      PEBBLE_WORKTREE_ID: args.worktreeId,
      PEBBLE_AGENT_LAUNCH_TOKEN: launchToken
    }
  }
}

/**
 * Best-effort teardown for a PTY that was spawned but can never be adopted by a
 * tab. Leaving it alive would strand an invisible agent process with no surface.
 */
export async function retireBackgroundSessionPty(
  ptyId: string,
  runtimeTarget: RuntimeTarget
): Promise<void> {
  try {
    if (runtimeTarget.kind === 'environment') {
      const handle = getRemoteRuntimeTerminalHandle(ptyId)
      if (handle) {
        await callRuntimeRpc(runtimeTarget, 'terminal.close', { terminal: handle })
      }
      return
    }
    await window.api.pty.kill(ptyId)
  } catch (error) {
    console.warn(
      '[agent-background-session] failed to retire an unadoptable PTY:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

/**
 * Publishes the hidden run tab already bound to its live PTY (#2989). Creating the
 * tab before the spawn left the store holding a tab with `ptyId: null` across the
 * await: Terminal.tsx re-renders on that write, and for an already-visited worktree
 * the tab can neither cold-park nor defer, so a TerminalPane mounts, finds nothing to
 * adopt, and starts a fresh default shell over the agent's own PTY.
 */
export async function publishAgentBackgroundSessionTab(args: {
  store: Store
  worktreeId: string
  reserved: ReservedBackgroundSessionIdentity
  ptyId: string
  runtimeTarget: RuntimeTarget
  title?: string
}): Promise<ReturnType<Store['createTab']>> {
  const { store, reserved, ptyId } = args
  const tab = store.createTab(args.worktreeId, undefined, undefined, {
    id: reserved.reservedTabId,
    initialPtyId: ptyId,
    activate: false,
    recordInteraction: false
  })
  // Why: createTab mints a fresh id when the reserved one collides, but PEBBLE_TAB_ID and
  // PEBBLE_PANE_KEY are already baked into the spawned process — re-keying would leave
  // routing and hook identity permanently disagreeing. Retire the launch instead.
  if (tab.id !== reserved.reservedTabId) {
    store.closeTab(tab.id, { recordInteraction: false })
    store.clearAgentLaunchConfig(reserved.paneKey)
    await retireBackgroundSessionPty(ptyId, args.runtimeTarget)
    throw new Error('The background session could not reserve its terminal identity.')
  }
  if (args.title) {
    store.setTabCustomTitle(tab.id, args.title, { recordInteraction: false })
  }
  // Why: `title` labels the tab/worktree entry. Pane titles render as an in-terminal
  // title row, so background sessions must not persist it there.
  store.setTabLayout(tab.id, singlePaneLayoutSnapshot(reserved.leafId, ptyId))
  return tab
}
