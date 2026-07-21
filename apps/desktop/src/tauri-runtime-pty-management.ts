import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { stopRuntimeProcess } from './runtime-bridge'
import { ensurePebbleRuntimeProcess } from './pebble-tauri-runtime-transport'
import { markRuntimeAgentSessionStopped } from './tauri-agent-status-api'
import {
  listRuntimeSessions,
  requestRuntimePtyJson,
  type RuntimeSession
} from './tauri-runtime-pty-resource'

type RuntimePtyManagement = PreloadApi['pty']['management']

// The management sub-API is split out of tauri-runtime-pty-api.ts to keep each
// module focused; it receives forgetRuntimePtyState so cached per-session
// size/active state is dropped through the owner's single code path.
export function createRuntimePtyManagement(
  forgetRuntimePtyState: (id: string) => void
): RuntimePtyManagement {
  async function listManagedRuntimePtySessions(): ReturnType<
    RuntimePtyManagement['listSessions']
  > {
    const sessions = await listRuntimeSessions()
    return {
      sessions: sessions.map((session) => ({
        sessionId: session.id,
        state: mapRuntimePtyManagementState(session.status),
        shellState: session.status === 'running' ? 'ready' : 'pending',
        isAlive: session.status === 'starting' || session.status === 'running',
        pid: session.pid ?? null,
        cwd: session.cwd || null,
        cols: session.cols ?? 0,
        rows: session.rows ?? 0,
        createdAt: Date.parse(session.startedAt ?? '') || 0,
        // Go runtime HTTP sessions are the current native protocol generation.
        protocolVersion: 1
      })),
      degraded: false
    }
  }

  async function killManagedRuntimePtySession(sessionId: string): Promise<{ success: boolean }> {
    try {
      await requestRuntimePtyJson<RuntimeSession>(
        'DELETE',
        `/v1/sessions/${encodeURIComponent(sessionId)}`
      )
      markRuntimeAgentSessionStopped(sessionId)
      forgetRuntimePtyState(sessionId)
      return { success: true }
    } catch {
      return { success: false }
    }
  }

  async function killAllManagedRuntimePtySessions(): Promise<{
    killedCount: number
    remainingCount: number
  }> {
    const liveSessions = (await listRuntimeSessions()).filter(
      (session) => session.status === 'starting' || session.status === 'running'
    )
    const results = await Promise.all(
      liveSessions.map((session) => killManagedRuntimePtySession(session.id))
    )
    const killedCount = results.filter((result) => result.success).length
    return { killedCount, remainingCount: liveSessions.length - killedCount }
  }

  async function restartManagedRuntimePtyProcess(): Promise<{ success: boolean }> {
    try {
      await stopRuntimeProcess()
      for (const session of await listRuntimeSessions().catch(() => [])) {
        forgetRuntimePtyState(session.id)
      }
      await ensurePebbleRuntimeProcess()
      return { success: true }
    } catch {
      return { success: false }
    }
  }

  return {
    listSessions: listManagedRuntimePtySessions,
    killAll: killAllManagedRuntimePtySessions,
    killOne: ({ sessionId }) => killManagedRuntimePtySession(sessionId),
    restart: restartManagedRuntimePtyProcess
  }
}

function mapRuntimePtyManagementState(
  status: RuntimeSession['status']
): 'created' | 'spawning' | 'running' | 'exiting' | 'exited' {
  if (status === 'starting') {
    return 'spawning'
  }
  if (status === 'running') {
    return 'running'
  }
  return 'exited'
}
