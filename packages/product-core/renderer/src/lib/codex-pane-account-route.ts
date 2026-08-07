import type { AppState } from '@/store'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'

/** Which CODEX_HOME family a Codex pane was launched against. Host and each WSL
 *  distro resolve to separate managed homes, so they are separate routes. */
export type CodexPaneAccountRoute = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
}

const DEFAULT_WSL_DISTRO_KEY = '__default__'

export function getCodexPaneAccountRouteKey(route: CodexPaneAccountRoute): string {
  if (route.runtime === 'host') {
    return 'host'
  }
  const distro = route.wslDistro?.trim()
  return `wsl:${distro ? distro : DEFAULT_WSL_DISTRO_KEY}`
}

/** Why: a pane bakes CODEX_HOME into its environment at spawn and never sees a
 *  later change, so its route is fixed by the worktree it was opened from. */
export function getCodexPaneAccountRouteKeyForWorktree(
  state: AppState,
  worktreeId: string
): string {
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId)
  if (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') {
    return getCodexPaneAccountRouteKey({
      runtime: 'wsl',
      wslDistro: projectRuntime.runtime.distro
    })
  }
  return getCodexPaneAccountRouteKey({ runtime: 'host' })
}
