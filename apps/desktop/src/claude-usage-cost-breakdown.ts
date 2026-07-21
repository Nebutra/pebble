import type {
  ClaudeUsageBreakdownKind,
  ClaudeUsageBreakdownRow
} from '../../../packages/product-core/shared/claude-usage-types'
import type { Turn } from './tauri-claude-usage-api'

const PRICES: Record<string, [number, number, number, number]> = {
  'claude-opus-4-8': [5, 25, 0.5, 6.25],
  'claude-opus-4-7': [5, 25, 0.5, 6.25],
  'claude-opus-4-6': [5, 25, 0.5, 6.25],
  'claude-opus-4-5': [5, 25, 0.5, 6.25],
  'claude-opus-4-1': [15, 75, 1.5, 18.75],
  'claude-opus-4': [15, 75, 1.5, 18.75],
  'claude-sonnet-4-6': [3, 15, 0.3, 3.75],
  'claude-sonnet-4-5': [3, 15, 0.3, 3.75],
  'claude-sonnet-4': [3, 15, 0.3, 3.75],
  'claude-sonnet-3-7': [3, 15, 0.3, 3.75],
  'claude-sonnet-3-5': [3, 15, 0.3, 3.75],
  'claude-haiku-4-5': [1, 5, 0.1, 1.25],
  'claude-haiku-3-5': [0.8, 4, 0.08, 1],
  'claude-haiku-3': [0.25, 1.25, 0.03, 0.3]
}

function modelKey(model?: string): string {
  return (model ?? '')
    .toLowerCase()
    .trim()
    .replace(/\.([0-9])/g, '-$1')
    .replace(/-thinking$/, '')
}

export function cost(
  model: string | undefined,
  input: number,
  output: number,
  read: number,
  write: number
): number | null {
  const price = PRICES[modelKey(model)]
  return price
    ? (input * price[0] + output * price[1] + read * price[2] + write * price[3]) / 1_000_000
    : null
}

export function buildBreakdown(
  turns: Turn[],
  kind: ClaudeUsageBreakdownKind
): ClaudeUsageBreakdownRow[] {
  const rows = new Map<string, ClaudeUsageBreakdownRow>()
  const sessionKeys = new Map<string, Set<string>>()
  for (const turn of turns) {
    const key = kind === 'model' ? (turn.model ?? 'unknown') : turn.projectKey
    const label = kind === 'model' ? (turn.model ?? 'Unknown model') : turn.projectLabel
    const row = rows.get(key) ?? {
      key,
      label,
      sessions: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: null
    }
    row.turns++
    row.inputTokens += turn.inputTokens
    row.outputTokens += turn.outputTokens
    row.cacheReadTokens += turn.cacheReadTokens
    row.cacheWriteTokens += turn.cacheWriteTokens
    rows.set(key, row)
    const keys = sessionKeys.get(key) ?? new Set()
    keys.add(turn.sessionId)
    sessionKeys.set(key, keys)
  }
  for (const [key, row] of rows) {
    row.sessions = sessionKeys.get(key)?.size ?? 0
    row.estimatedCostUsd = cost(
      kind === 'model' ? key : undefined,
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens
    )
  }
  return [...rows.values()].sort(
    (a, b) => b.inputTokens + b.outputTokens - a.inputTokens - a.outputTokens
  )
}
