import { getDefaultRepoHookSettings } from '../../../shared/constants'
import { resolveHookCommandSourcePolicy } from '../../../shared/hook-command-source-policy'
import type { SetupScriptImportCandidate } from '../../../shared/setup-script-imports'
import type { Repo, RepoHookSettings } from '../../../shared/types'
import type { HookCheckResult } from '@/runtime/runtime-hooks-client'
import { isRuntimeScopeForbiddenError } from '@/runtime/runtime-rpc-client'

const SETUP_SCRIPT_PROMPT_DISMISSAL_PREFIX = 'generation-v1:'

export type SetupScriptPromptInspection =
  | {
      status: 'ok'
      repoId: string
      hasEffectiveSetup: boolean
      hasSharedHooks: boolean
      candidate: SetupScriptImportCandidate | null
    }
  | {
      status: 'error'
      repoId: string
    }
  // Why: a forbidden (mobile-scope) failure is permanent, not transient — the
  // card must not offer a retry that re-fires repo.hooksCheck on every focus.
  // The global scope-mismatch banner already explains the cause.
  | {
      status: 'forbidden'
      repoId: string
    }

export async function inspectSetupScriptPromptState({
  repo,
  checkHooks,
  inspectImports
}: {
  repo: Repo
  checkHooks: () => Promise<HookCheckResult>
  inspectImports: () => Promise<SetupScriptImportCandidate[]>
}): Promise<SetupScriptPromptInspection> {
  try {
    const hooksResult = await checkHooks()
    if (hooksResult.status === 'error') {
      return { status: 'error', repoId: repo.id }
    }
    const hasEffectiveSetup = hasEffectiveSetupCommand(repo, hooksResult)
    if (hasEffectiveSetup) {
      return {
        status: 'ok',
        repoId: repo.id,
        hasEffectiveSetup: true,
        hasSharedHooks: hooksResult.hasHooks,
        candidate: null
      }
    }

    const candidates = await inspectImports()
    return {
      status: 'ok',
      repoId: repo.id,
      hasEffectiveSetup: false,
      hasSharedHooks: hooksResult.hasHooks,
      candidate: candidates[0] ?? null
    }
  } catch (error) {
    if (isRuntimeScopeForbiddenError(error)) {
      return { status: 'forbidden', repoId: repo.id }
    }
    console.warn('[setup-script-prompt] Failed to inspect setup scripts:', error)
    return { status: 'error', repoId: repo.id }
  }
}

// Why: the renderer mounts before the runtime is listening, so the first
// inspection of a session can fail on a runtime that is merely still starting.
// The effect that runs it has no dependency that changes when the runtime comes
// up, so that transient failure used to latch an error card until the user
// pressed Retry by hand. `forbidden` is excluded — it is permanent by design.
// Measured: on a loaded machine the runtime process only spawned 4s after the
// window appeared, so a 3.6s budget expired before it was ever listening and the
// card latched anyway. Cover a slow start instead of guessing low.
const TRANSIENT_INSPECTION_RETRY_DELAYS_MS = [300, 900, 2400, 5000, 8000]

export async function inspectSetupScriptPromptStateUntilSettled(
  args: Parameters<typeof inspectSetupScriptPromptState>[0] & {
    isCancelled?: () => boolean
    delay?: (ms: number) => Promise<void>
  }
): Promise<SetupScriptPromptInspection> {
  const isCancelled = args.isCancelled ?? (() => false)
  const delay =
    args.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let inspection = await inspectSetupScriptPromptState(args)
  for (const waitMs of TRANSIENT_INSPECTION_RETRY_DELAYS_MS) {
    if (inspection.status !== 'error' || isCancelled()) {
      return inspection
    }
    await delay(waitMs)
    if (isCancelled()) {
      return inspection
    }
    inspection = await inspectSetupScriptPromptState(args)
  }
  return inspection
}

