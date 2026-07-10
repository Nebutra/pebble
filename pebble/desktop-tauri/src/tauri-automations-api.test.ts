import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../src/preload/api-types'
import type { AutomationCreateInput } from '../../../src/shared/automations-types'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import {
  callTauriAutomationRuntimeRpc,
  createPebbleAutomationsApi
} from './tauri-automations-api'

vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: vi.fn()
}))

const requestRuntimeJsonMock = vi.mocked(requestRuntimeJson)

const automationInput: AutomationCreateInput = {
  name: 'Morning review',
  prompt: 'Summarize overnight changes',
  precheck: { command: 'git status --short', timeoutSeconds: 30 },
  agentId: 'codex',
  runContext: {
    kind: 'workspace-run',
    projectId: 'github:nebutra/pebble',
    hostId: 'local',
    projectHostSetupId: 'setup-local',
    repoId: 'repo-1',
    path: '/workspace/pebble'
  },
  sourceContext: null,
  projectId: 'repo-1',
  workspaceMode: 'new_per_run',
  workspaceId: null,
  baseBranch: 'main',
  setupDecision: 'run',
  reuseSession: false,
  timezone: 'UTC',
  rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  dtstart: Date.parse('2026-05-13T00:00:00Z'),
  enabled: true,
  missedRunGraceMinutes: 720
}

function runtimeAutomation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'auto-1',
    name: automationInput.name,
    description: automationInput.prompt,
    enabled: true,
    schedule: { kind: 'manual', timezone: 'UTC' },
    action: {
      kind: 'createTask',
      payload: {
        title: automationInput.name,
        body: automationInput.prompt,
        assignee: automationInput.agentId,
        pebbleAutomation: automationInput
      }
    },
    nextRunAt: '2026-05-14T09:00:00Z',
    createdAt: '2026-05-13T00:00:00Z',
    updatedAt: '2026-05-13T00:01:00Z',
    ...overrides
  }
}

