import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { AutomationCreateInput } from '../../../packages/product-core/shared/automations-types'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { callTauriAutomationRuntimeRpc, createPebbleAutomationsApi } from './tauri-automations-api'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

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
    schedule: {
      kind: 'rrule',
      timezone: 'UTC',
      rrule: automationInput.rrule,
      dtstart: '2026-05-13T00:00:00.000Z'
    },
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
    invokeMock.mockReset()
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
        schedule: {
          kind: 'rrule',
          timezone: 'UTC',
          rrule: automationInput.rrule,
          dtstart: '2026-05-13T00:00:00.000Z'
        },
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
      outputSnapshot: null
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/automations/auto-1/runs', {
      method: 'POST',
      body: { reason: 'manual' },
      timeoutMs: 15_000
    })
  })

  it('maps only the authoritative runtime output snapshot', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path) => {
      if (String(path).startsWith('/v1/automations/runs')) {
        return [
          {
            id: 'run-output',
            automationId: 'auto-1',
            reason: 'schedule',
            status: 'completed',
            taskId: 'task-must-not-be-rendered-as-output',
            dispatchState: {
              status: 'completed',
              outputSnapshot: {
                format: 'plain_text',
                content: 'Actual assistant response',
                capturedAt: 1_768_000_000_000,
                truncated: false
              },
              reportedAt: '2026-05-13T02:00:00Z'
            },
            createdAt: '2026-05-13T01:00:00Z',
            updatedAt: '2026-05-13T02:00:00Z'
          }
        ]
      }
      return [runtimeAutomation()]
    })
    const api = createPebbleAutomationsApi({} as PreloadApi['automations'])

    const runs = await api.listRuns({ automationId: 'auto-1' })

    expect(runs[0]?.outputSnapshot).toEqual({
      format: 'plain_text',
      content: 'Actual assistant response',
      capturedAt: 1_768_000_000_000,
      truncated: false
    })
  })

  it('preserves native missed-run status and scheduled occurrence time', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path) => {
      if (String(path).startsWith('/v1/automations/runs')) {
        return [
          {
            id: 'run-missed',
            automationId: 'auto-1',
            reason: 'schedule',
            status: 'skipped_missed',
            error: 'Pebble was unavailable during the missed-run grace window.',
            createdAt: '2026-05-13T09:00:00Z',
            updatedAt: '2026-05-13T12:00:00Z'
          }
        ]
      }
      return [runtimeAutomation()]
    })
    const api = createPebbleAutomationsApi({} as PreloadApi['automations'])

    const runs = await api.listRuns({ automationId: 'auto-1' })

    expect(runs[0]).toMatchObject({
      id: 'run-missed',
      status: 'skipped_missed',
      scheduledFor: Date.parse('2026-05-13T09:00:00Z'),
      trigger: 'scheduled'
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
            outputSnapshot: {
              format: 'plain_text',
              content: 'Actual terminal output',
              capturedAt: 1_768_000_000_000,
              truncated: true
            },
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
      terminalPtyId: 'pty-9',
      outputSnapshot: {
        format: 'plain_text',
        content: 'Actual terminal output',
        capturedAt: 1_768_000_000_000,
        truncated: true
      }
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
          terminalPtyId: 'pty-9',
          outputSnapshot: {
            format: 'plain_text',
            content: 'Actual terminal output',
            capturedAt: 1_768_000_000_000,
            truncated: true
          }
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
      terminalPtyId: 'pty-9',
      outputSnapshot: expect.objectContaining({ content: 'Actual terminal output' })
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

  it('maps native local external automation managers and jobs', async () => {
    requestRuntimeJsonMock.mockResolvedValueOnce([])
    invokeMock.mockResolvedValueOnce([
      {
        provider: 'hermes',
        commandAvailable: true,
        error: null,
        jobs: [{ id: 'job-1', name: 'Daily review', schedule: '0 9 * * *', enabled: true }]
      },
      {
        provider: 'openclaw',
        commandAvailable: false,
        error: null,
        jobs: { jobs: [{ id: 'job-2', name: 'Inbox', enabled: true }] }
      }
    ])
    const api = createPebbleAutomationsApi({} as PreloadApi['automations'])

    const managers = await api.listExternalManagers()

    expect(managers).toEqual([
      expect.objectContaining({
        id: 'hermes:local',
        provider: 'hermes',
        status: 'available',
        canManage: true,
        jobs: [expect.objectContaining({ id: 'job-1', name: 'Daily review' })]
      }),
      expect.objectContaining({
        id: 'openclaw:local',
        provider: 'openclaw',
        status: 'available',
        canManage: false,
        error: 'OpenClaw jobs were found, but the CLI is not on PATH.',
        jobs: [expect.objectContaining({ id: 'job-2', name: 'Inbox' })]
      })
    ])
  })

  it('maps SSH external managers through the Go relay-worker route', async () => {
    invokeMock.mockResolvedValueOnce([])
    requestRuntimeJsonMock.mockImplementation(async (path, options) => {
      if (path === '/v1/ssh-targets') {
        return [
          { id: 'ssh-1', label: 'Build host', host: 'build.example', port: 22, username: 'dev' },
          {
            id: 'owned-1',
            label: 'Internal',
            host: 'internal',
            port: 22,
            username: 'dev',
            owner: { type: 'on-demand-runtime', runtimeId: 'runtime-1' }
          }
        ]
      }
      if (String(path).includes('/ssh-1/external-automations')) {
        const provider = (options.body as { provider?: string } | undefined)?.provider
        return {
          provider,
          commandAvailable: true,
          jobs: provider === 'hermes' ? [{ id: 'remote-job', name: 'Remote review' }] : []
        }
      }
      throw new Error(`Unexpected path: ${path}`)
    })
    const api = createPebbleAutomationsApi({} as PreloadApi['automations'])

    const managers = await api.listExternalManagers()

    expect(managers).toHaveLength(2)
    expect(managers[0]).toMatchObject({
      id: 'hermes:ssh:ssh-1',
      targetLabel: 'Build host',
      canManage: true,
      jobs: [expect.objectContaining({ id: 'remote-job' })]
    })
    expect(requestRuntimeJsonMock).not.toHaveBeenCalledWith(
      expect.stringContaining('owned-1'),
      expect.anything()
    )
  })

  it('runs local external automation actions through the Rust host', async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    const api = createPebbleAutomationsApi({} as PreloadApi['automations'])

    await expect(
      api.runExternalAction({
        managerId: 'hermes:local',
        provider: 'hermes',
        target: { type: 'local' },
        jobId: 'job-1',
        action: 'run'
      })
    ).resolves.toBeUndefined()
    expect(invokeMock).toHaveBeenCalledWith('external_automations_mutate_local', {
      input: expect.objectContaining({
        operation: 'action',
        provider: 'hermes',
        jobId: 'job-1',
        action: 'run'
      })
    })
  })

  it('loads local Hermes run history through the Rust host', async () => {
    invokeMock.mockResolvedValueOnce({
      total: 3,
      runs: [
        {
          id: 'job-1:2026-05-14_09-00-00.md',
          job_id: 'job-1',
          run_at: '2026-05-14T09:00:00',
          status: 'completed',
          output_preview: 'Finished the newest run.',
          output_content: '## Response\n\nFinished the newest run.',
          output_path: '/home/me/.hermes/cron/output/job-1/2026-05-14_09-00-00.md'
        }
      ]
    })
    const api = createPebbleAutomationsApi({} as PreloadApi['automations'])

    const page = await api.listExternalRuns({
      managerId: 'hermes:local',
      provider: 'hermes',
      target: { type: 'local' },
      jobId: 'job-1',
      page: 2,
      pageSize: 1
    })

    expect(invokeMock).toHaveBeenCalledWith('external_automations_list_local_runs', {
      input: { jobId: 'job-1', page: 2, pageSize: 1 }
    })
    expect(page).toMatchObject({
      total: 3,
      page: 2,
      pageSize: 1,
      runs: [
        {
          jobId: 'job-1',
          status: 'completed',
          outputPreview: 'Finished the newest run.'
        }
      ]
    })
  })

  it('loads remote Hermes run history through the Go relay-worker route', async () => {
    requestRuntimeJsonMock.mockResolvedValueOnce({
      total: 1,
      runs: [
        {
          id: 'job-1:2026-05-14_09-00-00.md',
          job_id: 'job-1',
          run_at: '2026-05-14T09:00:00',
          status: 'completed',
          output_preview: 'Remote result'
        }
      ]
    })
    const api = createPebbleAutomationsApi({} as PreloadApi['automations'])

    const page = await api.listExternalRuns({
      managerId: 'hermes:ssh:ssh-1',
      provider: 'hermes',
      target: { type: 'ssh', connectionId: 'ssh-1' },
      jobId: 'job-1',
      page: 1,
      pageSize: 25
    })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/ssh-targets/ssh-1/external-automations',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ operation: 'runs', jobId: 'job-1' })
      })
    )
    expect(page).toMatchObject({
      total: 1,
      runs: [expect.objectContaining({ status: 'completed', outputPreview: 'Remote result' })]
    })
  })

  it('runs remote external mutations through the Go SSH relay-worker route', async () => {
    requestRuntimeJsonMock.mockResolvedValueOnce({ ok: true })
    const api = createPebbleAutomationsApi({} as PreloadApi['automations'])
    await expect(
      api.runExternalAction({
        managerId: 'hermes:ssh:target-1',
        provider: 'hermes',
        target: { type: 'ssh', connectionId: 'target-1' },
        jobId: 'job-1',
        action: 'run'
      })
    ).resolves.toBeUndefined()
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/ssh-targets/target-1/external-automations',
      {
        method: 'POST',
        body: expect.objectContaining({
          version: 1,
          operation: 'action',
          provider: 'hermes',
          jobId: 'job-1',
          action: 'run'
        }),
        timeoutMs: 50_000
      }
    )
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
