import type { ClaudeUsageDailyPoint } from '../../../../shared/claude-usage-types'
import type { CodexUsageDailyPoint } from '../../../../shared/codex-usage-types'
import type { OpenCodeUsageDailyPoint } from '../../../../shared/opencode-usage-types'

export type UsageOverviewDailyPoint = {
  day: string
  totalTokens: number
  claudeTokens: number
  codexTokens: number
  openCodeTokens: number
  intensity: 0 | 1 | 2 | 3 | 4
}

type DailyProjectionInput = {
  claude: ClaudeUsageDailyPoint[]
  codex: CodexUsageDailyPoint[]
  opencode: OpenCodeUsageDailyPoint[]
}

type DailyTokenTotals = Omit<UsageOverviewDailyPoint, 'intensity'>

export function getClaudeDailyTotal(entry: ClaudeUsageDailyPoint): number {
  return entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens
}

function getIntensity(totalTokens: number, maxTokens: number): 0 | 1 | 2 | 3 | 4 {
  if (totalTokens <= 0 || maxTokens <= 0) {
    return 0
  }
  const ratio = totalTokens / maxTokens
  if (ratio <= 0.25) {
    return 1
  }
  if (ratio <= 0.5) {
    return 2
  }
  if (ratio <= 0.75) {
    return 3
  }
  return 4
}

function isSortedByDay(entries: readonly { day: string }[]): boolean {
  for (let index = 1; index < entries.length; index++) {
    if (entries[index - 1].day.localeCompare(entries[index].day) > 0) {
      return false
    }
  }
  return true
}

function createEmptyTotals(day: string): DailyTokenTotals {
  return {
    day,
    totalTokens: 0,
    claudeTokens: 0,
    codexTokens: 0,
    openCodeTokens: 0
  }
}

function getNextDay(input: DailyProjectionInput, indexes: readonly number[]): string | null {
  const claudeDay = input.claude[indexes[0]]?.day ?? null
  const codexDay = input.codex[indexes[1]]?.day ?? null
  const openCodeDay = input.opencode[indexes[2]]?.day ?? null
  let nextDay = claudeDay
  if (codexDay !== null && (nextDay === null || codexDay.localeCompare(nextDay) < 0)) {
    nextDay = codexDay
  }
  if (openCodeDay !== null && (nextDay === null || openCodeDay.localeCompare(nextDay) < 0)) {
    nextDay = openCodeDay
  }
  return nextDay
}

function mergeSortedDailyTotals(input: DailyProjectionInput): DailyTokenTotals[] {
  const result: DailyTokenTotals[] = []
  const indexes: [number, number, number] = [0, 0, 0]
  let day = getNextDay(input, indexes)

  while (day !== null) {
    const totals = createEmptyTotals(day)
    while (input.claude[indexes[0]]?.day === day) {
      const tokens = getClaudeDailyTotal(input.claude[indexes[0]])
      totals.totalTokens += tokens
      totals.claudeTokens += tokens
      indexes[0]++
    }
    while (input.codex[indexes[1]]?.day === day) {
      const tokens = input.codex[indexes[1]].totalTokens
      totals.totalTokens += tokens
      totals.codexTokens += tokens
      indexes[1]++
    }
    while (input.opencode[indexes[2]]?.day === day) {
      const tokens = input.opencode[indexes[2]].totalTokens
      totals.totalTokens += tokens
      totals.openCodeTokens += tokens
      indexes[2]++
    }
    result.push(totals)
    day = getNextDay(input, indexes)
  }

  return result
}

function aggregateAndSortDailyTotals(input: DailyProjectionInput): DailyTokenTotals[] {
  const byDay = new Map<string, DailyTokenTotals>()
  const getTotals = (day: string): DailyTokenTotals => {
    const current = byDay.get(day) ?? createEmptyTotals(day)
    byDay.set(day, current)
    return current
  }

  for (const entry of input.claude) {
    const totals = getTotals(entry.day)
    const tokens = getClaudeDailyTotal(entry)
    totals.totalTokens += tokens
    totals.claudeTokens += tokens
  }
  for (const entry of input.codex) {
    const totals = getTotals(entry.day)
    totals.totalTokens += entry.totalTokens
    totals.codexTokens += entry.totalTokens
  }
  for (const entry of input.opencode) {
    const totals = getTotals(entry.day)
    totals.totalTokens += entry.totalTokens
    totals.openCodeTokens += entry.totalTokens
  }

  return [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day))
}

export function buildUsageDailyProjection(input: DailyProjectionInput): UsageOverviewDailyPoint[] {
  // Why: usage stores guarantee sorted daily snapshots, making the common projection linear.
  // Keep the old aggregation semantics for defensive callers that violate that contract.
  const totals =
    isSortedByDay(input.claude) && isSortedByDay(input.codex) && isSortedByDay(input.opencode)
      ? mergeSortedDailyTotals(input)
      : aggregateAndSortDailyTotals(input)
  let maxTokens = 0
  for (const entry of totals) {
    maxTokens = Math.max(maxTokens, entry.totalTokens)
  }
  return totals.map((entry) => ({
    ...entry,
    intensity: getIntensity(entry.totalTokens, maxTokens)
  }))
}

function formatLocalDay(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function getRecentUsageDays(
  daily: UsageOverviewDailyPoint[],
  dayCount: number,
  anchorDate = new Date()
): UsageOverviewDailyPoint[] {
  const byDay = new Map(daily.map((entry) => [entry.day, entry]))
  const count = Math.max(1, Math.floor(dayCount))
  const end = new Date(anchorDate)
  end.setHours(0, 0, 0, 0)

  const result: UsageOverviewDailyPoint[] = []
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(end)
    date.setDate(end.getDate() - offset)
    const day = formatLocalDay(date)
    result.push(
      byDay.get(day) ?? {
        day,
        totalTokens: 0,
        claudeTokens: 0,
        codexTokens: 0,
        openCodeTokens: 0,
        intensity: 0
      }
    )
  }
  return result
}
