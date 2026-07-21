import type {
  OpenCodeUsageBreakdownKind,
  OpenCodeUsageBreakdownRow,
  OpenCodeUsageRange,
  OpenCodeUsageScope,
  OpenCodeUsageSnapshot
} from '../../../packages/product-core/shared/opencode-usage-types'

export type NativeOpenCodeEvent = {
  sessionId: string
  timestamp: string
  cwd?: string
  model?: string
  day: string
  projectKey: string
  projectLabel: string
  repoId?: string
  worktreeId?: string
  estimatedCostUsd: number | null
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type NativeOpenCodeSnapshot = {
  scanState: OpenCodeUsageSnapshot['scanState']
  events: NativeOpenCodeEvent[]
}

type Totals = {
  events: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  estimatedCostUsd: number | null
}

function emptyTotals(): Totals {
  return {
    events: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null
  }
}

function addEvent(totals: Totals, event: NativeOpenCodeEvent): void {
  totals.events++
  totals.inputTokens += event.inputTokens
  totals.cachedInputTokens += event.cachedInputTokens
  totals.outputTokens += event.outputTokens
  totals.reasoningOutputTokens += event.reasoningOutputTokens
  totals.totalTokens += event.totalTokens
  if (event.estimatedCostUsd !== null) {
    totals.estimatedCostUsd = (totals.estimatedCostUsd ?? 0) + event.estimatedCostUsd
  }
}

function cutoff(range: OpenCodeUsageRange): string | null {
  if (range === 'all') {
    return null
  }
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - ({ '7d': 7, '30d': 30, '90d': 90 }[range] - 1))
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-')
}

function filtered(
  events: NativeOpenCodeEvent[],
  scope: OpenCodeUsageScope,
  range: OpenCodeUsageRange
): NativeOpenCodeEvent[] {
  const from = cutoff(range)
  return events.filter(
    (event) => (!from || event.day >= from) && (scope === 'all' || !!event.worktreeId)
  )
}

function breakdown(
  events: NativeOpenCodeEvent[],
  kind: OpenCodeUsageBreakdownKind
): OpenCodeUsageBreakdownRow[] {
  const rows = new Map<string, OpenCodeUsageBreakdownRow>()
  const sessions = new Map<string, Set<string>>()
  for (const event of events) {
    const key = kind === 'model' ? (event.model ?? 'unknown') : event.projectKey
    const label = kind === 'model' ? (event.model ?? 'Unknown model') : event.projectLabel
    const row = rows.get(key) ?? { key, label, sessions: 0, ...emptyTotals() }
    addEvent(row, event)
    rows.set(key, row)
    const ids = sessions.get(key) ?? new Set<string>()
    ids.add(event.sessionId)
    sessions.set(key, ids)
  }
  for (const [key, row] of rows) {
    row.sessions = sessions.get(key)?.size ?? 0
  }
  return [...rows.values()].sort((left, right) => right.totalTokens - left.totalTokens)
}

function recentSessions(events: NativeOpenCodeEvent[], limit: number) {
  const sessions = new Map<
    string,
    {
      first: string
      last: string
      models: Map<string, number>
      labels: Map<string, number>
      totals: Totals
    }
  >()
  for (const event of events) {
    const session = sessions.get(event.sessionId) ?? {
      first: event.timestamp,
      last: event.timestamp,
      models: new Map<string, number>(),
      labels: new Map<string, number>(),
      totals: emptyTotals()
    }
    if (event.timestamp < session.first) {
      session.first = event.timestamp
    }
    if (event.timestamp >= session.last) {
      session.last = event.timestamp
    }
    if (event.model) {
      session.models.set(event.model, (session.models.get(event.model) ?? 0) + event.totalTokens)
    }
    session.labels.set(
      event.projectLabel,
      (session.labels.get(event.projectLabel) ?? 0) + event.totalTokens
    )
    addEvent(session.totals, event)
    sessions.set(event.sessionId, session)
  }
  return [...sessions.entries()]
    .sort((left, right) => right[1].last.localeCompare(left[1].last))
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map(([sessionId, session]) => ({
      sessionId,
      lastActiveAt: session.last,
      durationMinutes: Math.max(
        0,
        Math.round((Date.parse(session.last) - Date.parse(session.first)) / 60_000)
      ),
      projectLabel: topWeightedLabel(session.labels) ?? 'Unknown location',
      model: topWeightedLabel(session.models),
      events: session.totals.events,
      inputTokens: session.totals.inputTokens,
      cachedInputTokens: session.totals.cachedInputTokens,
      outputTokens: session.totals.outputTokens,
      reasoningOutputTokens: session.totals.reasoningOutputTokens,
      totalTokens: session.totals.totalTokens
    }))
}

function topWeightedLabel(values: Map<string, number>): string | null {
  return [...values].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
}

export function projectOpenCodeUsage(
  native: NativeOpenCodeSnapshot,
  scope: OpenCodeUsageScope,
  range: OpenCodeUsageRange,
  limit = 10
): OpenCodeUsageSnapshot {
  const events = filtered(native.events, scope, range)
  const totals = events.reduce((sum, event) => {
    addEvent(sum, event)
    return sum
  }, emptyTotals())
  const modelBreakdown = breakdown(events, 'model')
  const projectBreakdown = breakdown(events, 'project')
  const days = new Map<string, Totals>()
  for (const event of events) {
    const day = days.get(event.day) ?? emptyTotals()
    addEvent(day, event)
    days.set(event.day, day)
  }
  return {
    scanState: native.scanState,
    summary: {
      scope,
      range,
      sessions: new Set(events.map((event) => event.sessionId)).size,
      events: totals.events,
      inputTokens: totals.inputTokens,
      cachedInputTokens: totals.cachedInputTokens,
      outputTokens: totals.outputTokens,
      reasoningOutputTokens: totals.reasoningOutputTokens,
      totalTokens: totals.totalTokens,
      estimatedCostUsd: totals.estimatedCostUsd,
      topModel: modelBreakdown[0]?.label ?? null,
      topProject: projectBreakdown[0]?.label ?? null,
      hasAnyOpenCodeData: events.length > 0
    },
    daily: [...days]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([day, totals]) => ({
        day,
        inputTokens: totals.inputTokens,
        cachedInputTokens: totals.cachedInputTokens,
        outputTokens: totals.outputTokens,
        reasoningOutputTokens: totals.reasoningOutputTokens,
        totalTokens: totals.totalTokens
      })),
    modelBreakdown,
    projectBreakdown,
    recentSessions: recentSessions(events, limit)
  }
}
