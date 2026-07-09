import { invoke } from '@tauri-apps/api/core'
import type { PreloadApi } from '../../../src/preload/api-types'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION
} from '../../../src/shared/protocol-version'
import type { RuntimeRpcResponse } from '../../../src/shared/runtime-rpc-envelope'
import type {
  RuntimeBrowserDriverState,
  RuntimeSyncWindowGraph,
  RuntimeSyncWindowGraphResult,
  RuntimeTerminalDriverState
} from '../../../src/shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../src/shared/runtime-environments'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import { PRODUCT_NAME } from './product-brand'
import { warnUnmappedRuntimeMethod } from './runtime-unmapped-method-warning'
import {
  getErrorMessage,
  getHostPlatform,
  hasTauriInternals,
  ensurePebbleRuntimeProcess,
  readPebbleStatusOrNull,
  requestRuntimeJson
} from './pebble-tauri-runtime-transport'
import {
  createRuntimeWorktreeResult,
  getRuntimeRepoId,
  persistRuntimeProjectSortOrder,
  persistRuntimeWorktreeSortOrder,
  readRuntimeWorktreeLineage,
  readRepos,
  readWorktrees,
  removeRuntimeWorktree,
  setRuntimeWorktreeMeta,
  toCreateWorktreeArgs
} from './pebble-tauri-workspace-runtime-api'
import { callTauriBrowserRuntimeRpc } from './tauri-browser-runtime-rpc'

const PEBBLE_RUNTIME_ID = 'pebble-local'

type RuntimeProviderSubsystem = 'browser' | 'computer' | 'emulator'
type RuntimeSubsystemName = RuntimeProviderSubsystem | 'mobile-relay'

type TerminalFitOverrideSnapshot = {
  ptyId: string
  mode: 'mobile-fit'
  cols: number
  rows: number
}

type TerminalFitOverrideEvent = {
  ptyId: string
  mode: 'mobile-fit' | 'desktop-fit'
  cols: number
  rows: number
}

type TerminalDriverSnapshot = {
  ptyId: string
  driver: RuntimeTerminalDriverState
}

type BrowserDriverSnapshot = {
  browserPageId: string
  driver: RuntimeBrowserDriverState
}

type TerminalDriverEvent = TerminalDriverSnapshot
type BrowserDriverEvent = BrowserDriverSnapshot

type RuntimeNativeProvider = {
  id: string
  subsystem: RuntimeProviderSubsystem
  name: string
  status: 'ready' | 'running' | 'degraded' | 'error'
  capabilities: string[]
  message?: string
  lastSeenAt: string
}

type RuntimeSubsystemStatus = {
  name: RuntimeSubsystemName | string
  status: string
  configured: boolean
  capabilities: string[]
  message?: string
}

const terminalFitOverrides = new Map<string, Omit<TerminalFitOverrideSnapshot, 'ptyId'>>()
const terminalDrivers = new Map<string, RuntimeTerminalDriverState>()
const browserDrivers = new Map<string, RuntimeBrowserDriverState>()
const terminalFitOverrideListeners = new Set<(event: TerminalFitOverrideEvent) => void>()
const terminalDriverListeners = new Set<(event: TerminalDriverEvent) => void>()
const browserDriverListeners = new Set<(event: BrowserDriverEvent) => void>()

export function createPebbleRuntimeApi(base: PreloadApi['runtime']): PreloadApi['runtime'] {
  return {
    ...base,
    syncWindowGraph: (graph) => readOrCreateRuntimeStatus(graph),
    getStatus: () => readOrCreateRuntimeStatus(),
    call: ({ method, params }) => callPebbleRuntimeMethod(method, params),
    getTerminalFitOverrides: () => Promise.resolve(readTerminalFitOverrides()),
    getTerminalDrivers: () => Promise.resolve(readTerminalDrivers()),
    getBrowserDrivers: () => Promise.resolve(readBrowserDrivers()),
    restoreTerminalFit: async (ptyId) => restoreTauriTerminalFit(ptyId),
    reclaimBrowserForDesktop: async (browserPageId) => reclaimTauriBrowserForDesktop(browserPageId),
    onTerminalFitOverrideChanged: (callback) =>
      subscribeToSet(terminalFitOverrideListeners, callback),
    onTerminalDriverChanged: (callback) => subscribeToSet(terminalDriverListeners, callback),
    onBrowserDriverChanged: (callback) => subscribeToSet(browserDriverListeners, callback)
  }
}

