import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { createPebbleExportApi } from './tauri-export-api'

describe('createPebbleExportApi', () => {
  beforeEach(() => invokeMock.mockReset())

  it('renders and saves HTML through the native Tauri host', async () => {
    invokeMock.mockResolvedValue({ success: true, filePath: '/tmp/report.pdf' })
    const input = { html: '<html><body>Report</body></html>', title: 'Report' }

    await expect(createPebbleExportApi().htmlToPdf(input)).resolves.toEqual({
      success: true,
      filePath: '/tmp/report.pdf'
    })
    expect(invokeMock).toHaveBeenCalledWith('export_html_to_pdf', { input })
  })
})
