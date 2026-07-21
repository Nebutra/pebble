import { beforeEach, describe, expect, it, vi } from 'vitest'

const { homeDirMock, invokeMock, requestRuntimeJsonMock } = vi.hoisted(() => ({
  homeDirMock: vi.fn(),
  invokeMock: vi.fn(),
  requestRuntimeJsonMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: homeDirMock
}))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: requestRuntimeJsonMock
}))

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { createPebbleGitTextGenerationApi } from './tauri-source-control-text-generation'

function createGitApi(): PreloadApi['git'] {
  return createPebbleGitTextGenerationApi({} as PreloadApi['git'])
}

const customParams = {
  agentId: 'custom' as const,
  model: 'custom',
  customAgentCommand: 'printf {prompt}'
}

beforeEach(() => {
  vi.clearAllMocks()
  homeDirMock.mockResolvedValue('/Users/test')
})

describe('createPebbleGitTextGenerationApi', () => {
  it('generates a commit message through the native Tauri text-generation host', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'source_control_text_generation_commit_context') {
        return {
          branch: 'feature/tauri-ai',
          stagedSummary: 'M\tREADME.md',
          stagedPatch: 'diff --git a/README.md b/README.md\n+Tauri text generation'
        }
      }
      throw new Error(`unexpected command ${command}`)
    })
    requestRuntimeJsonMock.mockResolvedValue({
      stdout: 'Add Tauri source control AI generation\n',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      canceled: false,
      spawnError: null
    })

    await expect(
      createGitApi().generateCommitMessage({
        worktreePath: '/repo/worktree',
        sourceControlAiResolvedParams: customParams
      })
    ).resolves.toEqual({
      success: true,
      message: 'Add Tauri source control AI generation',
      agentLabel: 'printf'
    })

    expect(invokeMock).toHaveBeenCalledWith('source_control_text_generation_commit_context', {
      input: { cwd: '/repo/worktree' }
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/providers/text-generation/execute',
      expect.objectContaining({
        body: expect.objectContaining({
          cwd: '/repo/worktree',
          binary: 'printf',
          laneKey: 'commit-message:local:/repo/worktree',
          target: { kind: 'local' }
        })
      })
    )
  })

  it('generates pull request fields from native branch context', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'source_control_text_generation_pull_request_context') {
        return {
          branch: 'feature/pr',
          base: 'main',
          branchChangedByPreparation: false,
          currentTitle: '',
          currentBody: '',
          currentDraft: false,
          commitSummary: '- Add PR generation',
          changeSummary: 'M\tREADME.md',
          patch: 'diff --git a/README.md b/README.md\n+PR generation'
        }
      }
      throw new Error(`unexpected command ${command}`)
    })
    requestRuntimeJsonMock.mockResolvedValue({
      stdout: JSON.stringify({
        title: 'Add Tauri PR generation',
        body: 'Summary\n- Adds native generation.',
        draft: true
      }),
      stderr: '',
      exitCode: 0,
      timedOut: false,
      canceled: false,
      spawnError: null
    })

    await expect(
      createGitApi().generatePullRequestFields({
        worktreePath: '/repo/worktree',
        base: 'main',
        title: '',
        body: '',
        draft: false,
        sourceControlAiResolvedParams: customParams
      })
    ).resolves.toMatchObject({
      success: true,
      fields: {
        base: 'main',
        title: 'Add Tauri PR generation',
        body: 'Summary\n- Adds native generation.',
        draft: true
      },
      agentLabel: 'printf',
      branchChangedByPreparation: false
    })
  })

  it('generates a commit message through the SSH relay context when connectionId is set', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path: string, options: { body?: unknown }) => {
      if (path.includes('git-text-generation-context')) {
        expect(options.body).toMatchObject({
          kind: 'commit',
          repoRoot: '/remote/repo'
        })
        return {
          branch: 'main',
          stagedSummary: 'M\tREADME.md',
          stagedPatch: 'diff --git a/README.md b/README.md\n+SSH relay generation'
        }
      }
      expect(path).toBe('/v1/providers/text-generation/execute')
      expect(options.body).toMatchObject({
        target: { kind: 'ssh', sshTargetId: 'conn-1' },
        laneKey: 'commit-message:ssh:conn-1:/remote/repo'
      })
      return {
        stdout: 'Add SSH relay commit generation\n',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        canceled: false,
        spawnError: null
      }
    })

    await expect(
      createGitApi().generateCommitMessage({
        worktreePath: '/remote/repo',
        connectionId: 'conn-1',
        sourceControlAiResolvedParams: customParams
      })
    ).resolves.toEqual({
      success: true,
      message: 'Add SSH relay commit generation',
      agentLabel: 'printf'
    })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/ssh-targets/conn-1/git-text-generation-context',
      expect.objectContaining({
        method: 'POST',
        body: { kind: 'commit', repoRoot: '/remote/repo' }
      })
    )
    // Local invoke must never be asked to read commit context for an SSH project.
    expect(invokeMock).not.toHaveBeenCalledWith(
      'source_control_text_generation_commit_context',
      expect.anything()
    )
  })

  it('surfaces a relay failure instead of the old hardcoded not-wired error', async () => {
    requestRuntimeJsonMock.mockRejectedValue(new Error('ssh target not found'))

    const result = await createGitApi().generateCommitMessage({
      worktreePath: '/remote/repo',
      connectionId: 'conn-missing',
      sourceControlAiResolvedParams: customParams
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('ssh target not found')
      expect(result.error).not.toContain('not yet wired')
    }
  })

  it('generates pull request fields through the SSH relay context when connectionId is set', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path: string, options: { body?: unknown }) => {
      if (path.includes('git-text-generation-context')) {
        expect(options.body).toMatchObject({
          kind: 'pull-request',
          repoRoot: '/remote/repo',
          base: 'main'
        })
        return {
          branch: 'feature/relay-pr',
          base: 'main',
          branchChangedByPreparation: false,
          currentTitle: '',
          currentBody: '',
          currentDraft: false,
          commitSummary: '- Add relay PR generation',
          changeSummary: 'M\tREADME.md',
          patch: 'diff --git a/README.md b/README.md\n+relay PR'
        }
      }
      expect(path).toBe('/v1/providers/text-generation/execute')
      return {
        stdout: JSON.stringify({
          title: 'Add SSH relay PR generation',
          body: 'Summary\n- Adds relay-backed generation.',
          draft: false
        }),
        stderr: '',
        exitCode: 0,
        timedOut: false,
        canceled: false,
        spawnError: null
      }
    })

    await expect(
      createGitApi().generatePullRequestFields({
        worktreePath: '/remote/repo',
        connectionId: 'conn-1',
        base: 'main',
        title: '',
        body: '',
        draft: false,
        sourceControlAiResolvedParams: customParams
      })
    ).resolves.toMatchObject({
      success: true,
      fields: {
        base: 'main',
        title: 'Add SSH relay PR generation',
        body: 'Summary\n- Adds relay-backed generation.',
        draft: false
      },
      agentLabel: 'printf',
      branchChangedByPreparation: false
    })

    expect(invokeMock).not.toHaveBeenCalledWith(
      'source_control_text_generation_pull_request_context',
      expect.anything()
    )
  })

  it('reports no branch changes when the relay reports nothing to summarize', async () => {
    requestRuntimeJsonMock.mockResolvedValue(null)

    const result = await createGitApi().generatePullRequestFields({
      worktreePath: '/remote/repo',
      connectionId: 'conn-1',
      base: 'main',
      title: '',
      body: '',
      draft: false,
      sourceControlAiResolvedParams: customParams
    })

    expect(result).toMatchObject({
      success: false,
      error: 'No branch changes to summarize.'
    })
  })

  it('cancels the exact SSH generation lane through the runtime', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ canceled: true })

    await createGitApi().cancelGenerateCommitMessage({
      worktreePath: '/remote/repo',
      connectionId: 'conn-1'
    })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/providers/text-generation/cancel', {
      method: 'POST',
      body: { laneKey: 'commit-message:ssh:conn-1:/remote/repo' },
      timeoutMs: 5_000
    })
  })

  it('surfaces a native timeout without generating fallback text', async () => {
    invokeMock.mockResolvedValue({
      branch: 'main',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+change'
    })
    requestRuntimeJsonMock.mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: true,
      canceled: false,
      spawnError: null
    })

    await expect(
      createGitApi().generateCommitMessage({
        worktreePath: '/repo',
        sourceControlAiResolvedParams: customParams
      })
    ).resolves.toEqual({
      success: false,
      error: 'Generation timed out after 60s.'
    })
  })
})
