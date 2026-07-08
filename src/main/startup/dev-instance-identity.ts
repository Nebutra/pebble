import { createHash } from 'node:crypto'
import path from 'node:path'
import type { AppIdentity } from '../../shared/app-identity'

const BASE_APP_NAME = 'Pebble'
const BASE_APP_USER_MODEL_ID = 'nebutra.pebble'
const MAX_LABEL_LENGTH = 80

export type DevInstanceIdentity = AppIdentity & {
  appUserModelId: string
}

function cleanEnvValue(value: string | undefined): string | null {
  const trimmed = value?.replace(/\s+/g, ' ').trim()
  if (!trimmed) {
    return null
  }
  return trimmed.length > MAX_LABEL_LENGTH
    ? `${trimmed.slice(0, MAX_LABEL_LENGTH - 3)}...`
    : trimmed
}

function lastPathSegment(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).at(-1) ?? value
}

function formatLabel(branch: string | null, worktreeName: string | null): string | null {
  if (branch && worktreeName) {
    if (branch === worktreeName || lastPathSegment(branch) === worktreeName) {
      return worktreeName
    }
    return `${worktreeName} @ ${branch}`
  }
  return branch ?? worktreeName
}

function createDevAppUserModelId(identityKey: string | null): string {
  if (!identityKey) {
    return BASE_APP_USER_MODEL_ID
  }
  const hash = createHash('sha1').update(identityKey).digest('hex').slice(0, 10)
  return `${BASE_APP_USER_MODEL_ID}.dev.${hash}`
}

function getDevEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[`PEBBLE_DEV_${name}`] ?? env[`PEBBLE_DEV_${name}`]
}

export function getDevInstanceIdentity(
  isDev: boolean,
  env: NodeJS.ProcessEnv = process.env
): DevInstanceIdentity {
  if (!isDev) {
    return {
      name: BASE_APP_NAME,
      isDev: false,
      devLabel: null,
      devBranch: null,
      devWorktreeName: null,
      devRepoRoot: null,
      dockBadgeLabel: null,
      appUserModelId: BASE_APP_USER_MODEL_ID
    }
  }

  const repoRoot = cleanEnvValue(getDevEnv(env, 'REPO_ROOT'))
  const branch = cleanEnvValue(getDevEnv(env, 'BRANCH'))
  const worktreeName =
    cleanEnvValue(getDevEnv(env, 'WORKTREE_NAME')) ??
    cleanEnvValue(path.basename(repoRoot ?? process.cwd()))
  const devLabel = cleanEnvValue(getDevEnv(env, 'INSTANCE_LABEL')) ?? formatLabel(branch, worktreeName)
  const dockTitle =
    cleanEnvValue(getDevEnv(env, 'DOCK_TITLE')) ?? `${BASE_APP_NAME}: ${branch ?? devLabel ?? 'dev'}`

  return {
    name: dockTitle,
    isDev: true,
    devLabel,
    devBranch: branch,
    devWorktreeName: worktreeName,
    devRepoRoot: repoRoot,
    dockBadgeLabel: null,
    appUserModelId: createDevAppUserModelId(repoRoot ?? devLabel)
  }
}
