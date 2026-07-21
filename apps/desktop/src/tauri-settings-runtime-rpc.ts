import { getDefaultSettings } from '../../../packages/product-core/shared/constants'
import { TASK_PROVIDERS } from '../../../packages/product-core/shared/task-providers'
import type { GlobalSettings } from '../../../packages/product-core/shared/types'
import {
  readPersistentSettingsRaw,
  writePersistentSettingsRaw
} from '@/web/persistent-settings-backend'
import { reconcileTauriManagedAgentHooks } from './tauri-agent-hooks-api'

const SETTINGS_STORAGE_KEY = 'pebble.web.settings.v1'
const CLIENT_SETTING_KEYS = new Set([
  'defaultTuiAgent',
  'disabledTuiAgents',
  'agentDefaultArgs',
  'agentDefaultEnv',
  'agentStatusHooksEnabled',
  'defaultTaskSource',
  'defaultTaskViewPreset',
  'visibleTaskProviders',
  'defaultRepoSelection',
  'defaultLinearTeamSelection',
  'githubProjects',
  'experimentalNewWorktreeCardStyle',
  'compactWorktreeCards',
  'minimaxGroupId',
  'minimaxUsageModels'
])

type RuntimeSettingsRpcResult = { handled: boolean; result?: unknown }

export async function callTauriSettingsRuntimeRpc(
  method: string,
  params: unknown
): Promise<RuntimeSettingsRpcResult> {
  if (method === 'settings.get') {
    return handled({ settings: readClientSettings() })
  }
  if (method === 'settings.update') {
    const updates = validateSettingsUpdates(params)
    const current = readStoredSettings()
    writePersistentSettingsRaw(SETTINGS_STORAGE_KEY, JSON.stringify({ ...current, ...updates }))
    if (typeof updates.agentStatusHooksEnabled === 'boolean') {
      await reconcileTauriManagedAgentHooks(updates.agentStatusHooksEnabled)
    }
    return handled({ settings: readClientSettings() })
  }
  return { handled: false }
}

function readStoredSettings(): GlobalSettings {
  const defaults = getDefaultSettings('~')
  const raw = readPersistentSettingsRaw(SETTINGS_STORAGE_KEY)
  if (!raw) {
    return defaults
  }
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? { ...defaults, ...parsed } : defaults
  } catch {
    return defaults
  }
}

function readClientSettings() {
  const settings = readStoredSettings()
  return {
    defaultTuiAgent: settings.defaultTuiAgent ?? null,
    disabledTuiAgents: settings.disabledTuiAgents ?? [],
    agentCmdOverrides: settings.agentCmdOverrides ?? {},
    agentDefaultArgs: settings.agentDefaultArgs ?? {},
    agentDefaultEnv: settings.agentDefaultEnv ?? {},
    agentStatusHooksEnabled: settings.agentStatusHooksEnabled !== false,
    defaultTaskSource: settings.defaultTaskSource ?? 'github',
    defaultTaskViewPreset: settings.defaultTaskViewPreset ?? 'issues',
    visibleTaskProviders: settings.visibleTaskProviders ?? [...TASK_PROVIDERS],
    defaultRepoSelection: settings.defaultRepoSelection ?? null,
    defaultLinearTeamSelection: settings.defaultLinearTeamSelection ?? null,
    githubProjects: settings.githubProjects,
    experimentalNewWorktreeCardStyle: settings.experimentalNewWorktreeCardStyle === true,
    compactWorktreeCards: settings.compactWorktreeCards === true,
    minimaxGroupId: settings.minimaxGroupId ?? '',
    minimaxUsageModels: settings.minimaxUsageModels ?? 'general'
  }
}

function validateSettingsUpdates(params: unknown): Partial<GlobalSettings> {
  if (!isRecord(params)) {
    throw new Error('Settings update must be an object')
  }
  for (const key of Object.keys(params)) {
    if (!CLIENT_SETTING_KEYS.has(key)) {
      throw new Error(`Unknown settings field: ${key}`)
    }
  }
  validateKnownSettingTypes(params)
  const updates = structuredClone(params) as Partial<GlobalSettings>
  assertJsonValue(updates)
  return updates
}

