import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'

const { getVersionMock, invokeMock } = vi.hoisted(() => ({
  getVersionMock: vi.fn(() => Promise.resolve('1.4.128')),
  invokeMock: vi.fn()
}))

vi.mock('@tauri-apps/api/app', () => ({ getVersion: getVersionMock }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { createPebbleCrashReportsApi } from './tauri-crash-reports-api'

describe('createPebbleCrashReportsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invokeMock.mockResolvedValue({ ok: true, report: null, deduped: false })
  })

  it('records the installed Tauri bundle version in renderer crashes', async () => {
    const api = createPebbleCrashReportsApi({} as PreloadApi['crashReports'])
    await api.recordRendererError({
      boundaryId: 'app.root',
      surface: 'app-root',
      errorName: 'Error',
      errorMessage: 'boom'
    })

    expect(getVersionMock).toHaveBeenCalled()
    expect(invokeMock).toHaveBeenCalledWith('crash_reports_record_renderer_error', {
      input: expect.objectContaining({ appVersion: '1.4.128' })
    })
  })

  it('waits for preceding breadcrumbs before recording a renderer crash', async () => {
    let releaseBreadcrumb: (() => void) | undefined
    invokeMock.mockImplementation((command: string) => {
      if (command === 'crash_reports_record_breadcrumb') {
        return new Promise<void>((resolve) => {
          releaseBreadcrumb = resolve
        })
      }
      return Promise.resolve({ ok: true, report: null, deduped: false })
    })
    const api = createPebbleCrashReportsApi({} as PreloadApi['crashReports'])

    api.recordBreadcrumb({ name: 'before-crash' })
    const recording = api.recordRendererError({
      boundaryId: 'app.root',
      surface: 'app-root',
      errorName: 'Error',
      errorMessage: 'boom'
    })
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('crash_reports_record_breadcrumb', {
        input: { name: 'before-crash' }
      })
    })
    expect(invokeMock).not.toHaveBeenCalledWith(
      'crash_reports_record_renderer_error',
      expect.anything()
    )

    releaseBreadcrumb?.()
    await recording
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'crash_reports_record_breadcrumb',
      'crash_reports_record_renderer_error'
    ])
  })

  it('continues crash recording after a breadcrumb write fails', async () => {
    invokeMock
      .mockRejectedValueOnce(new Error('breadcrumb unavailable'))
      .mockResolvedValueOnce({ ok: true, report: null, deduped: false })
    const api = createPebbleCrashReportsApi({} as PreloadApi['crashReports'])

    api.recordBreadcrumb({ name: 'best-effort' })
    await expect(
      api.recordRendererError({
        boundaryId: 'app.root',
        surface: 'app-root',
        errorName: 'Error',
        errorMessage: 'boom'
      })
    ).resolves.toMatchObject({ ok: true })
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'crash_reports_record_breadcrumb',
      'crash_reports_record_renderer_error'
    ])
  })

  it('serializes breadcrumb bursts in call order', async () => {
    const releases: (() => void)[] = []
    invokeMock.mockImplementation((command: string) => {
      if (command !== 'crash_reports_record_breadcrumb') {
        return Promise.resolve({ ok: true, report: null, deduped: false })
      }
      return new Promise<void>((resolve) => releases.push(resolve))
    })
    const api = createPebbleCrashReportsApi({} as PreloadApi['crashReports'])

    api.recordBreadcrumb({ name: 'first' })
    api.recordBreadcrumb({ name: 'second' })
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    expect(invokeMock).toHaveBeenCalledTimes(1)
    releases[0]()
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    releases[1]()
    await api.recordRendererError({
      boundaryId: 'app.root',
      surface: 'app-root',
      errorName: 'Error',
      errorMessage: 'boom'
    })

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'crash_reports_record_breadcrumb',
      'crash_reports_record_breadcrumb',
      'crash_reports_record_renderer_error'
    ])
  })
})
