import { invoke } from '@tauri-apps/api/core'
import { getVersion as getTauriAppVersion } from '@tauri-apps/api/app'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type {
  CrashReportBreadcrumbData,
  CrashReportRecord,
  CrashReportSubmitArgs,
  CrashReportSubmitResult,
  ReactErrorBoundaryReportArgs,
  ReactErrorBoundaryReportResult
} from '../../../packages/product-core/shared/crash-reporting'

type CrashReportTextArgs = {
  reportId?: string
  notes?: string
}

let appVersionPromise: Promise<string> | null = null

export function createPebbleCrashReportsApi(
  base: PreloadApi['crashReports']
): PreloadApi['crashReports'] {
  let breadcrumbWriteQueue: Promise<void> = Promise.resolve()
  const recordBreadcrumb = (args: TauriCrashReportBreadcrumbInput): void => {
    // Why: crash capture must observe breadcrumbs recorded immediately before
    // it, while a failed best-effort breadcrumb must not poison later writes.
    breadcrumbWriteQueue = breadcrumbWriteQueue
      .then(() => invoke<void>('crash_reports_record_breadcrumb', { input: args }))
      .catch(() => undefined)
  }
  const waitForBreadcrumbWrites = (): Promise<void> => breadcrumbWriteQueue
  return {
    ...base,
    getLatestPending: () => invoke<CrashReportRecord | null>('crash_reports_get_latest_pending'),
    getLatestReport: () => invoke<CrashReportRecord | null>('crash_reports_get_latest_report'),
    dismiss: ({ reportId }) =>
      invoke<CrashReportRecord | null>('crash_reports_dismiss', {
        input: { reportId }
      }),
    recordRendererError: (args) => recordRendererError(args, waitForBreadcrumbWrites),
    recordBreadcrumb,
    submit: (args) => submitCrashReport(args, waitForBreadcrumbWrites),
    copyLatestDiagnostics: async (args) => {
      try {
        const text = await formatCrashReportText(args, waitForBreadcrumbWrites)
        await writeClipboardText(text)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  }
}

async function recordRendererError(
  args: ReactErrorBoundaryReportArgs,
  waitForBreadcrumbWrites: () => Promise<void>
): Promise<ReactErrorBoundaryReportResult> {
  try {
    const appVersion = await readAppVersion()
    await waitForBreadcrumbWrites()
    return await invoke<ReactErrorBoundaryReportResult>('crash_reports_record_renderer_error', {
      input: {
        ...args,
        appVersion,
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

async function submitCrashReport(
  args: CrashReportSubmitArgs,
  waitForBreadcrumbWrites: () => Promise<void>
): Promise<CrashReportSubmitResult> {
  const appVersion = await readAppVersion()
  await waitForBreadcrumbWrites()
  return invoke<CrashReportSubmitResult>('crash_reports_submit', {
    input: {
      ...args,
      appVersion,
      chromeVersion: readChromeVersion()
    }
  })
}

async function formatCrashReportText(
  args: CrashReportTextArgs | undefined,
  waitForBreadcrumbWrites: () => Promise<void>
): Promise<string> {
  const appVersion = await readAppVersion()
  await waitForBreadcrumbWrites()
  return invoke<string>('crash_reports_format', {
    input: {
      ...args,
      appVersion,
      chromeVersion: readChromeVersion()
    }
  })
}

function readAppVersion(): Promise<string> {
  appVersionPromise ??= getTauriAppVersion()
  return appVersionPromise
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
