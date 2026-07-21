import { getCurrentWindow } from '@tauri-apps/api/window'

const APP_REGION_PROPERTY = '-webkit-app-region'
const TITLEBAR_HEIGHT = 36
const MAC_TRAFFIC_LIGHT_START_X = 16
const MAC_TRAFFIC_LIGHT_STEP_X = 20
const MAC_TRAFFIC_LIGHT_SIZE = 14
const DRAG_REGION_SELECTOR = [
  '.titlebar',
  '.titlebar-left',
  '.window-controls-titlebar-spacer',
  '.right-sidebar-header-drag',
  '[data-tauri-drag-region]',
  '[data-terminal-focus-release-surface="true"]'
].join(',')
const NO_DRAG_REGION_SELECTOR = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '.window-controls',
  '.right-sidebar-header-no-drag',
  '[data-radix-popper-content-wrapper]',
  '[data-slot="sheet-overlay"]',
  '[data-slot="sheet-content"]',
  '[data-slot="dialog-overlay"]',
  '[data-slot="dialog-content"]'
].join(',')

export function installTauriWindowDragRegions(): () => void {
  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !event.isPrimary || event.defaultPrevented) {
      return
    }
    const pointerAction = resolveTauriTitlebarPointerAction({
      clientX: event.clientX,
      clientY: event.clientY,
      isMac: navigator.userAgent.includes('Mac'),
      isInteractive: isTauriWindowInteractiveTarget(event.target),
      isDragTarget: isTauriWindowDragTarget(event.target)
    })
    if (pointerAction === null) {
      return
    }
    const appWindow = getCurrentWindow()
    if (pointerAction === 'close') {
      // Why: enter the renderer-owned close guard once; calling Tauri close here
      // re-enters onCloseRequested before the renderer can confirm the action.
      window.api.ui.requestClose()
      return
    }
    if (pointerAction === 'minimize') {
      void appWindow.minimize().catch(() => undefined)
      return
    }
    if (pointerAction === 'toggle-maximize') {
      void appWindow.toggleMaximize().catch(() => undefined)
      return
    }
    // Why: Tauri does not translate Electron's CSS app-region hit testing on every WebView backend.
    void appWindow.startDragging().catch(() => undefined)
  }
  const onDoubleClick = (event: MouseEvent): void => {
    if (event.button !== 0 || event.defaultPrevented || !isTauriWindowDragTarget(event.target)) {
      return
    }
    void getCurrentWindow()
      .toggleMaximize()
      .catch(() => undefined)
  }
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('dblclick', onDoubleClick, true)
  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('dblclick', onDoubleClick, true)
  }
}

type TauriTitlebarPointerAction = 'close' | 'minimize' | 'toggle-maximize' | 'drag'

export function resolveTauriTitlebarPointerAction({
  clientX,
  clientY,
  isMac,
  isInteractive,
  isDragTarget
}: {
  clientX: number
  clientY: number
  isMac: boolean
  isInteractive: boolean
  isDragTarget: boolean
}): TauriTitlebarPointerAction | null {
  if (clientY < 0 || clientY >= TITLEBAR_HEIGHT || isInteractive) {
    return isDragTarget && !isInteractive ? 'drag' : null
  }
  if (isMac) {
    const trafficLight = Math.floor(
      (clientX - MAC_TRAFFIC_LIGHT_START_X) / MAC_TRAFFIC_LIGHT_STEP_X
    )
    const offset = (clientX - MAC_TRAFFIC_LIGHT_START_X) % MAC_TRAFFIC_LIGHT_STEP_X
    if (trafficLight >= 0 && trafficLight <= 2 && offset >= 0 && offset < MAC_TRAFFIC_LIGHT_SIZE) {
      return (['close', 'minimize', 'toggle-maximize'] as const)[trafficLight]
    }
  }
  // Why: only canonical chrome may start a native drag. Treating every empty
  // pixel in the top band as draggable steals traffic-light and overlay input.
  return isDragTarget ? 'drag' : null
}

function isTauriWindowInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(NO_DRAG_REGION_SELECTOR) !== null
}

export function isTauriWindowDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false
  }
  const regions: string[] = []
  let element: Element | null = target
  while (element) {
    regions.push(getComputedStyle(element).getPropertyValue(APP_REGION_PROPERTY))
    element = element.parentElement
  }
  const computedIntent = resolveTauriWindowDragIntent(regions)
  if (computedIntent !== null) {
    return computedIntent
  }
  // Why: WKWebView drops Electron's app-region CSS property, so selectors mirror the canonical CSS.
  if (isTauriWindowInteractiveTarget(target)) {
    return false
  }
  const dragRegion = target.closest(DRAG_REGION_SELECTOR)
  if (!dragRegion) {
    return false
  }
  return !document.documentElement.hasAttribute('data-regular-terminal-input-focused')
}

export function resolveTauriWindowDragIntent(
  regionsNearestFirst: readonly string[]
): boolean | null {
  for (const rawRegion of regionsNearestFirst) {
    const region = rawRegion.trim().toLowerCase()
    if (region === 'no-drag') {
      return false
    }
    if (region === 'drag') {
      return true
    }
  }
  return null
}