describe('createPebbleAutomationsApi', () => {
  beforeEach(() => {
    requestRuntimeJsonMock.mockReset()
  })

  it('lists Go runtime automations as renderer automation records', async () => {
    requestRuntimeJsonMock.mockResolvedValueOnce([runtimeAutomation()])
    const api = createPebbleAutomationsApi({} as PreloadApi['automations'])

    const automations = await api.list()

    expect(automations[0]).toMatchObject({
      id: 'auto-1',
      name: automationInput.name,
      prompt: automationInput.prompt,
      agentId: 'codex',
      projectId: 'repo-1',
      rrule: automationInput.rrule,
      nextRunAt: Date.parse('2026-05-14T09:00:00Z')
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/automations', {
      method: 'GET',
      timeoutMs: 5000
    })
  })

  it('creates runtime automations without dropping Pebble schedule metadata', async () => {
    requestRuntimeJsonMock.mockImplementation(async (_path, options) =>
      runtimeAutomation({
        action: (options.body as Record<string, unknown>).action,
        schedule: (options.body as Record<string, unknown>).schedule
      })
    )
    const api = createPebbleAutomationsApi({} as PreloadApi['automations'])

    const automation = await api.create(automationInput)

    expect(automation.prompt).toBe(automationInput.prompt)
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/automations', {
      method: 'POST',
      body: expect.objectContaining({
        enabled: true,
        schedule: { kind: 'manual', timezone: 'UTC' },
        action: expect.objectContaining({
          kind: 'createTask',
          payload: expect.objectContaining({
            title: automationInput.name,
            pebbleAutomation: expect.objectContaining({
              rrule: automationInput.rrule,
              setupDecision: 'run'
            })
          })
        })
      }),
      timeoutMs: 5000
    })
  })

  it('runs automations through the runtime run endpoint and maps run history', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path) => {
      if (String(path).endsWith('/runs')) {
        return {
          id: 'run-1',
          automationId: 'auto-1',
          reason: 'manual',
          status: 'completed',
          taskId: 'task-1',
          createdAt: '2026-05-13T01:00:00Z',
          updatedAt: '2026-05-13T01:00:10Z'
        }
      }
      return [runtimeAutomation()]
    })
    const api = createPebbleAutomationsApi({} as PreloadApi['automations'])

    const run = await api.runNow({ id: 'auto-1' })

    expect(run).toMatchObject({
      id: 'run-1',
      automationId: 'auto-1',
      status: 'completed',
      trigger: 'manual',
      outputSnapshot: expect.objectContaining({
        content: 'Runtime automation completed: task-1'
      })
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/automations/auto-1/runs', {
      method: 'POST',
      body: { reason: 'manual' },
      timeoutMs: 15_000
    })
  })

  it('writes renderer dispatch outcomes back onto the Go run record', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path) => {
      if (String(path).endsWith('/dispatch-result')) {
        return {
          id: 'run-1',
          automationId: 'auto-1',
          reason: 'schedule',
          status: 'queued',
          dispatchState: {
            status: 'completed',
            workspaceId: 'ws-1',
            workspaceDisplayName: 'feature/agent-work',
            terminalSessionId: 'sess-7',
            terminalPaneKey: 'tab-1:leaf-1',
            terminalPtyId: 'pty-9',
            reportedAt: '2026-05-13T02:00:00Z'
          },
          createdAt: '2026-05-13T01:00:00Z',
          updatedAt: '2026-05-13T02:00:00Z'
        }
      }
      return [runtimeAutomation()]
    })
    const api = createPebbleAutomationsApi({} as PreloadApi['automations'])

    const run = await api.markDispatchResult({
      runId: 'run-1',
      status: 'completed',
      workspaceId: 'ws-1',
      workspaceDisplayName: 'feature/agent-work',
      terminalSessionId: 'sess-7',
      terminalPaneKey: 'tab-1:leaf-1',
      terminalPtyId: 'pty-9'
    })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/automations/runs/run-1/dispatch-result',
      {
        method: 'POST',
        body: {
          status: 'completed',
          workspaceId: 'ws-1',
          workspaceDisplayName: 'feature/agent-work',
          terminalSessionId: 'sess-7',
          terminalPaneKey: 'tab-1:leaf-1',
          terminalPtyId: 'pty-9'
        },
        timeoutMs: 5000
      }
    )
    expect(run).toMatchObject({
      id: 'run-1',
      status: 'completed',
      workspaceId: 'ws-1',
      workspaceDisplayName: 'feature/agent-work',
      terminalSessionId: 'sess-7',
      terminalPaneKey: 'tab-1:leaf-1',
      terminalPtyId: 'pty-9'
    })
  })

  it('surfaces renderer dispatch failures from the written-back run record', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path) => {
      if (String(path).endsWith('/dispatch-result')) {
        return {
          id: 'run-2',
          automationId: 'auto-1',
          reason: 'schedule',
          status: 'failed',
          dispatchState: {
            status: 'dispatch_failed',
            error: 'workspace setup failed',
            reportedAt: '2026-05-13T02:00:00Z'
          },
          error: 'workspace setup failed',
          createdAt: '2026-05-13T01:00:00Z',
          updatedAt: '2026-05-13T02:00:00Z'
        }
      }
      return [runtimeAutomation()]
    })
    const api = createPebbleAutomationsApi({} as PreloadApi['automations'])

    const run = await api.markDispatchResult({
      runId: 'run-2',
      status: 'dispatch_failed',
      error: 'workspace setup failed'
    })

    expect(run).toMatchObject({
      id: 'run-2',
      status: 'dispatch_failed',
      error: 'workspace setup failed'
    })
  })

  it('surfaces unavailable external managers instead of a fake empty state', async () => {
    const api = createPebbleAutomationsApi({} as PreloadApi['automations'])

    const managers = await api.listExternalManagers()

    expect(managers).toEqual([
      expect.objectContaining({
        id: 'tauri-hermes-local-unavailable',
        provider: 'hermes',
        status: 'unavailable',
        canManage: false,
        error: 'External automation managers require the Tauri external automation adapter.'
      }),
      expect.objectContaining({
        id: 'tauri-openclaw-local-unavailable',
        provider: 'openclaw',
        status: 'unavailable',
        canManage: false,
        error: 'External automation managers require the Tauri external automation adapter.'
      })
    ])
  })

  it('rejects external automation mutations with the explicit Tauri adapter gap', async () => {
    const api = createPebbleAutomationsApi({} as PreloadApi['automations'])

    await expect(
      api.runExternalAction({
        managerId: 'tauri-hermes-local-unavailable',
        provider: 'hermes',
        target: { type: 'local' },
        jobId: 'job-1',
        action: 'run'
      })
    ).rejects.toThrow('External automation managers require the Tauri external automation adapter.')
  })

  it('handles automation runtime RPC methods for paired-runtime parity', async () => {
    requestRuntimeJsonMock.mockResolvedValueOnce([runtimeAutomation()])

    const result = await callTauriAutomationRuntimeRpc('automation.list')

    expect(result).toMatchObject({
      handled: true,
      result: { automations: [expect.objectContaining({ id: 'auto-1' })] }
    })
  })
})