export function createPebbleRuntimeEnvironmentsApi(
  base: PreloadApi['runtimeEnvironments']
): PreloadApi['runtimeEnvironments'] {
  return {
    ...base,
    list: () =>
      hasTauriInternals()
        ? invoke<PublicKnownRuntimeEnvironment[]>('runtime_environments_list')
        : Promise.resolve([]),
    resolve: ({ selector }) =>
      invoke<PublicKnownRuntimeEnvironment>('runtime_environments_resolve', {
        input: { selector }
      }),
    getStatus: async () => okRuntimeRpc(await readOrCreateRuntimeStatus()),
    call: async ({ selector, method, params, timeoutMs }) => {
      try {
        return await invoke<RuntimeRpcResponse<unknown>>('runtime_environments_call', {
          input: { selector, method, params, timeoutMs }
        })
      } catch (error) {
        return failRuntimeRpc('remote_runtime_unavailable', getErrorMessage(error))
      }
    },
    addFromPairingCode: ({ name, pairingCode }) =>
      invoke<{ environment: PublicKnownRuntimeEnvironment }>(
        'runtime_environments_add_from_pairing_code',
        { input: { name, pairingCode } }
      ),
    remove: ({ selector }) =>
      invoke<{ removed: PublicKnownRuntimeEnvironment }>('runtime_environments_remove', {
        input: { selector }
      }),
    disconnect: ({ selector }) =>
      invoke<{ disconnected: PublicKnownRuntimeEnvironment }>('runtime_environments_disconnect', {
        input: { selector }
      }),
    subscribe: async (_args, callbacks) => {
      callbacks.onError?.({
        code: 'remote_subscription_unavailable',
        message:
          'Remote runtime subscriptions are not available in the Tauri shell yet. One-shot runtime calls remain available.'
      })
      callbacks.onClose?.()
      return { unsubscribe: noopUnsubscribe, sendBinary: noopSendBinary }
    }
  }
}

async function callPebbleRuntimeMethod(
  method: string,
  params?: unknown
): Promise<RuntimeRpcResponse<unknown>> {
  try {
    const browserResult = await callTauriBrowserRuntimeRpc(method, params)
    if (browserResult.handled) {
      return okRuntimeRpc(browserResult.result)
    }
    switch (method) {
      case 'status.get':
        return okRuntimeRpc(await readOrCreateRuntimeStatus())
      case 'repo.list':
        return okRuntimeRpc({ repos: await readRepos() })
      case 'repo.reorder':
        return okRuntimeRpc(await persistRuntimeProjectSortOrder(toOrderedIds(params)))
      case 'project.list':
        return okRuntimeRpc({
          projects: projectHostSetupProjectionFromRepos(await readRepos()).projects
        })
      case 'projectHostSetup.list':
        return okRuntimeRpc({
          setups: projectHostSetupProjectionFromRepos(await readRepos()).setups
        })
      case 'provider.list':
      case 'providers.list':
      case 'nativeProvider.list':
        return okRuntimeRpc({ providers: await readRuntimeNativeProviders(params) })
      case 'provider.status':
      case 'subsystem.status':
        return okRuntimeRpc({ status: await readRuntimeSubsystemStatus(params) })
      case 'provider.register':
      case 'nativeProvider.register':
        return okRuntimeRpc({ provider: await registerRuntimeNativeProvider(params) })
      case 'worktree.list':
        return okRuntimeRpc({ worktrees: await readWorktrees(getRuntimeRepoId(params)) })
      case 'worktree.lineageList':
        return okRuntimeRpc(await readRuntimeWorktreeLineage())
      case 'worktree.create':
        return okRuntimeRpc(await createRuntimeWorktreeResult(toCreateWorktreeArgs(params)))
      case 'worktree.set':
        return okRuntimeRpc({ worktree: await setRuntimeWorktreeMeta(params) })
      case 'worktree.persistSortOrder':
        await persistRuntimeWorktreeSortOrder(toOrderedIds(params))
        return okRuntimeRpc({ status: 'applied' })
      case 'worktree.remove':
        return okRuntimeRpc({ preservedBranch: await removeRuntimeWorktree(params) })
      case 'preflight.check':
        return okRuntimeRpc(await window.api.preflight.check())
      case 'preflight.detectAgents':
        return okRuntimeRpc(await window.api.preflight.detectAgents())
      case 'preflight.refreshAgents':
        return okRuntimeRpc(await window.api.preflight.refreshAgents())
      case 'preflight.detectRemoteAgents':
        return okRuntimeRpc(
          await window.api.preflight.detectRemoteAgents(toConnectionParams(params))
        )
      case 'preflight.detectRemoteWindowsTerminalCapabilities':
        return okRuntimeRpc(
          await window.api.preflight.detectRemoteWindowsTerminalCapabilities(
            toConnectionParams(params)
          )
        )
      default:
        warnUnmappedRuntimeMethod(method)
        return failRuntimeRpc(
          'method_not_available',
          `${PRODUCT_NAME} runtime method is not mapped: ${method}`
        )
    }
  } catch (error) {
    return failRuntimeRpc('runtime_error', getErrorMessage(error))
  }
}

