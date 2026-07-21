import { invoke } from '@tauri-apps/api/core'
import type { MigrationUnsupportedPtyEntry } from '../../../packages/product-core/shared/agent-status-types'
import {
  readRuntimeTimestamp,
  type TauriRuntimeAgentSession
} from './tauri-agent-session-shape'

// Tracks PTY sessions that cannot migrate to stable pane keys, split out of
// tauri-agent-status-api.ts. Owns its own listener sets and settings-document
// persistence so the status module stays focused on agent bindings.
const MIGRATION_UNSUPPORTED_DOCUMENT = 'agent-migration-unsupported'

const migrationUnsupportedListeners = new Set<(entry: MigrationUnsupportedPtyEntry) => void>()
const migrationUnsupportedClearListeners = new Set<(data: { ptyId: string }) => void>()
const migrationUnsupportedByPtyId = new Map<string, MigrationUnsupportedPtyEntry>()
let migrationSnapshotHydration: Promise<void> | null = null
let migrationSnapshotWrite = Promise.resolve()

export function subscribeMigrationUnsupported(
  callback: (entry: MigrationUnsupportedPtyEntry) => void
): () => void {
  migrationUnsupportedListeners.add(callback)
  return () => migrationUnsupportedListeners.delete(callback)
}

export function subscribeMigrationUnsupportedClear(
  callback: (data: { ptyId: string }) => void
): () => void {
  migrationUnsupportedClearListeners.add(callback)
  return () => migrationUnsupportedClearListeners.delete(callback)
}

export function listMigrationUnsupportedEntries(): MigrationUnsupportedPtyEntry[] {
  return Array.from(migrationUnsupportedByPtyId.values())
}

export function recordMigrationUnsupportedSession(
  session: TauriRuntimeAgentSession,
  source: MigrationUnsupportedPtyEntry['source']
): void {
  if (!session.tabId || !session.leafId || !/^\d+$/.test(session.leafId)) {
    return
  }
  const entry: MigrationUnsupportedPtyEntry = {
    ptyId: session.id,
    ...(session.worktreeId ? { worktreeId: session.worktreeId } : {}),
    tabId: session.tabId,
    leafId: session.leafId,
    paneKey: `${session.tabId}:${session.leafId}`,
    reason: 'legacy-numeric-pane-key',
    source,
    updatedAt: readRuntimeTimestamp(session.updatedAt) ?? Date.now()
  }
  migrationUnsupportedByPtyId.set(entry.ptyId, entry)
  for (const listener of migrationUnsupportedListeners) {
    listener(entry)
  }
  persistMigrationUnsupportedSnapshot()
}

export function clearMigrationUnsupportedForPane(paneKey: string): void {
  for (const entry of Array.from(migrationUnsupportedByPtyId.values())) {
    if (entry.paneKey === paneKey) {
      clearMigrationUnsupported(entry.ptyId)
    }
  }
}

export function clearMigrationUnsupportedForTab(tabId: string): void {
  for (const entry of Array.from(migrationUnsupportedByPtyId.values())) {
    if (entry.tabId === tabId) {
      clearMigrationUnsupported(entry.ptyId)
    }
  }
}

function clearMigrationUnsupported(ptyId: string): void {
  if (!migrationUnsupportedByPtyId.delete(ptyId)) {
    return
  }
  for (const listener of migrationUnsupportedClearListeners) {
    listener({ ptyId })
  }
  persistMigrationUnsupportedSnapshot()
}

export function hydrateMigrationUnsupportedSnapshot(): Promise<void> {
  migrationSnapshotHydration ??= invoke<string | null>('read_settings_document', {
    name: MIGRATION_UNSUPPORTED_DOCUMENT
  })
    .then((contents) => {
      if (!contents) {
        return
      }
      const parsed: unknown = JSON.parse(contents)
      if (!Array.isArray(parsed)) {
        return
      }
      for (const value of parsed) {
        if (isMigrationUnsupportedEntry(value)) {
          migrationUnsupportedByPtyId.set(value.ptyId, value)
        }
      }
    })
    .catch(() => undefined)
  return migrationSnapshotHydration
}

function persistMigrationUnsupportedSnapshot(): void {
  const contents = JSON.stringify(Array.from(migrationUnsupportedByPtyId.values()))
  migrationSnapshotWrite = migrationSnapshotWrite
    .catch(() => undefined)
    .then(() =>
      invoke('write_settings_document', { name: MIGRATION_UNSUPPORTED_DOCUMENT, contents })
    )
    .then(
      () => undefined,
      () => undefined
    )
}

function isMigrationUnsupportedEntry(value: unknown): value is MigrationUnsupportedPtyEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const entry = value as Partial<MigrationUnsupportedPtyEntry>
  return (
    typeof entry.ptyId === 'string' &&
    entry.reason === 'legacy-numeric-pane-key' &&
    (entry.source === 'local' || entry.source === 'ssh') &&
    typeof entry.updatedAt === 'number'
  )
}