function validateKnownSettingTypes(value: Record<string, unknown>): void {
  assertOptionalBoolean(value, 'agentStatusHooksEnabled')
  assertOptionalBoolean(value, 'experimentalNewWorktreeCardStyle')
  assertOptionalBoolean(value, 'compactWorktreeCards')
  assertOptionalString(value, 'minimaxGroupId')
  assertOptionalString(value, 'minimaxUsageModels')
  assertOptionalStringRecord(value, 'agentDefaultArgs')
  assertOptionalStringRecord(value, 'agentDefaultEnv')
  assertOptionalStringArray(value, 'disabledTuiAgents', false)
  assertOptionalStringArray(value, 'visibleTaskProviders', false)
  assertOptionalStringArray(value, 'defaultRepoSelection', true)
  assertOptionalStringArray(value, 'defaultLinearTeamSelection', true)
  if (
    value.defaultTuiAgent !== undefined &&
    value.defaultTuiAgent !== null &&
    typeof value.defaultTuiAgent !== 'string'
  ) {
    throw new Error('Invalid settings field: defaultTuiAgent')
  }
  if (
    value.defaultTaskSource !== undefined &&
    (typeof value.defaultTaskSource !== 'string' ||
      !TASK_PROVIDERS.includes(value.defaultTaskSource as never))
  ) {
    throw new Error('Invalid settings field: defaultTaskSource')
  }
  const viewPresets = ['issues', 'my-issues', 'prs', 'my-prs', 'review', 'all']
  if (
    value.defaultTaskViewPreset !== undefined &&
    !viewPresets.includes(String(value.defaultTaskViewPreset))
  ) {
    throw new Error('Invalid settings field: defaultTaskViewPreset')
  }
  if (value.githubProjects !== undefined && !isRecord(value.githubProjects)) {
    throw new Error('Invalid settings field: githubProjects')
  }
}

function assertOptionalBoolean(value: Record<string, unknown>, key: string): void {
  if (value[key] !== undefined && typeof value[key] !== 'boolean') {
    throw new Error(`Invalid settings field: ${key}`)
  }
}

function assertOptionalString(value: Record<string, unknown>, key: string): void {
  if (value[key] !== undefined && typeof value[key] !== 'string') {
    throw new Error(`Invalid settings field: ${key}`)
  }
}

function assertOptionalStringArray(
  value: Record<string, unknown>,
  key: string,
  nullable: boolean
): void {
  const candidate = value[key]
  if (candidate === undefined || (nullable && candidate === null)) {
    return
  }
  if (!Array.isArray(candidate) || candidate.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Invalid settings field: ${key}`)
  }
}

function assertOptionalStringRecord(value: Record<string, unknown>, key: string): void {
  const candidate = value[key]
  if (candidate === undefined) {
    return
  }
  if (!isRecord(candidate)) {
    throw new Error(`Invalid settings field: ${key}`)
  }
}

function assertJsonValue(value: unknown, depth = 0): void {
  if (depth > 8) {
    throw new Error('Settings update is too deeply nested')
  }
  if (value === null || ['string', 'boolean'].includes(typeof value)) {
    return
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) {
      throw new Error('Settings update array is too large')
    }
    value.forEach((entry) => assertJsonValue(entry, depth + 1))
    return
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
    if (entries.length > 1_000) {
      throw new Error('Settings update object is too large')
    }
    entries.forEach(([key, entry]) => {
      if (key.length > 512) {
        throw new Error('Settings update key is too long')
      }
      assertJsonValue(entry, depth + 1)
    })
    return
  }
  throw new Error('Settings update contains a non-JSON value')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function handled(result: unknown): RuntimeSettingsRpcResult {
  return { handled: true, result }
}