async function readRuntimeNativeProviders(params: unknown): Promise<RuntimeNativeProvider[]> {
  await ensurePebbleRuntimeProcess()
  const subsystem = readProviderSubsystem(params)
  const query = subsystem ? `?subsystem=${encodeURIComponent(subsystem)}` : ''
  return requestRuntimeJson<RuntimeNativeProvider[]>(`/v1/providers${query}`, { method: 'GET' })
}

async function readRuntimeSubsystemStatus(params: unknown): Promise<RuntimeSubsystemStatus> {
  await ensurePebbleRuntimeProcess()
  const subsystem = readSubsystemName(params)
  return requestRuntimeJson<RuntimeSubsystemStatus>(`/v1/${subsystem}/status`, { method: 'GET' })
}

async function registerRuntimeNativeProvider(params: unknown): Promise<RuntimeNativeProvider> {
  await ensurePebbleRuntimeProcess()
  const input = readProviderObject(params)
  return requestRuntimeJson<RuntimeNativeProvider>('/v1/providers', {
    method: 'POST',
    body: {
      id: readProviderOptionalString(input.id),
      subsystem: readProviderSubsystem(input) ?? 'browser',
      name: readProviderRequiredString(input.name, 'native provider name'),
      status: readProviderOptionalString(input.status),
      capabilities: readProviderStringList(input.capabilities),
      message: readProviderOptionalString(input.message)
    }
  })
}

async function readOrCreateRuntimeStatus(
  graph?: RuntimeSyncWindowGraph
): Promise<RuntimeSyncWindowGraphResult> {
  const status = await readPebbleStatusOrNull()
  return {
    runtimeId: PEBBLE_RUNTIME_ID,
    rendererGraphEpoch: Date.now(),
    graphStatus: status ? 'ready' : 'unavailable',
    authoritativeWindowId: null,
    liveTabCount: graph?.tabs.length ?? 0,
    liveLeafCount: graph?.leaves.length ?? 0,
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
    capabilities: [...RUNTIME_CAPABILITIES],
    hostPlatform: getHostPlatform(),
    remoteControl: null,
    agentOrchestrationByPaneKey: {}
  }
}

function okRuntimeRpc<TResult>(result: TResult): RuntimeRpcResponse<TResult> {
  return {
    id: crypto.randomUUID(),
    ok: true,
    result,
    _meta: { runtimeId: PEBBLE_RUNTIME_ID }
  }
}

function failRuntimeRpc(code: string, message: string): RuntimeRpcResponse<unknown> {
  return {
    id: crypto.randomUUID(),
    ok: false,
    error: { code, message },
    _meta: { runtimeId: PEBBLE_RUNTIME_ID }
  }
}

function readSubsystemName(params: unknown): RuntimeSubsystemName {
  const input = readProviderObject(params)
  const value =
    readProviderOptionalString(input.name) ??
    readProviderOptionalString(input.subsystem) ??
    readProviderOptionalString(input.kind) ??
    'browser'
  if (
    value === 'browser' ||
    value === 'computer' ||
    value === 'emulator' ||
    value === 'mobile-relay'
  ) {
    return value
  }
  throw new Error(`Unsupported runtime subsystem: ${value}`)
}

function readProviderSubsystem(params: unknown): RuntimeProviderSubsystem | null {
  const input = readProviderObject(params)
  const value =
    readProviderOptionalString(input.subsystem) ??
    readProviderOptionalString(input.name) ??
    readProviderOptionalString(input.kind)
  if (!value) {
    return null
  }
  if (value === 'browser' || value === 'computer' || value === 'emulator') {
    return value
  }
  throw new Error(`Unsupported native provider subsystem: ${value}`)
}

function readProviderObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readProviderOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readProviderRequiredString(value: unknown, label: string): string {
  const result = readProviderOptionalString(value)
  if (!result) {
    throw new Error(`${label} is required`)
  }
  return result
}

function readProviderStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
}

