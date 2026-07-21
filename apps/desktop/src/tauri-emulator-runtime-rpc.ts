import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import {
  getTauriComputerActionCursor,
  waitForTauriComputerAction
} from './tauri-computer-action-waiter'
import { setNativeEmulatorPermission } from './tauri-emulator-permissions-api'

type RuntimeEmulatorRpcResult = { handled: boolean; result?: unknown }
type RuntimeEmulatorDevice = {
  id: string
  nativeId?: string
  name: string
  platform: 'android' | 'ios'
  status: string
  runtime?: string
}
type RuntimeEmulatorSession = {
  id: string
  deviceId: string
  worktreeId?: string
  active: boolean
}
type RuntimeComputerAction = {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  result?: unknown
  error?: string
}
type EmulatorParams = {
  device?: unknown
  emulator?: unknown
  op?: unknown
  package?: unknown
  permission?: unknown
  timeoutMs?: unknown
  worktree?: unknown
  [key: string]: unknown
}

const ACTION_TIMEOUT_MS = 30_000

export async function callTauriEmulatorRuntimeRpc(
  method: string,
  params: unknown
): Promise<RuntimeEmulatorRpcResult> {
  switch (method) {
    case 'emulator.list':
      return handled(await listSessions())
    case 'emulator.listDevices':
      return handled(await listDevices())
    case 'emulator.listSimulators':
      return handled((await listDevices()).filter((device) => device.platform === 'ios'))
    case 'emulator.availability':
      return handled(toAvailability(await listDevices()))
    case 'emulator.attach':
      return handled(await attachEmulator(params))
    case 'emulator.kill':
      return handled(await detachEmulator(params, false))
    case 'emulator.unregisterActive':
      return handled(await detachEmulator(params, true))
    case 'emulator.permissions':
      return handled(await setPermission(params))
    case 'emulator.shutdown':
      return handled(await shutdownEmulator(params))
    case 'emulator.tap':
    case 'emulator.gesture':
    case 'emulator.type':
    case 'emulator.button':
    case 'emulator.rotate':
    case 'emulator.install':
    case 'emulator.launch':
    case 'emulator.logcat':
    case 'emulator.ax':
    case 'emulator.exec':
      return handled(await runEmulatorCommand(method.slice('emulator.'.length), params))
    default:
      return { handled: false }
  }
}

async function listDevices(): Promise<RuntimeEmulatorDevice[]> {
  return requestRuntimeJson<RuntimeEmulatorDevice[]>('/v1/emulator/devices', { method: 'GET' })
}

async function listSessions(): Promise<RuntimeEmulatorSession[]> {
  return requestRuntimeJson<RuntimeEmulatorSession[]>('/v1/emulator/sessions', { method: 'GET' })
}

function toAvailability(devices: RuntimeEmulatorDevice[]) {
  const rows = devices.map((device) => ({
    name: device.name,
    udid: device.nativeId ?? device.id,
    state: device.status === 'running' ? 'Booted' : device.status,
    runtime: device.platform === 'android' ? 'Android' : device.runtime,
    isAvailable: device.status !== 'error'
  }))
  const hasIos = devices.some((device) => device.platform === 'ios')
  const hasAndroid = devices.some((device) => device.platform === 'android')
  return {
    platform: navigator.userAgent.includes('Mac') ? 'darwin' : 'desktop',
    available: rows.length > 0,
    devices: rows,
    simctl: { ok: hasIos, message: hasIos ? undefined : 'No iOS Simulator is available.' },
    serveSim: { ok: hasIos, message: hasIos ? undefined : 'No iOS preview is available.' },
    android: {
      sdkFound: hasAndroid,
      message: hasAndroid ? 'Android SDK ready.' : 'No Android emulator is available.'
    },
    message: rows.length > 0 ? 'Emulator provider ready.' : 'No emulator device is available.'
  }
}

async function attachEmulator(params: unknown) {
  const input = readObject(params)
  const device = resolveDevice(
    await listDevices(),
    readString(input.device) ?? readString(input.emulator)
  )
  if (!device) {
    throw new Error('No matching emulator device is available.')
  }
  const session = await requestRuntimeJson<RuntimeEmulatorSession>('/v1/emulator/sessions', {
    method: 'POST',
    body: { deviceId: device.id, worktreeId: readString(input.worktree) }
  })
  const nativeId = device.nativeId ?? device.id
  return {
    attached: true,
    info: {
      device: nativeId,
      deviceUdid: nativeId,
      displayName: device.name,
      state: device.status,
      sessionId: session.id,
      ...(device.platform === 'android' ? { streamUrl: `scrcpy://${nativeId}` } : {})
    }
  }
}

async function runEmulatorCommand(command: string, params: unknown): Promise<unknown> {
  const input = readObject(params)
  const sessions = await listSessions()
  const session = await resolveSession(sessions, input)
  if (!session) {
    throw new Error('No matching active emulator session.')
  }
  return queueSessionCommand(session.id, command === 'logcat' ? 'logs' : command, input)
}

