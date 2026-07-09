import { invoke } from '@tauri-apps/api/core'

import type { PreloadApi } from '../../../src/preload/api-types'
import type {
  CrashReportBreadcrumbData,
  CrashReportRecord,
  CrashReportSubmitArgs,
  CrashReportSubmitResult,
  ReactErrorBoundaryReportArgs,
  ReactErrorBoundaryReportResult
} from '../../../src/shared/crash-reporting'
import rootPackage from '../../../package.json'

type CrashReportTextArgs = {
  reportId?: string
  notes?: string
}

export function createPebbleCrashReportsApi(
  base: PreloadApi['crashReports']
): PreloadApi['crashReports'] {
  return {
    ...base,
    getLatestPending: () => invoke<CrashReportRecord | null>('crash_reports_get_latest_pending'),
    getLatestReport: () => invoke<CrashReportRecord | null>('crash_reports_get_latest_report'),
    dismiss: ({ reportId }) =>
      invoke<CrashReportRecord | null>('crash_reports_dismiss', {
        input: { reportId }
      }),
    recordRendererError: (args) => recordRendererError(args),
    recordBreadcrumb: (args) => {
      void invoke<void>('crash_reports_record_breadcrumb', { input: args }).catch(() => undefined)
    },
    submit: (args) => submitCrashReport(args),
    copyLatestDiagnostics: async (args) => {
      try {
        const text = await formatCrashReportText(args)
        await writeClipboardText(text)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  }
}

async function recordRendererError(
  args: ReactErrorBoundaryReportArgs
): Promise<ReactErrorBoundaryReportResult> {
  try {
    return await invoke<ReactErrorBoundaryReportResult>('crash_reports_record_renderer_error', {
      input: {
        ...args,
        appVersion: rootPackage.version,
        chromeVersion: readChromeVersion()
      }
    })
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function submitCrashReport(args: CrashReportSubmitArgs): Promise<CrashReportSubmitResult> {
  return invoke<CrashReportSubmitResult>('crash_reports_submit', {
    input: {
      ...args,
      appVersion: rootPackage.version,
      chromeVersion: readChromeVersion()
    }
  })
}

function formatCrashReportText(args?: CrashReportTextArgs): Promise<string> {
  return invoke<string>('crash_reports_format', {
    input: {
      ...args,
      appVersion: rootPackage.version,
      chromeVersion: readChromeVersion()
    }
  })
}

function readChromeVersion(): string {
  return (
    navigator.userAgent.match(/(?:Chrome|Chromium)\/([^\s]+)/)?.[1] ??
    navigator.userAgent.match(/Version\/([^\s]+)/)?.[1] ??
    'unknown'
  )
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  writeClipboardTextWithSelection(text)
}

function writeClipboardTextWithSelection(text: string): void {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    if (!document.execCommand('copy')) {
      throw new Error('Failed to write crash diagnostics to clipboard.')
    }
  } finally {
    textarea.remove()
  }
}

export type TauriCrashReportBreadcrumbInput = {
  name: string
  data?: CrashReportBreadcrumbData
}