function readTerminalFitOverrides(): TerminalFitOverrideSnapshot[] {
  return Array.from(terminalFitOverrides.entries()).map(([ptyId, override]) => ({
    ptyId,
    ...override
  }))
}

function readTerminalDrivers(): TerminalDriverSnapshot[] {
  return Array.from(terminalDrivers.entries()).map(([ptyId, driver]) => ({ ptyId, driver }))
}

function readBrowserDrivers(): BrowserDriverSnapshot[] {
  return Array.from(browserDrivers.entries()).map(([browserPageId, driver]) => ({
    browserPageId,
    driver
  }))
}

function getTerminalDriver(ptyId: string): RuntimeTerminalDriverState {
  return terminalDrivers.get(ptyId) ?? { kind: 'idle' }
}

function setTerminalDriver(ptyId: string, driver: RuntimeTerminalDriverState): void {
  const previous = getTerminalDriver(ptyId)
  if (sameRuntimeDriver(previous, driver)) {
    return
  }
  if (driver.kind === 'idle') {
    terminalDrivers.delete(ptyId)
  } else {
    terminalDrivers.set(ptyId, driver)
  }
  emitToSet(terminalDriverListeners, { ptyId, driver })
}

function getBrowserDriver(browserPageId: string): RuntimeBrowserDriverState {
  return browserDrivers.get(browserPageId) ?? { kind: 'idle' }
}

function setBrowserDriver(browserPageId: string, driver: RuntimeBrowserDriverState): void {
  const previous = getBrowserDriver(browserPageId)
  if (sameRuntimeDriver(previous, driver)) {
    return
  }
  if (driver.kind === 'idle') {
    browserDrivers.delete(browserPageId)
  } else {
    browserDrivers.set(browserPageId, driver)
  }
  emitToSet(browserDriverListeners, { browserPageId, driver })
}

function sameRuntimeDriver(
  left: RuntimeTerminalDriverState | RuntimeBrowserDriverState,
  right: RuntimeTerminalDriverState | RuntimeBrowserDriverState
): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  if (left.kind === 'mobile' && right.kind === 'mobile') {
    return left.clientId === right.clientId
  }
  return true
}

function emitTerminalFitOverride(event: TerminalFitOverrideEvent): void {
  if (event.mode === 'mobile-fit') {
    terminalFitOverrides.set(event.ptyId, {
      mode: 'mobile-fit',
      cols: event.cols,
      rows: event.rows
    })
  } else {
    terminalFitOverrides.delete(event.ptyId)
  }
  emitToSet(terminalFitOverrideListeners, event)
}

async function restoreTauriTerminalFit(ptyId: string): Promise<{ restored: boolean }> {
  const hadFitOverride = terminalFitOverrides.has(ptyId)
  const previousDriver = getTerminalDriver(ptyId)
  if (hadFitOverride) {
    emitTerminalFitOverride({ ptyId, mode: 'desktop-fit', cols: 0, rows: 0 })
  }
  // Why: Tauri does not yet host Electron's mobile runtime, but the renderer
  // button must still release any mirrored mobile lock instead of staying stuck.
  setTerminalDriver(ptyId, { kind: 'desktop' })
  return { restored: hadFitOverride || previousDriver.kind === 'mobile' }
}

async function reclaimTauriBrowserForDesktop(
  browserPageId: string
): Promise<{ reclaimed: boolean }> {
  const previousDriver = getBrowserDriver(browserPageId)
  // Why: mirrors Electron reclaimBrowserForDesktop so the lock overlay can
  // unmount immediately when desktop takes the browser back.
  setBrowserDriver(browserPageId, { kind: 'desktop' })
  return { reclaimed: previousDriver.kind === 'mobile' }
}

function subscribeToSet<TEvent>(
  listeners: Set<(event: TEvent) => void>,
  callback: (event: TEvent) => void
): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

function emitToSet<TEvent>(listeners: Set<(event: TEvent) => void>, event: TEvent): void {
  for (const listener of listeners) {
    listener(event)
  }
}

function toConnectionParams(params: unknown): { connectionId: string } {
  const connectionId =
    typeof params === 'object' && params !== null && 'connectionId' in params
      ? String(params.connectionId)
      : ''
  return { connectionId }
}

function toOrderedIds(params: unknown): string[] {
  if (typeof params !== 'object' || params === null) {
    return []
  }
  const orderedIds = (params as Record<string, unknown>).orderedIds
  return Array.isArray(orderedIds)
    ? orderedIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : []
}

function noopUnsubscribe(): void {}

function noopSendBinary(_bytes: Uint8Array<ArrayBufferLike>): void {}
