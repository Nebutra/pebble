import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationDispatchRequest } from '../../../src/shared/automations-types'
import type { RuntimeEventStreamEntry } from './runtime-command-shapes'
import { subscribeRuntimeEventPush } from './tauri-runtime-event-push'
import { onTauriAutomationDispatchRequested } from './tauri-automation-dispatch-events'
import { mapRuntimePrecheckResult } from './tauri-automation-run-result-mapping'

vi.mock('./tauri-runtime-event-push', () => ({
  subscribeRuntimeEventPush: vi.fn()
}))

vi.mock('./runtime-bridge', () => ({
  createRuntimeEventStreamCommand: vi.fn((input) => input),
  readRuntimeEventStream: vi.fn(async () => ({ transport: 'connected', events: [] }))
}))

const subscribeRuntimeEventPushMock = vi.mocked(subscribeRuntimeEventPush)

let pushHandler: ((entry: RuntimeEventStreamEntry) => void) | null = null

function dispatchEntry(args: {
  runId: string
  topic?: string
  payload?: Record<string, unknown>
}): RuntimeEventStreamEntry {
  const topic = args.topic ?? 'automation.dispatch.requested'
  return {
    id: null,
    topic,
    data: JSON.stringify({
      topic,
      payload: {
        automation: {
          id: 'auto-1',
          name: 'Nightly summary',
          enabled: true,
          action: {
            kind: 'createTask',
            payload: args.payload ?? {
              title: 'Nightly summary',
              pebbleAutomation: { name: 'Nightly summary', prompt: 'summarize', agentId: 'codex' }
            }
          },
          createdAt: '2026-07-09T00:00:00Z'
        },
        run: {
          id: args.runId,
          automationId: 'auto-1',
          reason: 'schedule',
          status: 'queued',
          precheckResult: {
            command: 'git status --short',
            exitCode: 0,
            timedOut: false,
            durationMs: 25,
            stdout: '',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            startedAt: '2026-07-09T01:00:00Z',
            completedAt: '2026-07-09T01:00:01Z'
          },
          createdAt: '2026-07-09T01:00:00Z'
        }
      }
    })
  }
}

describe('onTauriAutomationDispatchRequested', () => {
  const received: AutomationDispatchRequest[] = []
  let unsubscribe: (() => void) | null = null

  beforeEach(async () => {
    received.length = 0
    unsubscribe?.()
    subscribeRuntimeEventPushMock.mockImplementation(async (handler) => {
      pushHandler = handler
      return { pushActive: true, supported: true, unsubscribe: () => undefined }
    })
    unsubscribe = onTauriAutomationDispatchRequested((request) => received.push(request))
    // The push pipeline attaches asynchronously on first subscribe.
    await vi.waitFor(() => {
      expect(pushHandler).not.toBeNull()
    })
  })

  it('maps runtime dispatch events into renderer dispatch requests', () => {
    pushHandler?.(dispatchEntry({ runId: 'run-1' }))
    expect(received).toHaveLength(1)
    const request = received[0]!
    expect(request.automation.id).toBe('auto-1')
    expect(request.run.id).toBe('run-1')
    expect(request.run.trigger).toBe('scheduled')
    expect(request.dispatchToken).toBe('auto-1:run-1')
    expect(request.run.precheckResult?.exitCode).toBe(0)
  })

  it('delivers each run exactly once across duplicate events', () => {
    pushHandler?.(dispatchEntry({ runId: 'run-2' }))
    pushHandler?.(dispatchEntry({ runId: 'run-2' }))
    expect(received).toHaveLength(1)
  })

  it('ignores native-only automations without the renderer envelope', () => {
    pushHandler?.(dispatchEntry({ runId: 'run-3', payload: { title: 'native task' } }))
    expect(received).toHaveLength(0)
  })

  it('ignores unrelated runtime topics', () => {
    pushHandler?.(dispatchEntry({ runId: 'run-4', topic: 'automation.changed' }))
    expect(received).toHaveLength(0)
  })
})

describe('mapRuntimePrecheckResult', () => {
  it('converts RFC3339 timestamps to millisecond epochs', () => {
    const mapped = mapRuntimePrecheckResult({
      command: 'exit 0',
      exitCode: 0,
      durationMs: 12,
      startedAt: '2026-07-09T01:00:00Z',
      completedAt: '2026-07-09T01:00:01Z'
    })
    expect(mapped).toMatchObject({
      command: 'exit 0',
      exitCode: 0,
      timedOut: false,
      durationMs: 12,
      startedAt: Date.parse('2026-07-09T01:00:00Z'),
      completedAt: Date.parse('2026-07-09T01:00:01Z')
    })
  })

  it('keeps a null exit code for timed-out prechecks', () => {
    const mapped = mapRuntimePrecheckResult({
      command: 'sleep 5',
      exitCode: null,
      timedOut: true,
      error: 'Precheck timed out after 1s.'
    })
    expect(mapped?.exitCode).toBeNull()
    expect(mapped?.timedOut).toBe(true)
    expect(mapped?.error).toBe('Precheck timed out after 1s.')
  })

  it('returns null when the runtime run has no recorded precheck', () => {
    expect(mapRuntimePrecheckResult(undefined)).toBeNull()
    expect(mapRuntimePrecheckResult(null)).toBeNull()
  })
})
