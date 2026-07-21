import { invoke } from '@tauri-apps/api/core'
import { homeDir, join as joinNativePath } from '@tauri-apps/api/path'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { relaunch } from '@tauri-apps/plugin-process'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { MarkdownDocument } from '../../../packages/product-core/shared/types'
import { sanitizeCrashReportDetails } from '../../../packages/product-core/shared/crash-reporting'
import { PRODUCT_NAME } from './product-brand'
import { waitForTauriStartupServices } from './tauri-startup-services'

export async function normalizeTauriWorkspaceDirectory(
  settings: Awaited<ReturnType<PreloadApi['settings']['get']>>
): Promise<Awaited<ReturnType<PreloadApi['settings']['get']>>> {
  if (!/^~[\\/]pebble[\\/]workspaces$/.test(settings.workspaceDir)) {
    return settings
  }
  // Why: the web compatibility baseline cannot resolve "~". Desktop settings
  // expose the same absolute default path as Electron on every platform.
  return {
    ...settings,
    workspaceDir: await joinNativePath(await homeDir(), 'pebble', 'workspaces')
  }
}

export function createPebbleAppApi(base: PreloadApi['app']): PreloadApi['app'] {
  return {
    ...base,
    relaunch: () => relaunch(),
    restart: () => relaunch(),
    reload: async () => window.location.reload(),
    getKeyboardInputSourceId: () => invoke<string | null>('app_keyboard_input_source_id'),
    setUnreadDockBadgeCount: (count) =>
      getCurrentWindow().setBadgeCount(
        Number.isFinite(count) && count > 0 ? Math.min(99, count) : undefined
      ),
    // Why: terminal startup must not depend on the renderer path plugin being
    // ready; Rust resolves and validates the cwd before the PTY is mounted.
    getFloatingTerminalCwd: (args) =>
      invoke<string>('app_floating_terminal_cwd', { path: args?.path ?? null }),
    getFloatingMarkdownDirectory: () => invoke<string>('app_floating_markdown_directory'),
    pickFloatingMarkdownDocument: () =>
      invoke<MarkdownDocument | null>('app_pick_floating_markdown_document'),
    pickFloatingWorkspaceDirectory: () =>
      invoke<string | null>('app_pick_floating_workspace_directory'),
    getIdentity: () =>
      Promise.resolve({
        name: PRODUCT_NAME,
        isDev: import.meta.env.DEV,
        devLabel: import.meta.env.DEV ? 'Dev' : null,
        devBranch: null,
        devWorktreeName: null,
        devRepoRoot: null,
        dockBadgeLabel: null
      }),
    awaitFirstWindowStartupServices: waitForTauriStartupServices,
    startupDiagnostic: recordTauriStartupDiagnostic
  }
}

async function recordTauriStartupDiagnostic(
  event: string,
  details?: Record<string, unknown>
): Promise<void> {
  if (!event.startsWith('renderer-')) {
    return
  }
  window.api.crashReports.recordBreadcrumb({
    name: `startup:${event}`,
    data: details ? sanitizeCrashReportDetails(details) : undefined
  })
}
