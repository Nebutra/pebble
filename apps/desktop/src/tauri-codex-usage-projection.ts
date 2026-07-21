import type {
  CodexUsageBreakdownKind,
  CodexUsageBreakdownRow,
  CodexUsageRange,
  CodexUsageScope,
  CodexUsageSnapshot
} from '../../../packages/product-core/shared/codex-usage-types'
import { estimateCodexCostUsd } from './tauri-codex-usage-pricing'

export type NativeCodexEvent = {
  sessionId: string
  timestamp: string
  cwd?: string
  model?: string
  day: string
  projectKey: string
  projectLabel: string
  repoId?: string
  worktreeId?: string
  hasInferredPricing: boolean
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type NativeCodexSnapshot = {
  scanState: CodexUsageSnapshot['scanState']
  events: NativeCodexEvent[]
}

type TokenTotals = {
  events: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  hasInferredPricing: boolean
}

function emptyTotals(): TokenTotals {
  return {
    events: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    hasInferredPricing: false
  }
}

function addEvent(totals: TokenTotals, event: NativeCodexEvent): void {
  totals.events++
  totals.inputTokens += event.inputTokens
  totals.cachedInputTokens += event.cachedInputTokens
  totals.outputTokens += event.outputTokens
  totals.reasoningOutputTokens += event.reasoningOutputTokens
  totals.totalTokens += event.totalTokens
  totals.hasInferredPricing ||= event.hasInferredPricing
}

function rangeCutoff(range: CodexUsageRange): string | null {
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

function filterEvents(
  events: NativeCodexEvent[],
  scope: CodexUsageScope,
  range: CodexUsageRange
): NativeCodexEvent[] {
  const cutoff = rangeCutoff(range)
  return events.filter(
    (event) => (!cutoff || event.day >= cutoff) && (scope === 'all' || !!event.worktreeId)
  )
}

function buildBreakdown(
  events: NativeCodexEvent[],
  kind: CodexUsageBreakdownKind
): CodexUsageBreakdownRow[] {
  const rows = new Map<string, CodexUsageBreakdownRow>()
  const sessionIds = new Map<string, Set<string>>()
  for (const event of events) {
    const key = kind === 'model' ? (event.model ?? 'unknown') : event.projectKey
    const label = kind === 'model' ? (event.model ?? 'Unknown model') : event.projectLabel
    const row = rows.get(key) ?? {
      key,
      label,
      sessions: 0,
      ...emptyTotals(),
      estimatedCostUsd: null
    }
    addEvent(row, event)
    rows.set(key, row)
    const ids = sessionIds.get(key) ?? new Set<string>()
    ids.add(event.sessionId)
    sessionIds.set(key, ids)
  }
  for (const [key, row] of rows) {
    row.sessions = sessionIds.get(key)?.size ?? 0
    row.estimatedCostUsd = estimateCodexCostUsd(
      kind === 'model' ? key : null,
      row.inputTokens,
      row.cachedInputTokens,
      row.outputTokens
    )
    if (kind === 'project') {
      const projectEvents = events.filter((event) => event.projectKey === key)
      const byModel = new Map<string, TokenTotals>()
      for (const event of projectEvents) {
        const model = event.model ?? 'unknown'
        const totals = byModel.get(model) ?? emptyTotals()
        addEvent(totals, event)
        byModel.set(model, totals)
      }
      const costs = [...byModel].map(([model, totals]) =>
        estimateCodexCostUsd(
          model,
          totals.inputTokens,
          totals.cachedInputTokens,
          totals.outputTokens
        )
      )
      row.estimatedCostUsd = costs.some((cost) => cost !== null)
        ? costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0)
        : null
    }
  }
  return [...rows.values()].sort((left, right) => right.totalTokens - left.totalTokens)
}

function buildRecentSessions(events: NativeCodexEvent[], limit: number) {
  const sessions = new Map<
    string,
    {
      first: string
      last: string
      model: string | null
      locations: Map<string, TokenTotals & { label: string }>
    }
  >()
  for (const event of events) {
    const session = sessions.get(event.sessionId) ?? {
      first: event.timestamp,
      last: event.timestamp,
      model: null,
      locations: new Map()
    }
    if (event.timestamp < session.first) {
      session.first = event.timestamp
    }
    if (event.timestamp >= session.last) {
      session.last = event.timestamp
      session.model = event.model ?? session.model
    }
    const location = session.locations.get(event.projectKey) ?? {
      ...emptyTotals(),
      label: event.projectLabel
    }
    addEvent(location, event)
    session.locations.set(event.projectKey, location)
    sessions.set(event.sessionId, session)
  }
  return [...sessions.entries()]
    .sort((left, right) => right[1].last.localeCompare(left[1].last))
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map(([sessionId, session]) => {
      const locations = [...session.locations.values()]
      const totals = locations.reduce((sum, location) => {
        sum.events += location.events
        sum.inputTokens += location.inputTokens
        sum.cachedInputTokens += location.cachedInputTokens
        sum.outputTokens += location.outputTokens
        sum.reasoningOutputTokens += location.reasoningOutputTokens
        sum.totalTokens += location.totalTokens
        sum.hasInferredPricing ||= location.hasInferredPricing
        return sum
      }, emptyTotals())
      return {
        sessionId,
        lastActiveAt: session.last,
        durationMinutes: Math.max(
          0,
          Math.round((Date.parse(session.last) - Date.parse(session.first)) / 60_000)
        ),
        projectLabel:
          locations.length === 1
            ? locations[0].label
            : locations.length > 1
              ? 'Multiple locations'
              : 'Unknown location',
        model: session.model,
        ...totals
      }
    })
}

export function projectCodexUsage(
  native: NativeCodexSnapshot,
  scope: CodexUsageScope,
  range: CodexUsageRange,
  limit = 10
): CodexUsageSnapshot {
  const events = filterEvents(native.events, scope, range)
  const modelBreakdown = buildBreakdown(events, 'model')
  const projectBreakdown = buildBreakdown(events, 'project')
  const totals = events.reduce((sum, event) => {
    addEvent(sum, event)
    return sum
  }, emptyTotals())
  const byDay = new Map<string, ReturnType<typeof emptyTotals> & { day: string }>()
  for (const event of events) {
    const day = byDay.get(event.day) ?? { day: event.day, ...emptyTotals() }
    addEvent(day, event)
    byDay.set(event.day, day)
  }
  const estimatedCosts = modelBreakdown.map((row) => row.estimatedCostUsd)
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
      estimatedCostUsd: estimatedCosts.some((cost) => cost !== null)
        ? estimatedCosts.reduce<number>((sum, cost) => sum + (cost ?? 0), 0)
        : null,
      topModel: modelBreakdown[0]?.label ?? null,
      topProject: projectBreakdown[0]?.label ?? null,
      hasAnyCodexData: events.length > 0
    },
    daily: [...byDay.values()]
      .sort((left, right) => left.day.localeCompare(right.day))
      .map(
        ({
          day,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          reasoningOutputTokens,
          totalTokens
        }) => ({
          day,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          reasoningOutputTokens,
          totalTokens
        })
      ),
    modelBreakdown,
    projectBreakdown,
    recentSessions: buildRecentSessions(events, limit)
  }
}
