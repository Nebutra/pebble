import type {
  RuntimeMobileSessionTabMove
} from '../../../packages/product-core/shared/runtime-types'
import type { TerminalPaneLayoutNode } from '../../../packages/product-core/shared/types'
import { isTerminalPaneLayoutNode } from './tauri-session-tab-view-state-persistence'

export type RuntimeSessionStatus = 'starting' | 'running' | 'exited' | 'failed' | 'stopped'

export type RuntimeSession = {
  id: string
  projectId?: string
  worktreeId?: string
  cwd: string
  command: string[]
  agentKind?: string
  tabId?: string
  leafId?: string
  status: RuntimeSessionStatus
  updatedAt?: string
}

export type RuntimeSessionTabsRpcResult = {
  handled: boolean
  result?: unknown
}

export function handled(result: unknown): RuntimeSessionTabsRpcResult {
  return { handled: true, result }
}

export function sessionTabId(session: RuntimeSession): string {
  return session.tabId || `tab-${session.id}`
}

export function terminalTitle(session: RuntimeSession): string {
  return session.command.join(' ') || session.agentKind || 'Terminal'
}

export function publicationEpoch(): string {
  return String(Date.now())
}

export function normalizeRuntimeWorktreeId(value: string | null): string | null {
  if (!value) {
    return null
  }
  return value.startsWith('id:') ? value.slice(3) : value
}

export function readSessionTabMove(input: Record<string, unknown>): RuntimeMobileSessionTabMove {
  const kind = readRequiredString(input.kind, 'move kind')
  const base = {
    tabId: readRequiredString(input.tabId, 'tab id'),
    targetGroupId: readRequiredString(input.targetGroupId, 'target group id')
  }
  if (kind === 'reorder') {
    return { ...base, kind, tabOrder: readRequiredStringArray(input.tabOrder, 'tab order') }
  }
  if (kind === 'move-to-group') {
    return { ...base, kind, index: readNumber(input.index) }
  }
  if (kind === 'split') {
    const splitDirection = readRequiredString(input.splitDirection, 'split direction')
    if (
      splitDirection !== 'left' &&
      splitDirection !== 'right' &&
      splitDirection !== 'up' &&
      splitDirection !== 'down'
    ) {
      throw new Error('invalid_split_direction')
    }
    return { ...base, kind, splitDirection }
  }
  throw new Error('invalid_move_kind')
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

export function readNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : readString(value)
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

export function readRequiredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} is required`)
  }
  return value.map((entry) => readRequiredString(entry, label))
}

export function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      result[key] = entry
    }
  }
  return result
}

export function readPaneLayoutRoot(value: unknown): TerminalPaneLayoutNode | null {
  if (value === null || value === undefined) {
    return null
  }
  if (!isTerminalPaneLayoutNode(value)) {
    throw new Error('invalid_pane_layout')
  }
  return value
}
