import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-tauri-runtime-transport'

export type RuntimeProviderSubsystem = 'browser' | 'computer' | 'emulator'
export type RuntimeSubsystemName = RuntimeProviderSubsystem | 'mobile-relay'

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

export async function readRuntimeNativeProviders(
  params: unknown
): Promise<RuntimeNativeProvider[]> {
  await ensurePebbleRuntimeProcess()
  const subsystem = readProviderSubsystem(params)
  const query = subsystem ? `?subsystem=${encodeURIComponent(subsystem)}` : ''
  return requestRuntimeJson<RuntimeNativeProvider[]>(`/v1/providers${query}`, {
    method: 'GET'
  })
}

export async function readRuntimeSubsystemStatus(params: unknown): Promise<RuntimeSubsystemStatus> {
  await ensurePebbleRuntimeProcess()
  const subsystem = readSubsystemName(params)
  return requestRuntimeJson<RuntimeSubsystemStatus>(`/v1/${subsystem}/status`, {
    method: 'GET'
  })
}

export async function registerRuntimeNativeProvider(
  params: unknown
): Promise<RuntimeNativeProvider> {
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

export function readProviderObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export function readProviderOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function readRateLimitParams(params: unknown): { force?: boolean } {
  const input = readProviderObject(params)
  return input.force === true ? { force: true } : {}
}

export function readGitLabRateLimitParams(params: unknown): {
  force?: boolean
  host?: string | null
} {
  const input = readProviderObject(params)
  const host = readProviderOptionalString(input.host)
  return { ...readRateLimitParams(input), ...(host ? { host } : {}) }
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
