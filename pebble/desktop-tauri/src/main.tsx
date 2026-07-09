import './pebble-renderer.css'

import { StrictMode } from 'react'
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
import { installTauriRuntimePtyApi } from './tauri-runtime-pty-api'
import { installTauriSettingsEventApi } from './tauri-settings-event-api'
import { installTauriShellApi } from './tauri-shell-api'
import { installTauriUpdaterApi } from './tauri-updater-api'
import { installTauriWindowApi } from './tauri-window-api'

installPebbleTauriPreloadApi()
installTauriDevEducationSuppression()
installTauriSettingsEventApi()
installTauriWindowApi()
installTauriUpdaterApi()
installTauriMenuApi()
installTauriAgentStatusApi()
installTauriRuntimePtyApi()
installTauriBrowserRuntimeApi()
installTauriShellApi()
installTauriDeepLinkApi()
recordRendererCrashBreadcrumb('renderer_bootstrap_started', {
  dev: import.meta.env.DEV
})
installRendererCrashDiagnostics()
applyDocumentTheme('system', { disableTransitions: false })

const rootElement = document.getElementById('root')
if (!rootElement) {
  recordRendererCrashBreadcrumb('renderer_root_missing')
  throw new Error('Renderer root element not found.')
}

function RendererRoot(): React.JSX.Element {
  useTranslation()
  return (
    <RecoverableRenderErrorBoundary
      boundaryId="app.root"
      surface="app-root"
      title={translate('app.recoverableError.rootTitle', `${PRODUCT_NAME} hit a renderer error.`)}
      description={translate(
        'app.recoverableError.rootDescription',
        `The app shell could not finish rendering. Retry to remount it, or relaunch ${PRODUCT_NAME} if the error persists.`
      )}
    >
      <App />
    </RecoverableRenderErrorBoundary>
  )
}

createRoot(rootElement).render(
  <StrictMode>
    <I18nProvider>
      <RendererRoot />
    </I18nProvider>
  </StrictMode>
)
recordRendererCrashBreadcrumb('renderer_bootstrap_rendered')
