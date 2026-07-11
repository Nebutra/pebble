import type { RuntimeTerminalDriverState } from '../../../src/shared/runtime-types'
import type { RuntimeEventStreamEntry } from './runtime-command-shapes'
import type { TauriRuntimeAgentSession } from './tauri-agent-status-api'

// Pure parsers for /v1/events entries consumed by the PTY push bridge.
// Kept free of side effects so the push/poll delivery loops stay thin and the
// payload contracts (incl. the runtime's coalesced-output fields) are testable.

export type RuntimePtyOutputEvent = {
  sessionId: string
  session: TauriRuntimeAgentSession
  content: string
  // Number of runtime-side output chunks folded into this event's content.
  coalescedChunks: number
  // Bytes the runtime dropped to keep the event bounded; a non-zero value
  // means the event carries only the newest tail and a tail-fetch is needed
  // for a gapless buffer.
  droppedBytes: number
}

export type RuntimeSessionDriverEvent = {
  sessionId: string
  driver: RuntimeTerminalDriverState
}

type RuntimeEventBody = {
  topic?: unknown
  payload?: unknown
}

export function mapRuntimePtyOutputEntry(
  entry: RuntimeEventStreamEntry
): RuntimePtyOutputEvent | null {
  const body = parseRuntimeEventBody(entry)
  if (body?.topic !== 'session.output') {
    return null
  }
  const payload = readObject(body.payload)
  const session = payload.session as TauriRuntimeAgentSession | undefined
  const chunk = readObject(payload.chunk)
  const content = typeof chunk.content === 'string' ? chunk.content : ''
  if (!session?.id || !content) {
    return null
  }
  return {
    sessionId: session.id,
    session,
    content,
    coalescedChunks: readCount(payload.coalescedChunks, 1),
    droppedBytes: readCount(payload.droppedBytes, 0)
  }
}

export function mapRuntimePtyStatusEntry(
  entry: RuntimeEventStreamEntry
): TauriRuntimeAgentSession | null {
  const body = parseRuntimeEventBody(entry)
  if (body?.topic !== 'session.status') {
    return null
  }
  const payload = readObject(body.payload)
  const session = (payload.session ?? body.payload) as TauriRuntimeAgentSession | undefined
  return session?.id ? session : null
}

export function mapRuntimeSessionDriverEntry(
  entry: RuntimeEventStreamEntry
): RuntimeSessionDriverEvent | null {
  const body = parseRuntimeEventBody(entry)
  if (body?.topic !== 'session.driver') {
    return null
  }
  const payload = readObject(body.payload)
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  const driver = readObject(payload.driver)
  if (!sessionId) {
    return null
  }
  if (driver.kind === 'mobile') {
    const clientId = typeof driver.clientId === 'string' ? driver.clientId : ''
    return clientId ? { sessionId, driver: { kind: 'mobile', clientId } } : null
  }
  if (driver.kind === 'desktop' || driver.kind === 'idle') {
    return { sessionId, driver: { kind: driver.kind } }
  }
  return null
}

function parseRuntimeEventBody(entry: RuntimeEventStreamEntry): RuntimeEventBody | null {
  try {
    const parsed = JSON.parse(entry.data) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as RuntimeEventBody) : null
  } catch {
    return null
  }
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readCount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}
