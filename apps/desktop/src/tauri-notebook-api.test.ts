import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ensureRuntimeMock, requestRuntimeMock, runtimeCallMock } = vi.hoisted(() => ({
  ensureRuntimeMock: vi.fn(),
  requestRuntimeMock: vi.fn(),
  runtimeCallMock: vi.fn()
}))
vi.mock('./pebble-tauri-runtime-transport', () => ({
  ensurePebbleRuntimeProcess: ensureRuntimeMock,
  requestRuntimeJson: requestRuntimeMock
}))

import { createPebbleNotebookApi } from './tauri-notebook-api'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCallMock } } })
})

describe('createPebbleNotebookApi', () => {
  it('executes cells through the native Go runtime', async () => {
    requestRuntimeMock.mockResolvedValue({ stdout: '42\n', stderr: '', exitCode: 0 })
    const args = { filePath: '/tmp/analysis.py', preamble: 'x = 40', code: 'print(x + 2)' }
    await expect(createPebbleNotebookApi().runPythonCell(args)).resolves.toMatchObject({
      stdout: '42\n',
      exitCode: 0
    })
    expect(ensureRuntimeMock).toHaveBeenCalledOnce()
    expect(requestRuntimeMock).toHaveBeenCalledWith('/v1/notebook/run-python-cell', {
      method: 'POST',
      body: args
    })
  })

  it('executes SSH cells on the paired runtime without starting local Go', async () => {
    runtimeCallMock.mockResolvedValue({
      ok: true,
      result: { stdout: 'remote\n', stderr: '', exitCode: 0 }
    })
    await expect(
      createPebbleNotebookApi().runPythonCell({
        filePath: '/srv/repo/notebook.ipynb',
        code: 'print("remote")',
        preamble: 'value = 1',
        connectionId: 'runtime-remote'
      })
    ).resolves.toEqual({ stdout: 'remote\n', stderr: '', exitCode: 0 })
    expect(runtimeCallMock).toHaveBeenCalledWith({
      selector: 'runtime-remote',
      method: 'notebook.runPythonCell',
      params: {
        filePath: '/srv/repo/notebook.ipynb',
        code: 'print("remote")',
        preamble: 'value = 1'
      },
      timeoutMs: 65_000
    })
    expect(ensureRuntimeMock).not.toHaveBeenCalled()
    expect(requestRuntimeMock).not.toHaveBeenCalled()
  })

  it('surfaces paired runtime execution errors without local fallback', async () => {
    runtimeCallMock.mockResolvedValue({
      ok: false,
      error: { code: 'notebook_execution_failed', message: 'remote Python was not found' }
    })
    await expect(
      createPebbleNotebookApi().runPythonCell({
        filePath: '/srv/repo/notebook.ipynb',
        code: 'print(1)',
        connectionId: 'runtime-remote'
      })
    ).rejects.toThrow('remote Python was not found')
    expect(ensureRuntimeMock).not.toHaveBeenCalled()
  })
})