export function hasEffectiveSetupCommand(repo: Repo, hooksResult: HookCheckResult): boolean {
  const localSetup = repo.hookSettings?.scripts?.setup?.trim()
  const sharedSetup = hooksResult.hooks?.scripts?.setup?.trim()
  const rawPolicy = repo.hookSettings?.commandSourcePolicy
  const sourcePolicy = resolveHookCommandSourcePolicy(rawPolicy, {
    hasLocalScript: Boolean(localSetup)
  })

  if (sourcePolicy === 'local-only') {
    return Boolean(localSetup)
  }

  if (sourcePolicy === 'run-both') {
    return Boolean(sharedSetup || localSetup)
  }

  return Boolean(sharedSetup)
}

export function ignoresSharedSetupScripts(repo: Pick<Repo, 'hookSettings'>): boolean {
  const localSetup = repo.hookSettings?.scripts?.setup?.trim()
  return (
    resolveHookCommandSourcePolicy(repo.hookSettings?.commandSourcePolicy, {
      hasLocalScript: Boolean(localSetup)
    }) === 'local-only'
  )
}

export function getSetupScriptPromptDismissalKey(repoId: string): string {
  return `${SETUP_SCRIPT_PROMPT_DISMISSAL_PREFIX}${repoId}`
}

export function isSetupScriptPromptDismissed(
  repoId: string,
  dismissedEntries: readonly string[]
): boolean {
  return dismissedEntries.includes(getSetupScriptPromptDismissalKey(repoId))
}

export function filterSetupScriptPromptDismissalsToValidRepos(
  value: unknown,
  validRepoIds: Set<string>
): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const next: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.startsWith(SETUP_SCRIPT_PROMPT_DISMISSAL_PREFIX)) {
      continue
    }
    const repoId = entry.slice(SETUP_SCRIPT_PROMPT_DISMISSAL_PREFIX.length)
    if (validRepoIds.has(repoId) && !next.includes(entry)) {
      next.push(entry)
    }
  }
  return next
}

export function buildImportedHookSettings(
  repo: Repo,
  candidate: SetupScriptImportCandidate,
  hasSharedHooks: boolean
): RepoHookSettings {
  const defaults = getDefaultRepoHookSettings()
  const current = repo.hookSettings
  return {
    ...defaults,
    ...current,
    setupRunPolicy: current?.setupRunPolicy ?? defaults.setupRunPolicy,
    // Why: imported setup commands are stored as local settings. If a shared
    // hook file exists, run-both preserves its archive hook; otherwise local
    // settings need to be authoritative so the imported setup actually runs.
    commandSourcePolicy:
      current?.commandSourcePolicy === 'local-only'
        ? 'local-only'
        : hasSharedHooks
          ? 'run-both'
          : 'local-only',
    scripts: {
      ...defaults.scripts,
      ...current?.scripts,
      setup: candidate.setup,
      archive: candidate.archive ?? current?.scripts?.archive ?? defaults.scripts.archive
    }
  }
}

export function formatCandidateSource(candidate: SetupScriptImportCandidate): string {
  const [primaryFile, ...remainingFiles] = candidate.files
  if (!primaryFile) {
    return candidate.label
  }
  return remainingFiles.length > 0
    ? `${candidate.label} (${primaryFile} +${remainingFiles.length})`
    : `${candidate.label} (${primaryFile})`
}

// Why: card provenance shows the file(s) we matched, not the provider label.
// For a single file we just print its name; for two we join with "and"; for
// more we keep the leading file and summarize the rest as "+N more".
export function formatCandidateProvenance(candidate: SetupScriptImportCandidate): string | null {
  if (candidate.provider === 'package-manager') {
    const lockfile = candidate.files.find((file) => file !== 'package.json')
    if (lockfile) {
      return lockfile
    }
  }
  const [primaryFile, secondaryFile, ...rest] = candidate.files
  if (!primaryFile) {
    return null
  }
  if (!secondaryFile) {
    return primaryFile
  }
  if (rest.length === 0) {
    return `${primaryFile} and ${secondaryFile}`
  }
  return `${primaryFile} +${rest.length + 1} more`
}
