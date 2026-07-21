import {
  readPersistentSettingsRaw,
  writePersistentSettingsRaw
} from '@/web/persistent-settings-backend'

const SETTINGS_STORAGE_KEY = 'pebble.web.settings.v1'
export const MOBILE_AUTO_RESTORE_FIT_MIN_MS = 5_000
export const MOBILE_AUTO_RESTORE_FIT_MAX_MS = 60 * 60 * 1_000

export function readTauriMobileAutoRestoreFitMs(): number | null {
  const raw = readSettingsRecord().mobileAutoRestoreFitMs
  return normalizeMobileAutoRestoreFitMs(raw)
}

export function writeTauriMobileAutoRestoreFitMs(value: unknown): number | null {
  const normalized = normalizeMobileAutoRestoreFitMs(value)
  writePersistentSettingsRaw(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({ ...readSettingsRecord(), mobileAutoRestoreFitMs: normalized })
  )
  return normalized
}

function normalizeMobileAutoRestoreFitMs(value: unknown): number | null {
  if (value === null) {
    return null
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  return Math.min(Math.max(value, MOBILE_AUTO_RESTORE_FIT_MIN_MS), MOBILE_AUTO_RESTORE_FIT_MAX_MS)
}

function readSettingsRecord(): Record<string, unknown> {
  const raw = readPersistentSettingsRaw(SETTINGS_STORAGE_KEY)
  if (!raw) {
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
