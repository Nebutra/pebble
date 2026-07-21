import type {
  ClaudeUsageDailyPoint,
  ClaudeUsageScanState,
  ClaudeUsageSummary
} from '../../../../shared/claude-usage-types'
import type {
  CodexUsageDailyPoint,
  CodexUsageScanState,
  CodexUsageSummary
} from '../../../../shared/codex-usage-types'
import type {
  OpenCodeUsageDailyPoint,
  OpenCodeUsageScanState,
  OpenCodeUsageSummary
} from '../../../../shared/opencode-usage-types'
import { translate } from '@/i18n/i18n'
import {
  buildUsageDailyProjection,
  getClaudeDailyTotal,
  getRecentUsageDays,
  type UsageOverviewDailyPoint
} from './usage-daily-projection'

export { getRecentUsageDays, type UsageOverviewDailyPoint }

export type UsageProviderId = 'claude' | 'codex' | 'opencode'

export type UsageProviderOverview = {
  id: UsageProviderId
  label: string
  enabled: boolean
  isScanning: boolean
  hasData: boolean
  lastScanCompletedAt: number | null
  lastScanError: string | null
  sessions: number
  activityLabel: 'turns' | 'events'
  activityCount: number
  totalTokens: number
  newInputTokens: number
  outputTokens: number
  cacheTokens: number
  reasoningTokens: number
  estimatedCostUsd: number | null
  topModel: string | null
  topProject: string | null
  activeDays: number
}

export type UsageOverviewModel = {
  providers: UsageProviderOverview[]
  enabledProviderCount: number
  dataProviderCount: number
  hasAnyEnabledProvider: boolean
  hasAnyData: boolean
  totalTokens: number
  newInputTokens: number
  outputTokens: number
  cacheTokens: number
  reasoningTokens: number
  sessions: number
  activityCount: number
  activeDays: number
  estimatedCostUsd: number | null
  hasPartialCost: boolean
  cacheShare: number | null
  daily: UsageOverviewDailyPoint[]
  bestDay: UsageOverviewDailyPoint | null
  lastUpdatedAt: number | null
}

export type UsageOverviewInput = {
  claude: {
    scanState: ClaudeUsageScanState | null
    summary: ClaudeUsageSummary | null
    daily: ClaudeUsageDailyPoint[]
  }
  codex: {
    scanState: CodexUsageScanState | null
    summary: CodexUsageSummary | null
    daily: CodexUsageDailyPoint[]
  }
  opencode: {
    scanState: OpenCodeUsageScanState | null
    summary: OpenCodeUsageSummary | null
    daily: OpenCodeUsageDailyPoint[]
  }
}

function getCodexNewInputTokens(summary: CodexUsageSummary | null): number {
  if (!summary) {
    return 0
  }
  return Math.max(summary.inputTokens - summary.cachedInputTokens, 0)
}

function getOpenCodeNewInputTokens(summary: OpenCodeUsageSummary | null): number {
  if (!summary) {
    return 0
  }
  return Math.max(summary.inputTokens - summary.cachedInputTokens, 0)
}

function countActiveDays(days: string[]): number {
  return new Set(days).size
}

function createClaudeProvider(input: UsageOverviewInput['claude']): UsageProviderOverview {
  const summary = input.summary
  const dailyActiveDays = input.daily
    .filter((entry) => getClaudeDailyTotal(entry) > 0)
    .map((entry) => entry.day)
  return {
    id: 'claude',
    label: translate('auto.components.stats.usage.overview.model.544d6d4c16', 'Claude'),
    enabled: input.scanState?.enabled ?? false,
    isScanning: input.scanState?.isScanning ?? false,
    hasData: summary?.hasAnyClaudeData ?? input.scanState?.hasAnyClaudeData ?? false,
    lastScanCompletedAt: input.scanState?.lastScanCompletedAt ?? null,
    lastScanError: input.scanState?.lastScanError ?? null,
    sessions: summary?.sessions ?? 0,
    activityLabel: 'turns',
    activityCount: summary?.turns ?? 0,
    totalTokens: summary
      ? summary.inputTokens +
        summary.outputTokens +
        summary.cacheReadTokens +
        summary.cacheWriteTokens
      : 0,
    newInputTokens: summary?.inputTokens ?? 0,
    outputTokens: summary?.outputTokens ?? 0,
    cacheTokens: summary ? summary.cacheReadTokens + summary.cacheWriteTokens : 0,
    reasoningTokens: 0,
    estimatedCostUsd: summary?.estimatedCostUsd ?? null,
    topModel: summary?.topModel ?? null,
    topProject: summary?.topProject ?? null,
    activeDays: countActiveDays(dailyActiveDays)
  }
}

