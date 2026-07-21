import { invoke } from '@tauri-apps/api/core'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { WorkspaceSessionState } from '../../../packages/product-core/shared/types'
import { getDefaultWorkspaceSession } from '../../../packages/product-core/shared/constants'
import {
  readPersistentSettingsRaw,
  writePersistentSettingsRaw
} from '../../../packages/product-core/renderer/src/web/persistent-settings-backend'

const remoteSessionCache = new Map<string, WorkspaceSessionState>()
const LOCAL_SESSION_STORAGE_KEY = 'pebble.web.workspaceSession.v1'

export function installTauriSessionPersistenceApi(): void {
  if (!hasTauriInternals()) {
    return
  }
  const base = window.api.session
  window.api.session = {
    ...base,
    get: async (hostId) => {
      if (isLocalHost(hostId)) {
        return readLocalSession() ?? base.get(hostId)
      }
      const hostKey = String(hostId)
      const contents = await invoke<string | null>('read_host_workspace_session', {
        hostId: hostKey
      })
      if (!contents) {
        return base.get(hostId)
      }
      let session: WorkspaceSessionState
      try {
        session = JSON.parse(contents) as WorkspaceSessionState
      } catch {
        return base.get(hostId)
      }
      remoteSessionCache.set(hostKey, session)
      return session
    },
    set: async (session, hostId) => {
      if (isLocalHost(hostId)) {
        if (!writeLocalSession(session)) {
          await base.set(session, hostId)
        }
        return
      }
      remoteSessionCache.set(String(hostId), session)
      await writeRemoteSession(String(hostId), session)
    },
    patch: async (patch, hostId) => {
      if (isLocalHost(hostId)) {
        const current = readLocalSession()
        if (current) {
          writeLocalSession({ ...current, ...patch })
        } else {
          await base.patch(patch, hostId)
        }
        return
      }
      const hostKey = String(hostId)
      const current = remoteSessionCache.get(hostKey) ?? (await window.api.session.get(hostId))
      const next = { ...current, ...patch }
      remoteSessionCache.set(hostKey, next)
      await writeRemoteSession(hostKey, next)
    },
    setSync: (session, hostId) => {
      if (isLocalHost(hostId)) {
        if (!writeLocalSession(session)) {
          base.setSync(session, hostId)
        }
        return
      }
      const hostKey = String(hostId)
      remoteSessionCache.set(hostKey, session)
      void writeRemoteSession(hostKey, session)
    }
  } satisfies PreloadApi['session']
}

function readLocalSession(): WorkspaceSessionState | null {
  let raw: string | null
  try {
    raw = readPersistentSettingsRaw(LOCAL_SESSION_STORAGE_KEY)
  } catch {
    return null
  }
  if (!raw) {
    return getDefaultWorkspaceSession()
  }
  try {
    return { ...getDefaultWorkspaceSession(), ...(JSON.parse(raw) as WorkspaceSessionState) }
  } catch {
    return getDefaultWorkspaceSession()
  }
}

function writeLocalSession(session: WorkspaceSessionState): boolean {
  // Why: Tauri owns a native file-backed document for this key. Keeping the
  // complete payload preserves tabs and bounded inline terminal scrollback.
  try {
    writePersistentSettingsRaw(LOCAL_SESSION_STORAGE_KEY, JSON.stringify(session))
    return true
  } catch {
    return false
  }
}

function writeRemoteSession(hostId: string, session: WorkspaceSessionState): Promise<void> {
  return invoke('write_host_workspace_session', { hostId, contents: JSON.stringify(session) })
}

function isLocalHost(hostId: unknown): boolean {
  return hostId == null || hostId === '' || hostId === 'local'
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
