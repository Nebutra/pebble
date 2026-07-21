import type { RuntimeTerminalWaitCondition } from '../../../packages/product-core/shared/runtime-types'

export type RuntimeTerminalRpcResult = {
  handled: boolean
  result?: unknown
}

export function handled(result: unknown): RuntimeTerminalRpcResult {
  return { handled: true, result }
}

export function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function readRequiredString(value: unknown, label: string): string {
  const result = readString(value)
  if (!result) {
    throw new Error(`${label} is required`)
  }
  return result
}

export function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function readCursor(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number.parseInt(value, 10)
  }
  return null
}

export function readTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
}

export function readWaitCondition(value: unknown): RuntimeTerminalWaitCondition {
  return value === 'exit' || value === 'tui-idle' ? value : 'exit'
}

export function readTerminalHandle(params: unknown): string {
  const input = readObject(params)
  return readRequiredString(input.terminal ?? input.handle ?? input.ptyId, 'terminal handle')
}

export function normalizeRuntimeWorktreeId(value: string | null): string | undefined {
  if (!value) {
    return undefined
  }
  return value.startsWith('id:') ? value.slice(3) : value
}
