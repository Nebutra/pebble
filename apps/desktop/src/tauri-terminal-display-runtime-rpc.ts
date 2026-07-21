import {
  readTauriMobileAutoRestoreFitMs,
  writeTauriMobileAutoRestoreFitMs
} from './tauri-mobile-fit-preference'

type TerminalViewport = { cols: number; rows: number }
type TerminalDriver = { kind: 'mobile'; clientId: string }

export type TauriTerminalDisplayRuntimeDeps = {
  hasPty(ptyId: string): Promise<boolean | null>
  resizeMobile(ptyId: string, clientId: string, cols: number, rows: number): Promise<void>
  hasFitOverride(ptyId: string): boolean
  setMobileFit(ptyId: string, viewport: TerminalViewport): void
  setMobileDriver(ptyId: string, driver: TerminalDriver): void
  restoreDesktopFit(ptyId: string): Promise<unknown>
}

type RuntimeTerminalDisplayResult = { handled: boolean; result?: unknown }

export async function callTauriTerminalDisplayRuntimeRpc(
  method: string,
  params: unknown,
  deps: TauriTerminalDisplayRuntimeDeps
): Promise<RuntimeTerminalDisplayResult> {
  if (method === 'terminal.setDisplayMode') {
    return handled(await setDisplayMode(params, deps))
  }
  if (method === 'terminal.getDisplayMode') {
    return handled(getDisplayMode(params, deps))
  }
  if (method === 'terminal.updateViewport') {
    return handled(await updateViewport(params, deps))
  }
  if (method === 'terminal.getAutoRestoreFit') {
    return handled({ ms: readTauriMobileAutoRestoreFitMs() })
  }
  if (method === 'terminal.setAutoRestoreFit') {
    return handled({ ms: writeTauriMobileAutoRestoreFitMs(readAutoRestoreFitValue(params)) })
  }
  return { handled: false }
}

function readAutoRestoreFitValue(params: unknown): number | null {
  const value = readObject(params).ms
  if (value !== null && typeof value !== 'number') {
    throw new Error('invalid_auto_restore_fit_ms')
  }
  return value
}

async function setDisplayMode(params: unknown, deps: TauriTerminalDisplayRuntimeDeps) {
  const input = readObject(params)
  const ptyId = readRequiredString(input.terminal, 'terminal handle')
  if (input.mode !== 'auto' && input.mode !== 'desktop') {
    throw new Error('invalid_terminal_display_mode')
  }
  await assertPtyExists(ptyId, deps)
  if (input.mode === 'desktop') {
    await deps.restoreDesktopFit(ptyId)
    return { mode: input.mode }
  }
  const viewport = readViewport(input.viewport, false)
  if (viewport) {
    const clientId = readRequiredString(paramsClientId(input.client), 'client ID')
    await applyMobileViewport(ptyId, clientId, viewport, deps)
  }
  const client = readObject(input.client)
  if (client.type === 'mobile' && typeof client.id === 'string' && client.id.trim()) {
    deps.setMobileDriver(ptyId, { kind: 'mobile', clientId: client.id.trim() })
  }
  return { mode: input.mode }
}

function getDisplayMode(params: unknown, deps: TauriTerminalDisplayRuntimeDeps) {
  const ptyId = readRequiredString(readObject(params).terminal, 'terminal handle')
  const isPhoneFitted = deps.hasFitOverride(ptyId)
  return { mode: isPhoneFitted ? 'auto' : 'desktop', isPhoneFitted }
}

async function updateViewport(params: unknown, deps: TauriTerminalDisplayRuntimeDeps) {
  const input = readObject(params)
  const ptyId = readRequiredString(input.terminal, 'terminal handle')
  const viewport = readViewport(input.viewport, true)
  if (!viewport) {
    throw new Error('missing_terminal_viewport')
  }
  await assertPtyExists(ptyId, deps)
  const client = readObject(input.client)
  const clientId = readRequiredString(client.id, 'client ID')
  if (client.type !== undefined && client.type !== 'mobile' && client.type !== 'desktop') {
    throw new Error('invalid_terminal_client_type')
  }
  if (client.type !== 'desktop') {
    deps.setMobileDriver(ptyId, { kind: 'mobile', clientId })
  }
  await applyMobileViewport(ptyId, clientId, viewport, deps)
  return { updated: true, applied: true }
}

async function applyMobileViewport(
  ptyId: string,
  clientId: string,
  viewport: TerminalViewport,
  deps: TauriTerminalDisplayRuntimeDeps
): Promise<void> {
  await deps.resizeMobile(ptyId, clientId, viewport.cols, viewport.rows)
  deps.setMobileFit(ptyId, viewport)
}

function paramsClientId(value: unknown): unknown {
  return readObject(value).id
}

async function assertPtyExists(
  ptyId: string,
  deps: TauriTerminalDisplayRuntimeDeps
): Promise<void> {
  if (!(await deps.hasPty(ptyId))) {
    throw new Error('no_connected_pty')
  }
}

function readViewport(value: unknown, required: boolean): TerminalViewport | null {
  const viewport = readObject(value)
  if (Object.keys(viewport).length === 0 && !required) {
    return null
  }
  const { cols, rows } = viewport
  if (
    typeof cols !== 'number' ||
    !Number.isInteger(cols) ||
    cols < 20 ||
    cols > 240 ||
    typeof rows !== 'number' ||
    !Number.isInteger(rows) ||
    rows < 8 ||
    rows > 120
  ) {
    throw new Error('invalid_terminal_viewport')
  }
  return { cols, rows }
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing ${label}`)
  }
  return value.trim()
}

function handled(result: unknown): RuntimeTerminalDisplayResult {
  return { handled: true, result }
}
