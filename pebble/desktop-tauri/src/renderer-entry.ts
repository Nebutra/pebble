import { StrictMode, createElement } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import App from '@/App'
import { RecoverableRenderErrorBoundary } from '@/components/error-boundaries/RecoverableRenderErrorBoundary'
import {
  installRendererCrashDiagnostics,
  recordRendererCrashBreadcrumb
} from '@/lib/crash-diagnostics'
import { applyDocumentTheme } from '@/lib/document-theme'
import { I18nProvider } from '@/i18n/I18nProvider'
import { translate } from '@/i18n/i18n'
import { installPebbleTauriPreloadApi } from './pebble-tauri-preload-api'
import { PRODUCT_NAME } from './product-brand'
import { installTauriAgentStatusApi } from './tauri-agent-status-api'
import { installTauriBrowserRuntimeApi } from './tauri-browser-runtime-api'
import { installTauriDevEducationSuppression } from './tauri-dev-education-suppression'
import { installTauriDeepLinkApi } from './tauri-deep-link-api'
import { installTauriMenuApi } from './tauri-menu-api'
import { runTauriRendererBootstrapStage } from './tauri-renderer-bootstrap-diagnostics'
import { installTauriRuntimePtyApi } from './tauri-runtime-pty-api'
import { installTauriSettingsEventApi } from './tauri-settings-event-api'
import { installTauriShellApi } from './tauri-shell-api'
import { installTauriUpdaterApi } from './tauri-updater-api'
import { installTauriWindowApi } from './tauri-window-api'

export function startPebbleTauriRenderer(): boolean {
  return (
    runTauriRendererBootstrapStage('install-preload-api', installPebbleTauriPreloadApi) &&
    runTauriRendererBootstrapStage(
      'install-dev-education-suppression',
      installTauriDevEducationSuppression
    ) &&
    runTauriRendererBootstrapStage('install-settings-event-api', installTauriSettingsEventApi) &&
    runTauriRendererBootstrapStage('install-window-api', installTauriWindowApi) &&
    runTauriRendererBootstrapStage('install-updater-api', installTauriUpdaterApi) &&
    runTauriRendererBootstrapStage('install-menu-api', installTauriMenuApi) &&
    runTauriRendererBootstrapStage('install-agent-status-api', installTauriAgentStatusApi) &&
    runTauriRendererBootstrapStage('install-runtime-pty-api', installTauriRuntimePtyApi) &&
    runTauriRendererBootstrapStage('install-browser-runtime-api', installTauriBrowserRuntimeApi) &&
    runTauriRendererBootstrapStage('install-shell-api', installTauriShellApi) &&
    runTauriRendererBootstrapStage('install-deep-link-api', installTauriDeepLinkApi) &&
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

function renderReactRoot(): void {
  const rootElement = document.getElementById('root')
  if (!rootElement) {
    recordRendererCrashBreadcrumb('renderer_root_missing')
    throw new Error('Renderer root element not found.')
  }

  createRoot(rootElement).render(
    createElement(
      StrictMode,
      null,
      createElement(I18nProvider, null, createElement(RendererRoot))
    )
  )
  recordRendererCrashBreadcrumb('renderer_bootstrap_rendered')
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
      ),
      children: createElement(App)
    }
  )
}
