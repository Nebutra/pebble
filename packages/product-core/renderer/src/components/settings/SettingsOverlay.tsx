import { memo, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { scheduleAfterInputQuiet } from '@/lib/input-quiet-scheduler'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

const loadSettingsRoute = () =>
  import('./Settings').then((module) => {
    const SettingsContent = module.default
    return {
      default: ({ onPrepared }: { onPrepared: () => void }) => (
        <PreparedSettingsRoute onPrepared={onPrepared}>
          <SettingsContent />
        </PreparedSettingsRoute>
      )
    }
  })
const SettingsRoute = lazy(loadSettingsRoute, { reloadKey: 'settings' })
const RetainedSettingsRoute = memo(SettingsRoute)

type SettingsOverlayLayersProps = {
  children: ReactNode
  settingsPrepared: boolean
  settingsVisible: boolean
}

function SettingsLoadingFallback(): React.JSX.Element {
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center bg-background text-muted-foreground"
      data-settings-loading
      role="status"
    >
      {translate('auto.components.settings.Settings.c7ad095d96', 'Loading settings...')}
    </div>
  )
}

function PreparedSettingsRoute({
  children,
  onPrepared
}: {
  children: ReactNode
  onPrepared: () => void
}): React.JSX.Element {
  useEffect(() => {
    // Why: imported modules can still have deferred hidden render work. Wait
    // through a paint before pane preloads may compete for the main thread.
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(onPrepared)
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [onPrepared])

  return <>{children}</>
}

export function SettingsOverlayLayers({
  children,
  settingsPrepared,
  settingsVisible
}: SettingsOverlayLayersProps): React.JSX.Element | null {
  if (!settingsVisible && !settingsPrepared) {
    return null
  }

  return (
    <>
      <div
        className={`settings-overlay-layer absolute inset-x-0 top-0 z-30 h-[36px] border-b border-border bg-background ${
          settingsVisible ? '' : 'settings-overlay-layer--hidden pointer-events-none'
        }`}
        aria-hidden={!settingsVisible}
        data-settings-overlay
        data-tauri-drag-region
      />
      <div
        className={`settings-overlay-layer absolute inset-x-0 bottom-0 top-[36px] z-30 flex min-h-0 overflow-hidden bg-background ${
          settingsVisible
            ? 'pointer-events-auto'
            : 'settings-overlay-layer--hidden pointer-events-none'
        }`}
        aria-hidden={!settingsVisible}
        data-settings-overlay
        inert={!settingsVisible}
        style={{ contain: 'layout paint style' }}
      >
        {/* Why: a cold Settings import must not suspend the app root and blank
        the workbench before this opaque overlay is ready. */}
        {/* Why: disconnecting this retained tree's effects makes every open
        reconnect the entire Settings route. CSS/inert keeps switching composited. */}
        <Suspense fallback={<SettingsLoadingFallback />}>{children}</Suspense>
      </div>
    </>
  )
}

export function SettingsOverlay(): React.JSX.Element | null {
  const settingsVisible = useAppStore((state) => state.settingsPageOpen)
  const [settingsPrepared, setSettingsPrepared] = useState(false)
  const [settingsCommitted, setSettingsCommitted] = useState(false)
  const markSettingsCommitted = useCallback(() => setSettingsCommitted(true), [])

  useEffect(() => {
    // Why: Settings is a large route. Import and hidden-prerender it only after
    // input is quiet so opening it never competes with startup typing.
    let cancelled = false
    const cancelRoutePreload = scheduleAfterInputQuiet(
      () => {
        void Promise.all([loadSettingsRoute(), import('./settings-pane-components')])
          .then(() => {
            if (cancelled) {
              return
            }
            setSettingsPrepared(true)
          })
          .catch(() => undefined)
      },
      { delayMs: 350, quietMs: 250, idleTimeoutMs: 1_500 }
    )
    return () => {
      cancelled = true
      cancelRoutePreload()
    }
  }, [])

  useEffect(() => {
    if (!settingsCommitted || settingsVisible) {
      return
    }
    // Why: opening Settings must cancel background module evaluation. Resume
    // only while the retained route is hidden and its first paint is complete.
    return preloadSettingsPanesAfterCommit()
  }, [settingsCommitted, settingsVisible])

  return (
    <SettingsOverlayLayers settingsPrepared={settingsPrepared} settingsVisible={settingsVisible}>
      <RetainedSettingsRoute onPrepared={markSettingsCommitted} />
    </SettingsOverlayLayers>
  )
}

function preloadSettingsPanesAfterCommit(): () => void {
  let cancelled = false
  let cancelPanePreloads: (() => void) | undefined
  void import('./settings-pane-components')
    .then((paneComponents) => {
      if (!cancelled) {
        cancelPanePreloads = paneComponents.preloadSettingsPanesInBackground()
      }
    })
    .catch(() => undefined)
  return () => {
    cancelled = true
    cancelPanePreloads?.()
  }
}