async function shutdownEmulator(params: unknown): Promise<unknown> {
  const input = readObject(params)
  const sessions = await listSessions()
  const session = await resolveSession(sessions, input)
  if (!session && input.managedOnly === true) {
    return { ok: true }
  }
  if (!session) {
    throw new Error('No matching active emulator session.')
  }
  const devices = await listDevices()
  const device = devices.find((candidate) => candidate.id === session.deviceId)
  const result = await queueSessionCommand(session.id, 'shutdown', input)
  await requestRuntimeJson<RuntimeEmulatorSession>(
    `/v1/emulator/sessions/${encodeURIComponent(session.id)}`,
    { method: 'DELETE' }
  )
  return {
    ...(result && typeof result === 'object' ? result : {}),
    deviceUdid: device?.nativeId ?? device?.id
  }
}

async function detachEmulator(params: unknown, allowMissing: boolean): Promise<unknown> {
  const input = readObject(params)
  const sessions = await listSessions()
  const session = await resolveSession(sessions, input)
  if (!session && allowMissing) {
    return { ok: true }
  }
  if (!session) {
    throw new Error('No matching active emulator session.')
  }
  const devices = await listDevices()
  const device = devices.find((candidate) => candidate.id === session.deviceId)
  await requestRuntimeJson<RuntimeEmulatorSession>(
    `/v1/emulator/sessions/${encodeURIComponent(session.id)}`,
    { method: 'DELETE' }
  )
  return allowMissing
    ? { ok: true }
    : { ok: true, deviceUdid: device?.nativeId ?? device?.id ?? session.deviceId }
}

async function queueSessionCommand(
  sessionId: string,
  command: string,
  payload: EmulatorParams
): Promise<unknown> {
  const actionCursor = getTauriComputerActionCursor()
  const action = await requestRuntimeJson<RuntimeComputerAction>(
    `/v1/emulator/sessions/${encodeURIComponent(sessionId)}/commands`,
    { method: 'POST', body: { command, payload } }
  )
  return waitForAction(action.id, actionCursor)
}

async function waitForAction(actionId: string, afterSequence?: number): Promise<unknown> {
  const action = await waitForTauriComputerAction({
    actionId,
    kindPrefix: 'emulator.',
    timeoutMs: ACTION_TIMEOUT_MS,
    timeoutMessage: 'Emulator command timed out.',
    afterSequence
  })
  if (action.status === 'failed') {
    throw new Error(action.error || 'Emulator command failed.')
  }
  return action.result ?? { ok: true }
}

async function setPermission(params: unknown): Promise<{ ok: true }> {
  const input = readObject(params)
  const operation = input.op
  if (operation !== 'grant' && operation !== 'revoke' && operation !== 'reset') {
    throw new Error('emulator.permissions requires op grant, revoke, or reset')
  }
  const device = resolveDevice(
    await listDevices(),
    readString(input.device) ?? readString(input.emulator)
  )
  if (!device) {
    throw new Error('No matching emulator device is available.')
  }
  if (!device.nativeId) {
    throw new Error(`Emulator device ${device.name} has no registered native identifier.`)
  }
  await setNativeEmulatorPermission({
    platform: device.platform,
    operationId: createOperationId(),
    serial: device.nativeId,
    operation,
    package: readString(input.package),
    permission: readString(input.permission),
    timeoutMs: readTimeout(input.timeoutMs)
  })
  return { ok: true }
}

function resolveDevice(devices: RuntimeEmulatorDevice[], selector?: string) {
  return selector
    ? devices.find(
        (device) =>
          device.id === selector || device.nativeId === selector || device.name === selector
      )
    : (devices.find((device) => device.status === 'running') ?? devices[0])
}

async function resolveSession(sessions: RuntimeEmulatorSession[], input: EmulatorParams) {
  const emulator = readString(input.emulator)
  const device = readString(input.device)
  const worktree = readString(input.worktree)
  let runtimeDeviceId = device
  if (device && !sessions.some((session) => session.deviceId === device)) {
    runtimeDeviceId = resolveDevice(await listDevices(), device)?.id
  }
  return sessions.find(
    (session) =>
      session.active &&
      ((emulator && (session.id === emulator || session.deviceId === emulator)) ||
        (runtimeDeviceId && session.deviceId === runtimeDeviceId) ||
        (worktree && session.worktreeId === worktree) ||
        (!emulator && !runtimeDeviceId && !worktree))
  )
}

function createOperationId(): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  return `runtime-${suffix.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

function readObject(value: unknown): EmulatorParams {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as EmulatorParams)
    : {}
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readTimeout(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function handled(result: unknown): RuntimeEmulatorRpcResult {
  return { handled: true, result }
}