function createCodexProvider(input: UsageOverviewInput['codex']): UsageProviderOverview {
  const summary = input.summary
  const dailyActiveDays = input.daily
    .filter((entry) => entry.totalTokens > 0)
    .map((entry) => entry.day)
  return {
    id: 'codex',
    label: translate('auto.components.stats.usage.overview.model.eb220d193b', 'Codex'),
    enabled: input.scanState?.enabled ?? false,
    isScanning: input.scanState?.isScanning ?? false,
    hasData: summary?.hasAnyCodexData ?? input.scanState?.hasAnyCodexData ?? false,
    lastScanCompletedAt: input.scanState?.lastScanCompletedAt ?? null,
    lastScanError: input.scanState?.lastScanError ?? null,
    sessions: summary?.sessions ?? 0,
    activityLabel: 'events',
    activityCount: summary?.events ?? 0,
    totalTokens: summary?.totalTokens ?? 0,
    newInputTokens: getCodexNewInputTokens(summary),
    outputTokens: summary?.outputTokens ?? 0,
    cacheTokens: summary?.cachedInputTokens ?? 0,
    reasoningTokens: summary?.reasoningOutputTokens ?? 0,
    estimatedCostUsd: summary?.estimatedCostUsd ?? null,
    topModel: summary?.topModel ?? null,
    topProject: summary?.topProject ?? null,
    activeDays: countActiveDays(dailyActiveDays)
  }
}

function createOpenCodeProvider(input: UsageOverviewInput['opencode']): UsageProviderOverview {
  const summary = input.summary
  const dailyActiveDays = input.daily
    .filter((entry) => entry.totalTokens > 0)
    .map((entry) => entry.day)
  return {
    id: 'opencode',
    label: translate('auto.components.stats.usage.overview.model.bc474051e5', 'OpenCode'),
    enabled: input.scanState?.enabled ?? false,
    isScanning: input.scanState?.isScanning ?? false,
    hasData: summary?.hasAnyOpenCodeData ?? input.scanState?.hasAnyOpenCodeData ?? false,
    lastScanCompletedAt: input.scanState?.lastScanCompletedAt ?? null,
    lastScanError: input.scanState?.lastScanError ?? null,
    sessions: summary?.sessions ?? 0,
    activityLabel: 'events',
    activityCount: summary?.events ?? 0,
    totalTokens: summary?.totalTokens ?? 0,
    newInputTokens: getOpenCodeNewInputTokens(summary),
    outputTokens: summary?.outputTokens ?? 0,
    cacheTokens: summary?.cachedInputTokens ?? 0,
    reasoningTokens: summary?.reasoningOutputTokens ?? 0,
    estimatedCostUsd: summary?.estimatedCostUsd ?? null,
    topModel: summary?.topModel ?? null,
    topProject: summary?.topProject ?? null,
    activeDays: countActiveDays(dailyActiveDays)
  }
}

export function buildUsageOverview(input: UsageOverviewInput): UsageOverviewModel {
  const providers = [
    createClaudeProvider(input.claude),
    createCodexProvider(input.codex),
    createOpenCodeProvider(input.opencode)
  ]
  const daily = buildUsageDailyProjection({
    claude: input.claude.daily,
    codex: input.codex.daily,
    opencode: input.opencode.daily
  })
  const bestDay =
    daily.length === 0
      ? null
      : daily.reduce<UsageOverviewDailyPoint | null>(
          (best, entry) => (!best || entry.totalTokens > best.totalTokens ? entry : best),
          null
        )
  const totalTokens = providers.reduce((sum, provider) => sum + provider.totalTokens, 0)
  const newInputTokens = providers.reduce((sum, provider) => sum + provider.newInputTokens, 0)
  const outputTokens = providers.reduce((sum, provider) => sum + provider.outputTokens, 0)
  const cacheTokens = providers.reduce((sum, provider) => sum + provider.cacheTokens, 0)
  const reasoningTokens = providers.reduce((sum, provider) => sum + provider.reasoningTokens, 0)
  const sessions = providers.reduce((sum, provider) => sum + provider.sessions, 0)
  const activityCount = providers.reduce((sum, provider) => sum + provider.activityCount, 0)
  const knownCost = providers.reduce((sum, provider) => sum + (provider.estimatedCostUsd ?? 0), 0)
  const hasKnownCost = providers.some((provider) => provider.estimatedCostUsd !== null)
  const hasPartialCost = providers.some(
    (provider) => provider.hasData && provider.estimatedCostUsd === null
  )
  const lastUpdatedAt =
    providers.reduce<number | null>(
      (latest, provider) =>
        provider.lastScanCompletedAt && (!latest || provider.lastScanCompletedAt > latest)
          ? provider.lastScanCompletedAt
          : latest,
      null
    ) ?? null

  return {
    providers,
    enabledProviderCount: providers.filter((provider) => provider.enabled).length,
    dataProviderCount: providers.filter((provider) => provider.hasData).length,
    hasAnyEnabledProvider: providers.some((provider) => provider.enabled),
    hasAnyData: providers.some((provider) => provider.hasData),
    totalTokens,
    newInputTokens,
    outputTokens,
    cacheTokens,
    reasoningTokens,
    sessions,
    activityCount,
    activeDays: countActiveDays(
      daily.filter((entry) => entry.totalTokens > 0).map((entry) => entry.day)
    ),
    estimatedCostUsd: hasKnownCost ? knownCost : null,
    hasPartialCost,
    cacheShare:
      newInputTokens + cacheTokens > 0 ? cacheTokens / (newInputTokens + cacheTokens) : null,
    daily,
    bestDay,
    lastUpdatedAt
  }
}

export function formatUsageTokens(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`
  }
  return value.toLocaleString()
}

export function formatUsageCost(value: number | null): string {
  if (value === null) {
    return 'n/a'
  }
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}
