import { requestRuntimeJson } from './pebble-tauri-runtime-transport'

// Durable per-worktree tab/group/pane layout persistence against the Go
// runtime's /v1/session-tab-layouts/{worktreeId} snapshots, so the desktop
// shell's session-tab mirror can rehydrate its subscription state across
// reloads and runtime restarts. Layout payloads stay opaque here — the
// runtime persists what the mirror reports without owning renderer shapes.

export type SessionTabLayoutSnapshot = {
  worktreeId: string
  activeTabId?: string
  activeGroupId?: string
  tabGroups?: unknown
  tabGroupLayout?: unknown
  paneLayoutByTabId?: Record<string, unknown>
  tabPropsByTabId?: Record<string, unknown>
  snapshotVersion: number
  updatedAt: string
}

export type SaveSessionTabLayoutInput = Omit<
  SessionTabLayoutSnapshot,
  'worktreeId' | 'snapshotVersion' | 'updatedAt'
>

// Trailing debounce keeps rapid tab/pane mutations from writing one runtime
// state-file save per drag frame; the newest layout always wins.
const SESSION_TAB_LAYOUT_SAVE_DELAY_MS = 400

type PendingLayoutSave = {
  layout: SaveSessionTabLayoutInput
  timer: ReturnType<typeof setTimeout>
}

const pendingSavesByWorktreeId = new Map<string, PendingLayoutSave>()
const inflightSavesByWorktreeId = new Map<string, Promise<void>>()

export async function loadSessionTabLayout(
  worktreeId: string
): Promise<SessionTabLayoutSnapshot | null> {
  if (!worktreeId) {
    return null
  }
  // 404 (no snapshot yet) and transport failures both mean "nothing to
  // rehydrate" — the mirror falls back to live /v1/sessions placement.
  return requestRuntimeJson<SessionTabLayoutSnapshot>(
    `/v1/session-tab-layouts/${encodeURIComponent(worktreeId)}`,
    { method: 'GET', timeoutMs: 5000 }
  ).catch(() => null)
}

export function scheduleSessionTabLayoutSave(
  worktreeId: string,
  layout: SaveSessionTabLayoutInput
): void {
  if (!worktreeId) {
    return
  }
  const pending = pendingSavesByWorktreeId.get(worktreeId)
  if (pending) {
    clearTimeout(pending.timer)
  }
  pendingSavesByWorktreeId.set(worktreeId, {
    layout,
    timer: setTimeout(() => {
      void commitSessionTabLayoutSave(worktreeId)
    }, SESSION_TAB_LAYOUT_SAVE_DELAY_MS)
  })
}

// Drains a worktree's pending write immediately (all worktrees when omitted).
// Called on teardown so a close right after a tab move still persists.
export async function flushSessionTabLayoutSaves(worktreeId?: string): Promise<void> {
  const ids = worktreeId ? [worktreeId] : Array.from(pendingSavesByWorktreeId.keys())
  await Promise.all(ids.map((id) => commitSessionTabLayoutSave(id)))
}

export async function deleteSessionTabLayout(worktreeId: string): Promise<boolean> {
  if (!worktreeId) {
    return false
  }
  const pending = pendingSavesByWorktreeId.get(worktreeId)
  if (pending) {
    clearTimeout(pending.timer)
    pendingSavesByWorktreeId.delete(worktreeId)
  }
  const result = await requestRuntimeJson<{ deleted: boolean }>(
    `/v1/session-tab-layouts/${encodeURIComponent(worktreeId)}`,
    { method: 'DELETE', timeoutMs: 5000 }
  ).catch(() => null)
  return result?.deleted === true
}

async function commitSessionTabLayoutSave(worktreeId: string): Promise<void> {
  const pending = pendingSavesByWorktreeId.get(worktreeId)
  if (!pending) {
    return
  }
  clearTimeout(pending.timer)
  pendingSavesByWorktreeId.delete(worktreeId)
  // Serialize per worktree so an in-flight PUT never races a newer one into
  // an older snapshotVersion on the runtime.
  const previous = inflightSavesByWorktreeId.get(worktreeId) ?? Promise.resolve()
  const save = previous
    .then(() =>
      requestRuntimeJson<SessionTabLayoutSnapshot>(
        `/v1/session-tab-layouts/${encodeURIComponent(worktreeId)}`,
        { method: 'PUT', body: pending.layout, timeoutMs: 5000 }
      )
    )
    .then(
      () => undefined,
      () => undefined
    )
  inflightSavesByWorktreeId.set(worktreeId, save)
  await save
  if (inflightSavesByWorktreeId.get(worktreeId) === save) {
    inflightSavesByWorktreeId.delete(worktreeId)
  }
}
