import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type {
  ClaudeUsageRange,
  ClaudeUsageScope,
  ClaudeUsageSnapshot
} from '../../../packages/product-core/shared/claude-usage-types'
import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { buildBreakdown, cost } from './claude-usage-cost-breakdown'

export type Turn = {
  sessionId: string
  timestamp: string
  model?: string
  gitBranch?: string
  day: string
  projectKey: string
  projectLabel: string
  repoId?: string
  worktreeId?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}
type NativeSnapshot = { scanState: ClaudeUsageSnapshot['scanState']; turns: Turn[] }

async function get<T>(path: string): Promise<T> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<T>(path, { method: 'GET' })
}
async function post<T>(path: string, body: unknown): Promise<T> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<T>(path, { method: 'POST', body })
}

function cutoff(range: ClaudeUsageRange): string | null {
  if (range === 'all') {
    return null
  }
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - { '7d': 6, '30d': 29, '90d': 89 }[range])
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-')
}

function filtered(turns: Turn[], scope: ClaudeUsageScope, range: ClaudeUsageRange): Turn[] {
  const from = cutoff(range)
  return turns.filter(
    (turn) => (!from || turn.day >= from) && (scope === 'all' || !!turn.worktreeId)
  )
}

function sessions(turns: Turn[]) {
  const rows = new Map<
    string,
    {
      first: string
      last: string
      model: string | null
      branch: string | null
      locations: Map<
        string,
        { label: string; turns: number; input: number; output: number; read: number; write: number }
      >
    }
  >()
  for (const turn of turns) {
    const row = rows.get(turn.sessionId) ?? {
      first: turn.timestamp,
      last: turn.timestamp,
      model: null,
      branch: null,
      locations: new Map()
    }
    if (turn.timestamp < row.first) {
      row.first = turn.timestamp
    }
    if (turn.timestamp >= row.last) {
      row.last = turn.timestamp
      row.branch = turn.gitBranch ?? null
    }
    row.model = turn.model ?? row.model
    const location = row.locations.get(turn.projectKey) ?? {
      label: turn.projectLabel,
      turns: 0,
      input: 0,
      output: 0,
      read: 0,
      write: 0
    }
    location.turns++
    location.input += turn.inputTokens
    location.output += turn.outputTokens
    location.read += turn.cacheReadTokens
    location.write += turn.cacheWriteTokens
    row.locations.set(turn.projectKey, location)
    rows.set(turn.sessionId, row)
  }
  return [...rows.entries()].sort((a, b) => b[1].last.localeCompare(a[1].last))
}

function project(
  native: NativeSnapshot,
  scope: ClaudeUsageScope,
  range: ClaudeUsageRange,
  limit = 10
): ClaudeUsageSnapshot {
  const turns = filtered(native.turns, scope, range)
  const grouped = sessions(turns)
  let input = 0,
    output = 0,
    read = 0,
    write = 0,
    zero = 0,
    estimated = 0,
    priced = false
  const byDay = new Map<string, ClaudeUsageSnapshot['daily'][number]>()
  const byModel = new Map<string, number>()
  const byProject = new Map<string, number>()
  for (const turn of turns) {
    input += turn.inputTokens
    output += turn.outputTokens
    read += turn.cacheReadTokens
    write += turn.cacheWriteTokens
    if (!turn.cacheReadTokens) {
      zero++
    }
    const amount = cost(
      turn.model,
      turn.inputTokens,
      turn.outputTokens,
      turn.cacheReadTokens,
      turn.cacheWriteTokens
    )
    if (amount !== null) {
      estimated += amount
      priced = true
    }
    byModel.set(
      turn.model ?? 'Unknown model',
      (byModel.get(turn.model ?? 'Unknown model') ?? 0) + turn.inputTokens + turn.outputTokens
    )
    byProject.set(
      turn.projectLabel,
      (byProject.get(turn.projectLabel) ?? 0) + turn.inputTokens + turn.outputTokens
    )
    const day = byDay.get(turn.day) ?? {
      day: turn.day,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    }
    day.inputTokens += turn.inputTokens
    day.outputTokens += turn.outputTokens
    day.cacheReadTokens += turn.cacheReadTokens
    day.cacheWriteTokens += turn.cacheWriteTokens
    byDay.set(turn.day, day)
  }
  const recentSessions = grouped
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map(([sessionId, row]) => {
      const locations = [...row.locations.values()]
      const totals = locations.reduce(
        (sum, value) => ({
          turns: sum.turns + value.turns,
          input: sum.input + value.input,
          output: sum.output + value.output,
          read: sum.read + value.read,
          write: sum.write + value.write
        }),
        { turns: 0, input: 0, output: 0, read: 0, write: 0 }
      )
      return {
        sessionId,
        lastActiveAt: row.last,
        durationMinutes: Math.max(
          0,
          Math.round((Date.parse(row.last) - Date.parse(row.first)) / 60_000)
        ),
        projectLabel:
          locations.length === 1
            ? locations[0].label
            : locations.length > 1
              ? 'Multiple locations'
              : 'Unknown location',
        branch: row.branch,
        model: row.model,
        turns: totals.turns,
        inputTokens: totals.input,
        outputTokens: totals.output,
        cacheReadTokens: totals.read,
        cacheWriteTokens: totals.write
      }
    })
  const top = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  return {
    scanState: native.scanState,
    summary: {
      scope,
      range,
      sessions: grouped.length,
      turns: turns.length,
      zeroCacheReadTurns: zero,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      cacheReuseRate: input + read ? read / (input + read) : null,
      estimatedCostUsd: priced ? estimated : null,
      topModel: top(byModel),
      topProject: top(byProject),
      hasAnyClaudeData: turns.length > 0
    },
    daily: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    modelBreakdown: buildBreakdown(turns, 'model'),
    projectBreakdown: buildBreakdown(turns, 'project'),
    recentSessions
  }
}

async function nativeSnapshot(force = false): Promise<NativeSnapshot> {
  return post('/v1/usage/claude/snapshot', { force })
}
export function createPebbleClaudeUsageApi(): PreloadApi['claudeUsage'] {
  return {
    getScanState: () => get('/v1/usage/claude/state'),
    setEnabled: ({ enabled }) => post('/v1/usage/claude/state', { enabled }),
    refresh: async ({ force } = {}) => (await nativeSnapshot(force)).scanState,
    getSnapshot: async ({ scope, range, limit }) =>
      project(await nativeSnapshot(), scope, range, limit),
    getSummary: async ({ scope, range }) => project(await nativeSnapshot(), scope, range).summary,
    getDaily: async ({ scope, range }) => project(await nativeSnapshot(), scope, range).daily,
    getBreakdown: async ({ scope, range, kind }) =>
      project(await nativeSnapshot(), scope, range)[
        kind === 'model' ? 'modelBreakdown' : 'projectBreakdown'
      ],
    getRecentSessions: async ({ scope, range, limit }) =>
      project(await nativeSnapshot(), scope, range, limit).recentSessions
  }
}
