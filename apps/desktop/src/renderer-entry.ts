import { StrictMode, createElement } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import App from '@/App'
import { RecoverableRenderErrorBoundary } from '@/components/error-boundaries/RecoverableRenderErrorBoundary'
import {
  installRendererCrashDiagnostics,
  recordRendererCrashBreadcrumb
} from '@/lib/crash-diagnostics'
import { applyDocumentTheme } from '@/lib/document-theme'
import { I18nProvider } from '@/i18n/I18nProvider'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { installPebbleTauriPreloadApi } from './pebble-tauri-preload-api'
import { PRODUCT_NAME } from './product-brand'
import { installTauriAgentStatusApi } from './tauri-agent-status-api'
import { installTauriBrowserRuntimeApi } from './tauri-browser-runtime-api'
import { installTauriClipboardApi } from './tauri-clipboard-api'
import { installTauriDevEducationSuppression } from './tauri-dev-education-suppression'
import { installTauriDeepLinkApi } from './tauri-deep-link-api'
import { installTauriFileDropApi } from './tauri-file-drop-api'
import { installTauriDeveloperPermissionsApi } from './tauri-developer-permissions-api'
import { installTauriEmulatorFrameStreamApi } from './tauri-emulator-frame-stream-api'
import { installTauriEmulatorVideoStreamApi } from './tauri-emulator-video-stream-api'
import { installTauriMenuApi } from './tauri-menu-api'
import { runTauriRendererBootstrapStage } from './tauri-renderer-bootstrap-diagnostics'
import { installTauriRuntimePtyApi } from './tauri-runtime-pty-api'
import { ensureRuntimePtyEventDelivery } from './tauri-runtime-pty-events'
import { installTauriSettingsEventApi } from './tauri-settings-event-api'
import { installTauriStarNagApi } from './tauri-star-nag-api'
import { installTauriSessionPersistenceApi } from './tauri-session-persistence-api'
import { installTauriShellApi } from './tauri-shell-api'
import { installTauriUpdaterApi } from './tauri-updater-api'
import { installTauriWindowApi } from './tauri-window-api'
import { installTauriWindowDragRegions } from './tauri-window-drag-regions'

export function startPebbleTauriRenderer(): boolean {
  return (
    runTauriRendererBootstrapStage('install-preload-api', installPebbleTauriPreloadApi) &&
    runTauriRendererBootstrapStage('expose-e2e-store', exposeTauriE2EStore) &&
    runTauriRendererBootstrapStage(
      'install-dev-education-suppression',
      installTauriDevEducationSuppression
    ) &&
    runTauriRendererBootstrapStage('install-settings-event-api', installTauriSettingsEventApi) &&
    runTauriRendererBootstrapStage(
      'install-session-persistence-api',
      installTauriSessionPersistenceApi
    ) &&
    runTauriRendererBootstrapStage('install-window-api', installTauriWindowApi) &&
    runTauriRendererBootstrapStage('install-window-drag-regions', installTauriWindowDragRegions) &&
    runTauriRendererBootstrapStage('install-updater-api', installTauriUpdaterApi) &&
    runTauriRendererBootstrapStage('install-menu-api', installTauriMenuApi) &&
    runTauriRendererBootstrapStage('install-agent-status-api', installTauriAgentStatusApi) &&
    runTauriRendererBootstrapStage('install-star-nag-api', installTauriStarNagApi) &&
    runTauriRendererBootstrapStage('install-runtime-pty-api', installTauriRuntimePtyApi) &&
    runTauriRendererBootstrapStage('start-runtime-event-delivery', () => {
      // Why: browser-only windows still need mobile driver events even when no
      // terminal has registered a PTY data listener.
      ensureRuntimePtyEventDelivery()
    }) &&
    runTauriRendererBootstrapStage('install-browser-runtime-api', installTauriBrowserRuntimeApi) &&
    runTauriRendererBootstrapStage(
      'install-emulator-frame-stream-api',
      installTauriEmulatorFrameStreamApi
    ) &&
    runTauriRendererBootstrapStage(
      'install-emulator-video-stream-api',
      installTauriEmulatorVideoStreamApi
    ) &&
    runTauriRendererBootstrapStage('install-clipboard-api', installTauriClipboardApi) &&
    runTauriRendererBootstrapStage('install-file-drop-api', installTauriFileDropApi) &&
    runTauriRendererBootstrapStage('install-shell-api', installTauriShellApi) &&
    runTauriRendererBootstrapStage('install-deep-link-api', installTauriDeepLinkApi) &&
    runTauriRendererBootstrapStage(
      'install-developer-permissions-api',
      installTauriDeveloperPermissionsApi
    ) &&
    runTauriRendererBootstrapStage('install-renderer-crash-diagnostics', () => {
      recordRendererCrashBreadcrumb('renderer_bootstrap_started', {
        dev: import.meta.env.DEV
      })
      installRendererCrashDiagnostics()
    }) &&
    runTauriRendererBootstrapStage('apply-document-theme', () => {
      applyDocumentTheme('system', { disableTransitions: false })
    }) &&
    runTauriRendererBootstrapStage('render-react-root', renderReactRoot)
  )
}

function exposeTauriE2EStore(): void {
  if (!window.api.e2e?.getConfig().exposeStore) {
    return // Why: App's static imports initialize the store before Tauri installs its
    // preload API, so the shared module cannot observe this build-only flag.
  }
  ;(window as unknown as Record<string, unknown>).__store = useAppStore
}

function renderReactRoot(): void {
  const rootElement = document.getElementById('root')
  if (!rootElement) {
    recordRendererCrashBreadcrumb('renderer_root_missing')
    throw new Error('Renderer root element not found.')
  }

  createRoot(rootElement).render(
    createElement(StrictMode, null, createElement(I18nProvider, null, createElement(RendererRoot)))
  )
  recordRendererCrashBreadcrumb('renderer_bootstrap_rendered')
  if (String(import.meta.env.VITE_TAURI_REAL_RUNTIME_GATE) === 'true') {
    // Why: release parity must prove the production store, native runtime, and
    // terminal surface together; this chunk is absent from normal startup.
    void import('./tauri-real-runtime-gate')
      .then(({ runTauriRealRuntimeGate }) => runTauriRealRuntimeGate())
      .catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error)
        void invoke('renderer_bootstrap_log', {
          input: { stage: 'real-runtime-gate', message }
        })
      })
  }
}

function RendererRoot(): ReactElement {
  useTranslation()
  return createElement(
    RecoverableRenderErrorBoundary,
    {
      boundaryId: 'app.root',
      surface: 'app-root',
      title: translate('app.recoverableError.rootTitle', `${PRODUCT_NAME} hit a renderer error.`),
      description: translate(
        'app.recoverableError.rootDescription',
        `The app shell could not finish rendering. Retry to remount it, or relaunch ${PRODUCT_NAME} if the error persists.`
      )
    },
    createElement(App)
  )
}
