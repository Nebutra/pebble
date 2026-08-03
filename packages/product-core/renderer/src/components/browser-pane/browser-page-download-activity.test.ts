import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type DownloadRequestedCallback = (event: { downloadId: string; browserPageId: string }) => void
type DownloadFinishedCallback = (event: { downloadId: string }) => void

describe('browser page download activity', () => {
  let requestedCallbacks: DownloadRequestedCallback[]
  let finishedCallbacks: DownloadFinishedCallback[]
  let removedRequested: boolean
  let removedFinished: boolean

  beforeEach(() => {
    vi.resetModules()
    requestedCallbacks = []
    finishedCallbacks = []
    removedRequested = false
    removedFinished = false
    vi.stubGlobal('window', {
      api: {
        browser: {
          onDownloadRequested: (callback: DownloadRequestedCallback) => {
            requestedCallbacks.push(callback)
            return () => {
              removedRequested = true
            }
          },
          onDownloadFinished: (callback: DownloadFinishedCallback) => {
            finishedCallbacks.push(callback)
            return () => {
              removedFinished = true
            }
          }
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('tracks active downloads per page and clears on finish', async () => {
    const { hasActiveBrowserPageDownload, installBrowserPageDownloadActivityTracking } =
      await import('./browser-page-download-activity')

    const uninstall = installBrowserPageDownloadActivityTracking()
    requestedCallbacks[0]!({ downloadId: 'd1', browserPageId: 'page-1' })
    requestedCallbacks[0]!({ downloadId: 'd2', browserPageId: 'page-1' })
    expect(hasActiveBrowserPageDownload('page-1')).toBe(true)

    finishedCallbacks[0]!({ downloadId: 'd1' })
    expect(hasActiveBrowserPageDownload('page-1')).toBe(true)
    finishedCallbacks[0]!({ downloadId: 'd2' })
    expect(hasActiveBrowserPageDownload('page-1')).toBe(false)

    uninstall()
    expect(removedRequested).toBe(true)
    expect(removedFinished).toBe(true)
  })

  it('ignores duplicate start events for the same download id', async () => {
    const { hasActiveBrowserPageDownload, installBrowserPageDownloadActivityTracking } =
      await import('./browser-page-download-activity')

    const uninstall = installBrowserPageDownloadActivityTracking()
    requestedCallbacks[0]!({ downloadId: 'd1', browserPageId: 'page-1' })
    requestedCallbacks[0]!({ downloadId: 'd1', browserPageId: 'page-1' })
    finishedCallbacks[0]!({ downloadId: 'd1' })
    expect(hasActiveBrowserPageDownload('page-1')).toBe(false)
    uninstall()
  })
})
