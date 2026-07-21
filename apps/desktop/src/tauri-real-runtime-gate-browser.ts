import { useAppStore } from '@/store'
import { waitFor, writeProgress } from './tauri-real-runtime-gate-evidence'

export async function verifyNativeBrowser(
  worktreeId: string,
  url: string
): Promise<Record<string, unknown>> {
  let browserLoadError: Error | null = null
  const previousLoadFailureReporter = window.__pebbleReportTauriBrowserLoadFailure
  // Why: a child-WebView creation failure must fail with its native reason;
  // retrying screenshots until the outer timeout hides the actionable error.
  window.__pebbleReportTauriBrowserLoadFailure = (args) => {
    previousLoadFailureReporter?.(args)
    browserLoadError = new Error(
      `native browser load failed (${args.loadError.code}): ${args.loadError.description}`
    )
  }
  const nativeInputOnly =
    String(import.meta.env.VITE_TAURI_REAL_RUNTIME_NATIVE_INPUT_ONLY) === 'true'
  const nativeDragOnly = String(import.meta.env.VITE_TAURI_REAL_RUNTIME_NATIVE_DRAG_ONLY) === 'true'
  const focusedNativeInputGate = nativeInputOnly || nativeDragOnly
  const browserPageId = focusedNativeInputGate
    ? crypto.randomUUID()
    : useAppStore.getState().createBrowserTab(worktreeId, url, {
        title: 'Native browser gate',
        activate: true
      }).activePageId
  if (!browserPageId) {
    throw new Error('browser gate produced no page id')
  }
  await writeProgress('browser-tab-created')
  if (focusedNativeInputGate) {
    await mountNativeInputGateWebview(browserPageId, url)
  }
  await waitFor(
    () =>
      document.querySelector(`[data-tauri-browser-page-webview="${CSS.escape(browserPageId)}"]`) !==
      null
  )
  await writeProgress('browser-webview-mounted')
  const { captureTauriBrowserPageScreenshot, evaluateTauriBrowserPageExpression } =
    await import('@/components/browser-pane/tauri-browser-page-webview')
  const screenshot = await waitFor(async () => {
    if (browserLoadError) {
      throw browserLoadError
    }
    return captureTauriBrowserPageScreenshot(browserPageId).catch(() => null)
  })
  await writeProgress('browser-screenshot-captured')
  const screenshotBytes = Math.floor((screenshot.data.length * 3) / 4)
  if (screenshot.format !== 'png' || screenshotBytes < 2_000) {
    throw new Error('native browser screenshot was empty or invalid')
  }
  let trustedInputEvidence: Record<string, unknown> = { browserNativeMouseInput: false }
  if (navigator.userAgent.includes('Mac')) {
    await waitFor(async () => {
      try {
        const evaluation = await evaluateTauriBrowserPageExpression(
          browserPageId,
          `location.href === ${JSON.stringify(url)}`
        )
        return evaluation.result === 'true'
      } catch {
        return false
      }
    })
    const { verifyMacosTrustedBrowserDrag, verifyMacosTrustedBrowserInput } =
      await import('./tauri-real-runtime-native-input-evidence')
    trustedInputEvidence = nativeDragOnly
      ? await verifyMacosTrustedBrowserDrag(browserPageId, writeProgress)
      : await verifyMacosTrustedBrowserInput(browserPageId, writeProgress)
    await writeProgress('browser-native-input-boundary-verified')
  }
  return {
    browserPageId,
    browserLoaded: true,
    ...trustedInputEvidence,
    browserScreenshotBytes: screenshotBytes
  }
}

async function mountNativeInputGateWebview(browserPageId: string, url: string): Promise<void> {
  const { ensureTauriBrowserPageWebview } =
    await import('@/components/browser-pane/tauri-browser-page-webview')
  const container = document.createElement('div')
  container.dataset.functionalNativeInputHost = 'true'
  Object.assign(container.style, {
    bottom: '0',
    left: '0',
    position: 'fixed',
    right: '0',
    top: '64px',
    zIndex: '2147483645'
  })
  document.body.append(container)
  // Why: focused evidence may run without BrowserPane mounted, but must still
  // use the production child-WebView factory and its native navigation path.
  const { webview } = ensureTauriBrowserPageWebview({
    browserTabId: browserPageId,
    container,
    inputLocked: false,
    webviewPartition: 'persist:pebble-functional-native-input'
  })
  const domReady = new Promise<void>((resolve) => {
    const handleDomReady = (): void => {
      webview.removeEventListener('dom-ready', handleDomReady)
      resolve()
    }
    webview.addEventListener('dom-ready', handleDomReady)
  })
  webview.src = url
  await domReady
  await window.api.browser.registerGuest({
    browserPageId,
    workspaceId: 'functional-native-input',
    worktreeId: 'functional-native-input',
    sessionProfileId: null,
    webContentsId: webview.getWebContentsId()
  })
}
