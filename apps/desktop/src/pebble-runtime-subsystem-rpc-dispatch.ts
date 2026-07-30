import type { RuntimeRpcResponse } from '../../../packages/product-core/shared/runtime-rpc-envelope'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { okRuntimeRpc } from './pebble-runtime-rpc-response'
import { callTauriAutomationRuntimeRpc } from './tauri-automations-api'
import { callTauriBrowserRuntimeRpc } from './tauri-browser-runtime-rpc'
import { callTauriAccountsRuntimeRpc } from './tauri-accounts-runtime-rpc'
import { callTauriClipboardRuntimeRpc } from './tauri-clipboard-runtime-rpc'
import { callTauriDiagnosticsRuntimeRpc } from './tauri-diagnostics-runtime-rpc'
import { callTauriSettingsRuntimeRpc } from './tauri-settings-runtime-rpc'
import { callTauriStatsRuntimeRpc } from './tauri-stats-runtime-rpc'
import { callTauriSkillsRuntimeRpc } from './tauri-skills-runtime-rpc'
import { callTauriUiRuntimeRpc } from './tauri-ui-runtime-rpc'
import { callTauriTerminalDisplayRuntimeRpc } from './tauri-terminal-display-runtime-rpc'
import { callTauriFileRuntimeRpc } from './tauri-file-runtime-rpc'
import { callTauriGitRuntimeRpc } from './tauri-git-runtime-rpc'
import { callTauriSessionTabsRuntimeRpc } from './tauri-session-tabs-runtime-rpc'
import { callTauriProjectHostSetupRuntimeRpc } from './tauri-project-host-setup-runtime-rpc'
import { callTauriWorkspacePortsRuntimeRpc } from './tauri-workspace-ports-api'
import { callTauriOrchestrationRuntimeRpc } from './tauri-orchestration-runtime-rpc'
import { callTauriTerminalRuntimeRpc } from './tauri-terminal-runtime-rpc'
import { callTauriEmulatorRuntimeRpc } from './tauri-emulator-runtime-rpc'
import {
  emitTerminalFitOverride,
  hasTerminalFitOverride,
  restoreTauriTerminalFit,
  setTerminalDriver
} from './pebble-runtime-driver-registry'

// Each subsystem bridge reports `handled` so the first owner of a method wins;
// a null return hands the method on to the remaining dispatch groups.
export async function dispatchTauriSubsystemRuntimeRpc(
  method: string,
  params?: unknown
): Promise<RuntimeRpcResponse<unknown> | null> {
  const accountsResult = await callTauriAccountsRuntimeRpc(method, params)
  if (accountsResult.handled) {
    return okRuntimeRpc(accountsResult.result)
  }
  const clipboardResult = await callTauriClipboardRuntimeRpc(method, params)
  if (clipboardResult.handled) {
    return okRuntimeRpc(clipboardResult.result)
  }
  const diagnosticsResult = await callTauriDiagnosticsRuntimeRpc(method)
  if (diagnosticsResult.handled) {
    return okRuntimeRpc(diagnosticsResult.result)
  }
  const settingsResult = await callTauriSettingsRuntimeRpc(method, params)
  if (settingsResult.handled) {
    return okRuntimeRpc(settingsResult.result)
  }
  const statsResult = await callTauriStatsRuntimeRpc(method)
  if (statsResult.handled) {
    return okRuntimeRpc(statsResult.result)
  }
  const skillsResult = await callTauriSkillsRuntimeRpc(method, params)
  if (skillsResult.handled) {
    return okRuntimeRpc(skillsResult.result)
  }
  const uiResult = await callTauriUiRuntimeRpc(method, params)
  if (uiResult.handled) {
    return okRuntimeRpc(uiResult.result)
  }
  const terminalDisplayResult = await callTauriTerminalDisplayRuntimeRpc(method, params, {
    hasPty: (ptyId) => window.api.pty.hasPty(ptyId),
    resizeMobile: async (ptyId, clientId, cols, rows) => {
      await requestRuntimeJson(`/v1/sessions/${encodeURIComponent(ptyId)}/resize`, {
        method: 'POST',
        body: { cols, rows, source: 'mobile', clientId },
        timeoutMs: 5000
      })
    },
    hasFitOverride: (ptyId) => hasTerminalFitOverride(ptyId),
    setMobileFit: (ptyId, viewport) =>
      emitTerminalFitOverride({ ptyId, mode: 'mobile-fit', ...viewport }),
    setMobileDriver: (ptyId, driver) => setTerminalDriver(ptyId, driver),
    restoreDesktopFit: restoreTauriTerminalFit
  })
  if (terminalDisplayResult.handled) {
    return okRuntimeRpc(terminalDisplayResult.result)
  }
  return dispatchTauriWorkspaceSubsystemRuntimeRpc(method, params)
}

async function dispatchTauriWorkspaceSubsystemRuntimeRpc(
  method: string,
  params?: unknown
): Promise<RuntimeRpcResponse<unknown> | null> {
  const browserResult = await callTauriBrowserRuntimeRpc(method, params)
  if (browserResult.handled) {
    return okRuntimeRpc(browserResult.result)
  }
  const terminalResult = await callTauriTerminalRuntimeRpc(method, params)
  if (terminalResult.handled) {
    return okRuntimeRpc(terminalResult.result)
  }
  const fileResult = await callTauriFileRuntimeRpc(method, params)
  if (fileResult.handled) {
    return okRuntimeRpc(fileResult.result)
  }
  const emulatorResult = await callTauriEmulatorRuntimeRpc(method, params)
  if (emulatorResult.handled) {
    return okRuntimeRpc(emulatorResult.result)
  }
  const gitResult = await callTauriGitRuntimeRpc(method, params)
  if (gitResult.handled) {
    return okRuntimeRpc(gitResult.result)
  }
  const automationResult = await callTauriAutomationRuntimeRpc(method, params)
  if (automationResult.handled) {
    return okRuntimeRpc(automationResult.result)
  }
  const sessionTabsResult = await callTauriSessionTabsRuntimeRpc(method, params)
  if (sessionTabsResult.handled) {
    return okRuntimeRpc(sessionTabsResult.result)
  }
  const projectHostSetupResult = await callTauriProjectHostSetupRuntimeRpc(method, params)
  if (projectHostSetupResult.handled) {
    return okRuntimeRpc(projectHostSetupResult.result)
  }
  const workspacePortsResult = await callTauriWorkspacePortsRuntimeRpc(method, params)
  if (workspacePortsResult.handled) {
    return okRuntimeRpc(workspacePortsResult.result)
  }
  const orchestrationResult = await callTauriOrchestrationRuntimeRpc(method, params)
  if (orchestrationResult.handled) {
    return okRuntimeRpc(orchestrationResult.result)
  }
  return null
}
