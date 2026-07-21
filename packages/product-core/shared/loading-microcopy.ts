import type {
  LoadingMicrocopyContext,
  LoadingMicrocopyLocale
} from './loading-microcopy-types'
import { LOADING_MICROCOPY_BY_CONTEXT } from './loading-microcopy-context-pools'
import { LOADING_MICROCOPY_OVERRIDES } from './loading-microcopy-overrides'

export type { LoadingMicrocopyLocale }

const CONTEXT_PATTERNS: [LoadingMicrocopyContext, RegExp][] = [
  ['settings', /setting|preference|notification|wsl|runtime|theme|preset|account|distro/i],
  ['api', /api|budget|rate|token|quota/i],
  [
    'review',
    /review|reviewer|pullrequest|pull-request|\bpr\b|\bmr\b|check|comment|conflict|\bci\b|hunk/i
  ],
  ['agent', /agent|session|vault|orchestration|claude|codex/i],
  ['editor', /editor|preview|image|\bviewer\b|markdown|diff-section|content/i],
  ['file', /file|folder|explorer|quickopen|jump|target|path/i],
  ['git', /\bgit\b|branch|commit|submodule|graph|history|source-control|reflog|merge/i],
  ['project', /project|task|jira|linear|issue|ticket|\bboard\b|state|label|member|assignee/i],
  ['terminal', /terminal|shell|prompt|pty|xterm/i]
]

export const LOADING_MICROCOPY = LOADING_MICROCOPY_BY_CONTEXT.en.generic

export type LoadingMicrocopy = string

function resolveLoadingMicrocopyContext(seed: string): LoadingMicrocopyContext {
  for (const [context, pattern] of CONTEXT_PATTERNS) {
    if (pattern.test(seed)) {
      return context
    }
  }
  return 'generic'
}

function normalizeLoadingMicrocopyLocale(locale: string | undefined): LoadingMicrocopyLocale {
  if (locale?.startsWith('zh')) {
    return 'zh'
  }
  if (locale?.startsWith('es')) {
    return 'es'
  }
  if (locale?.startsWith('ja')) {
    return 'ja'
  }
  if (locale?.startsWith('ko')) {
    return 'ko'
  }
  return 'en'
}

function hashSeed(seed: string): number {
  let hash = 2166136261
  for (const character of seed) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function getLoadingMicrocopy(seed: string, locale?: string): LoadingMicrocopy {
  const normalizedLocale = normalizeLoadingMicrocopyLocale(locale)
  for (const [pattern, pool] of LOADING_MICROCOPY_OVERRIDES[normalizedLocale]) {
    if (pattern.test(seed)) {
      return pool[hashSeed(seed) % pool.length]!
    }
  }
  const context = resolveLoadingMicrocopyContext(seed)
  const pool = LOADING_MICROCOPY_BY_CONTEXT[normalizedLocale][context]
  return pool[hashSeed(seed) % pool.length]!
}

export function isLoadingMicrocopy(value: string): boolean {
  const trimmed = value.trim()
  const matchesContextPool = Object.values(LOADING_MICROCOPY_BY_CONTEXT).some((localePools) =>
    Object.values(localePools).some((pool) => pool.includes(trimmed))
  )
  const matchesOverridePool = Object.values(LOADING_MICROCOPY_OVERRIDES).some((localeOverrides) =>
    localeOverrides.some(([, pool]) => pool.includes(trimmed))
  )
  return matchesContextPool || matchesOverridePool
}
