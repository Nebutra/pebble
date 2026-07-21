import type { UpdateStatus } from '../../../packages/product-core/shared/types'
import {
  compareReleaseVersions,
  isValidReleaseVersion
} from '../../../packages/product-core/shared/updater-changelog-selection'

const NUDGE_POLL_INTERVAL_MS = 30 * 60_000
const NUDGE_ACTIVATION_COOLDOWN_MS = 5 * 60_000

type NudgeConfig = { id: string; minVersion?: string; maxVersion?: string }
type NudgeUiState = {
  pendingUpdateNudgeId?: string | null
  dismissedUpdateNudgeId?: string | null
}
type NudgeUiPatch = {
  pendingUpdateNudgeId?: string | null
  dismissedUpdateNudgeId?: string | null
  dismissedUpdateVersion?: string | null
}
type StartedOperation = { started: boolean; promise: Promise<void> }

type TauriUpdaterNudgeDependencies = {
  development: boolean
  fetchNudge: () => Promise<unknown>
  readVersion: () => Promise<string>
  readUi: () => Promise<NudgeUiState>
  writeUi: (patch: NudgeUiPatch) => Promise<unknown>
  readStatus: () => UpdateStatus
  startCheck: (operation: () => Promise<void>) => StartedOperation
  performCheck: (activeNudgeId: string) => Promise<void>
  clearDismissal: () => void
}

export class TauriUpdaterNudgeState {
  private checkInFlight = false
  private lastCheckAt = 0
  private pollingInstalled = false

  constructor(private readonly dependencies: TauriUpdaterNudgeDependencies) {}

  installPolling(): void {
    if (this.pollingInstalled) {
      return
    }
    this.pollingInstalled = true
    void this.check()
    globalThis.setInterval(() => void this.check(), NUDGE_POLL_INTERVAL_MS)
  }

  async dismiss(): Promise<void> {
    const ui = await this.dependencies.readUi()
    const status = this.dependencies.readStatus()
    const activeNudgeId = 'activeNudgeId' in status ? status.activeNudgeId : undefined
    const id = activeNudgeId ?? ui.pendingUpdateNudgeId ?? null
    if (!id) {
      return
    }
    await this.dependencies.writeUi({
      pendingUpdateNudgeId: null,
      dismissedUpdateNudgeId: id
    })
  }

  resetForTests(): void {
    this.checkInFlight = false
    this.lastCheckAt = 0
  }

  private async check(): Promise<void> {
    if (this.dependencies.development || this.checkInFlight) {
      return
    }
    const now = Date.now()
    if (now - this.lastCheckAt < NUDGE_ACTIVATION_COOLDOWN_MS) {
      return
    }
    this.lastCheckAt = now
    this.checkInFlight = true
    try {
      const nudge = normalizeNudge(await this.dependencies.fetchNudge().catch(() => null))
      const status = this.dependencies.readStatus()
      if (!nudge || status.state === 'checking' || status.state === 'downloading') {
        return
      }
      const version = await this.dependencies.readVersion()
      if (!versionMatchesNudge(version, nudge)) {
        return
      }
      const ui = await this.dependencies.readUi()
      if (ui.pendingUpdateNudgeId === nudge.id || ui.dismissedUpdateNudgeId === nudge.id) {
        return
      }
      const operation = this.dependencies.startCheck(async () => {
        await this.dependencies.writeUi({
          pendingUpdateNudgeId: nudge.id,
          dismissedUpdateVersion: null
        })
        this.dependencies.clearDismissal()
        await this.dependencies.performCheck(nudge.id)
      })
      if (!operation.started) {
        return
      }
      await operation.promise
    } finally {
      this.checkInFlight = false
    }
  }
}

function normalizeNudge(value: unknown): NudgeConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const minVersion = typeof record.minVersion === 'string' ? record.minVersion : undefined
  const maxVersion = typeof record.maxVersion === 'string' ? record.maxVersion : undefined
  if (!id || (!minVersion && !maxVersion)) {
    return null
  }
  if (minVersion && !isValidReleaseVersion(minVersion)) {
    return null
  }
  if (maxVersion && !isValidReleaseVersion(maxVersion)) {
    return null
  }
  if (minVersion && maxVersion && compareReleaseVersions(minVersion, maxVersion) > 0) {
    return null
  }
  return { id, ...(minVersion ? { minVersion } : {}), ...(maxVersion ? { maxVersion } : {}) }
}

function versionMatchesNudge(version: string, nudge: NudgeConfig): boolean {
  if (nudge.minVersion && compareReleaseVersions(version, nudge.minVersion) < 0) {
    return false
  }
  if (nudge.maxVersion && compareReleaseVersions(version, nudge.maxVersion) > 0) {
    return false
  }
  return true
}
