import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { Webview as NativeTauriBrowserWebview } from '@tauri-apps/api/webview'
import type {
  BrowserFindInPageOptions,
  BrowserPageWebview
} from '../../../../shared/browser-page-webview-types'
import type { BrowserSetAnnotationViewportBridgeArgs } from '../../../../shared/browser-annotation-viewport-bridge'
import type {} from '../../../../shared/browser-video-recording-bridge'
import type {
  BrowserAwaitGrabSelectionArgs,
  BrowserCancelGrabArgs,
  BrowserCaptureSelectionScreenshotArgs,
  BrowserCaptureSelectionScreenshotResult,
  BrowserExtractHoverArgs,
  BrowserExtractHoverResult,
  BrowserGrabResult,
  BrowserSetGrabModeArgs,
  BrowserSetGrabModeResult
} from '../../../../shared/browser-grab-types'
import { GRAB_BUDGET } from '../../../../shared/browser-grab-types'
import { PEBBLE_BROWSER_BLANK_URL, PEBBLE_BROWSER_PARTITION } from '../../../../shared/constants'
import type { BrowserCookieImportResult } from '../../../../shared/types'
import type {
  BrowserCookieDeleteResult,
  BrowserCookieGetResult,
  BrowserCookieSetResult
} from '../../../../shared/runtime-types'
import { clampGrabPayload } from '../../../../shared/browser-grab-payload'
import { buildGuestOverlayScript } from '../../../../shared/browser-grab-guest-script'
import { getEffectiveKeybindingsForAction } from '../../../../shared/keybindings'
import {
  buildTauriBrowserDomAutomationScript,
  type TauriBrowserDomCommand
} from './tauri-browser-dom-automation'
import { ensureTauriBrowserPermissionProfile } from './tauri-browser-permission-profile'
import { registerPersistentWebview, webviewRegistry } from './webview-registry'

type TauriBrowserWebviewState = {
  browserTabId: string
  element: TauriBrowserWebview
  container: HTMLDivElement
  currentUrl: string
  title: string
  history: string[]
  historyIndex: number
  generation: number
  loading: boolean
  findRequestId: number
  destroyed: boolean
  inputLocked: boolean
  zoomLevel: number
  deviceEmulation: TauriBrowserDeviceEmulation | null
  nativeUserAgent: string | null
  nativeWebview: NativeTauriBrowserWebview | null
  webviewPartition: string
  resizeObserver: ResizeObserver | null
  mutationObserver: MutationObserver | null
  removeWindowListeners: (() => void) | null
  unregisterActionExecutor: (() => void) | null
  initScripts: Map<string, string>
  performanceProfile: { startedAt: number; segments: Record<string, unknown>[] } | null
}

export type TauriBrowserDeviceEmulation = {
  name: string
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
}

type TauriBrowserWebview = BrowserPageWebview & {
  __pebbleTauriBrowserWebviewState?: TauriBrowserWebviewState
  __pebbleDestroyNativeWebview?: () => void
  __pebbleSetNativeBrowserInputLocked?: (locked: boolean) => void
}

type RuntimeComputerAction = {
  id: string
  kind: string
  target?: string
  payload?: Record<string, unknown>
}

type TauriBrowserFindResult = {
  activeMatchOrdinal: number
  matches: number
  finalUpdate: boolean
}

type TauriBrowserPageLoadEvent = {
  browserTabId: string
  label: string
  url: string
  event: 'started' | 'finished'
}

const TAURI_BROWSER_PAGE_LOAD_EVENT = 'pebble://browser-page-load'
const TAURI_BROWSER_PAGE_LOAD_TIMEOUT_MS = 30_000

type TauriBrowserActionExecutorBridge = {
  register: (
    browserPageId: string,
    executor: (action: RuntimeComputerAction) => Promise<Record<string, unknown> | void>
  ) => () => void
}

type TauriBrowserScreencastBridge = {
  start: (input: {
    browserTabId: string
    label: string
    subscriptionId: string
    format: 'jpeg' | 'png'
    minFrameIntervalMs: number
    deviceScaleFactor: number
  }) => Promise<{ streamId: string }>
  stop: (subscriptionId: string) => Promise<void>
  rebind: (browserTabId: string, label: string) => Promise<void>
  stopForTab: (browserTabId: string) => Promise<void>
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __pebbleTauriBrowserActionExecutors?: TauriBrowserActionExecutorBridge
    __pebbleTauriBrowserScreencasts?: TauriBrowserScreencastBridge
    __pebbleReportTauriBrowserLoadFailure?: (args: {
      browserPageId: string
      loadError: { code: number; description: string; validatedUrl: string }
    }) => void
  }
}

const HIDE_GRAB_SCREENSHOT_OVERLAYS = `(function(){
  var grab = window.__pebbleGrab;
  if (grab && grab.host) grab.host.style.display = 'none';
  document.querySelectorAll('[data-pebble-browser-annotation-overlay]').forEach(function(element) {
    element.setAttribute('data-pebble-previous-display', element.style.display || '');
    element.style.display = 'none';
  });
})()`

const RESTORE_GRAB_SCREENSHOT_OVERLAYS = `(function(){
  var grab = window.__pebbleGrab;
  if (grab && grab.host) grab.host.style.display = '';
  document.querySelectorAll('[data-pebble-browser-annotation-overlay]').forEach(function(element) {
    element.style.display = element.getAttribute('data-pebble-previous-display') || '';
    element.removeAttribute('data-pebble-previous-display');
  });
})()`

export function ensureTauriBrowserPageWebview({
  browserTabId,
  container,
  inputLocked,
  webviewPartition
}: {
  browserTabId: string
  container: HTMLDivElement
  inputLocked: boolean
  webviewPartition: string
}): {
  container: HTMLDivElement
  created: boolean
  webview: BrowserPageWebview
} {
  const element = document.createElement('div') as unknown as TauriBrowserWebview
  element.dataset.tauriBrowserPageWebview = browserTabId
  element.setAttribute('partition', webviewPartition)
  element.tabIndex = -1
  element.style.display = 'flex'
  element.style.flex = '1'
  element.style.width = '100%'
  element.style.height = '100%'
  element.style.border = 'none'
  element.style.pointerEvents = inputLocked ? 'none' : 'auto'
  element.style.background = '#ffffff'

  const state: TauriBrowserWebviewState = {
    browserTabId,
    element,
    container,
    currentUrl: PEBBLE_BROWSER_BLANK_URL,
    title: 'New Tab',
    history: [],
    historyIndex: -1,
    generation: 0,
    loading: false,
    findRequestId: 0,
    destroyed: false,
    inputLocked,
    zoomLevel: 0,
    deviceEmulation: null,
    nativeUserAgent: null,
    nativeWebview: null,
    webviewPartition,
    resizeObserver: null,
    mutationObserver: null,
    removeWindowListeners: null,
    unregisterActionExecutor: null,
    initScripts: new Map(),
    performanceProfile: null
  }
  element.__pebbleTauriBrowserWebviewState = state
  installTauriBrowserWebviewShape(element, state)
  installTauriBrowserActionExecutor(element, state)

  registerPersistentWebview(browserTabId, element)
  container.appendChild(element)
  startTauriBrowserWebviewLayoutSync(element, state)
  return { container, created: true, webview: element }
}

export function isTauriBrowserHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

type TauriNativeBrowserInputPlatform = 'macos' | 'windows' | 'linux' | 'unsupported'

function resolveTauriNativeBrowserInputPlatform(): TauriNativeBrowserInputPlatform {
  if (navigator.userAgent.includes('Mac')) {
    return 'macos'
  }
  if (navigator.userAgent.includes('Windows')) {
    return 'windows'
  }
  if (navigator.userAgent.includes('Linux')) {
    return 'linux'
  }
  return 'unsupported'
}

function supportsTauriNativeBrowserInput(): boolean {
  const platform = resolveTauriNativeBrowserInputPlatform()
  return platform === 'macos' || platform === 'windows' || platform === 'linux'
}

function nativeSelectUnavailableMessage(platform: TauriNativeBrowserInputPlatform): string {
  return platform === 'linux'
    ? 'Native browser select input is unavailable on Linux.'
    : 'Native browser select input is unavailable on this platform.'
}

export async function openTauriBrowserPageDevTools(browserTabId: string): Promise<boolean> {
  const state = readTauriBrowserWebviewState(browserTabId)
  if (!state || state.destroyed || !state.nativeWebview) {
    return false
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('plugin:webview|internal_toggle_devtools', {
      label: state.nativeWebview.label
    })
    return true
  } catch {
    return false
  }
}

export async function resolveTauriBrowserPageDialog(
  browserTabId: string,
  accept: boolean,
  text?: string
): Promise<{ handled: boolean }> {
  const state = readTauriBrowserWebviewState(browserTabId)
  if (!state || state.destroyed || !state.nativeWebview) {
    throw new Error('Browser page WebView is not ready.')
  }
  const handled = await invoke<boolean>('browser_child_webview_resolve_dialog', {
    label: state.nativeWebview.label,
    accept,
    text: text ?? null
  })
  return { handled }
}

export async function captureTauriBrowserSelectionScreenshot(
  args: BrowserCaptureSelectionScreenshotArgs
): Promise<BrowserCaptureSelectionScreenshotResult> {
  const state = readTauriBrowserWebviewState(args.browserPageId)
  if (!state || state.destroyed || !state.nativeWebview) {
    return { ok: false, reason: 'Guest not ready' }
  }
  try {
    await evaluateTauriBrowserGuest(state, HIDE_GRAB_SCREENSHOT_OVERLAYS, 2_000).catch(
      () => undefined
    )
    let result: { data: string; format: 'png' | 'jpeg' }
    try {
      result = await invoke('browser_child_webview_screenshot', {
        input: {
          label: state.nativeWebview.label,
          format: 'png',
          crop: args.rect,
          deviceScaleFactor: window.devicePixelRatio
        }
      })
    } finally {
      await evaluateTauriBrowserGuest(state, RESTORE_GRAB_SCREENSHOT_OVERLAYS, 2_000).catch(
        () => undefined
      )
    }
    const estimatedBytes = Math.floor((result.data.length * 3) / 4)
    if (!result.data || estimatedBytes > GRAB_BUDGET.screenshotMaxBytes) {
      return {
        ok: false,
        reason: 'Screenshot capture exceeded the attachment budget'
      }
    }
    return {
      ok: true,
      screenshot: {
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${result.data}`,
        width: Math.max(1, Math.round(args.rect.width)),
        height: Math.max(1, Math.round(args.rect.height))
      }
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Screenshot capture failed'
    }
  }
}

export async function captureTauriBrowserPageScreenshot(
  browserPageId: string
): Promise<{ data: string; format: 'png' | 'jpeg' }> {
  const state = readTauriBrowserWebviewState(browserPageId)
  if (!state || state.destroyed || !state.nativeWebview) {
    throw new Error('Browser page WebView is not ready.')
  }
  return captureTauriBrowserWebviewScreenshot(state, 'png')
}

export async function clearTauriBrowserDefaultCookies(): Promise<boolean> {
  for (const webview of webviewRegistry.values()) {
    const state = (webview as TauriBrowserWebview).__pebbleTauriBrowserWebviewState
    if (!state || state.destroyed || !state.nativeWebview) {
      continue
    }
    if (state.webviewPartition !== PEBBLE_BROWSER_PARTITION) {
      continue
    }
    // Why: default-partition child WebViews share one cookie store. Clearing
    // through a single live view avoids concurrent delete races across tabs.
    await invoke<number>('browser_guest_clear_cookies', {
      input: { label: state.nativeWebview.label }
    })
    return true
  }
  return false
}

export async function getTauriBrowserCookies(
  browserPageId: string,
  url?: string
): Promise<BrowserCookieGetResult> {
  const state = requireLiveBrowserWebview(browserPageId)
  const cookies = await invoke<BrowserCookieGetResult['cookies']>('browser_guest_cookie_get', {
    input: { label: state.nativeWebview!.label, url: url ?? null }
  })
  return { cookies }
}

export async function setTauriBrowserCookie(
  browserPageId: string,
  cookie: {
    name: string
    value: string
    domain?: string
    path?: string
    secure?: boolean
    httpOnly?: boolean
    sameSite?: string
    expires?: number
    url?: string
  }
): Promise<BrowserCookieSetResult> {
  const state = requireLiveBrowserWebview(browserPageId)
  const target = new URL(cookie.url ?? state.currentUrl)
  const domain = cookie.domain ?? target.hostname
  const path = cookie.path ?? (cookie.url ? target.pathname || '/' : undefined)
  const secure = cookie.secure ?? (cookie.url ? target.protocol === 'https:' : undefined)
  const { url: _url, ...nativeCookie } = cookie
  const success = await invoke<boolean>('browser_guest_cookie_set', {
    input: {
      label: state.nativeWebview!.label,
      ...nativeCookie,
      domain,
      path,
      secure
    }
  })
  return { success }
}

export async function clearTauriBrowserPageCookies(
  browserPageId: string
): Promise<{ cleared: boolean }> {
  const state = requireLiveBrowserWebview(browserPageId)
  await invoke<number>('browser_guest_clear_cookies', {
    input: { label: state.nativeWebview!.label }
  })
  return { cleared: true }
}

export async function deleteTauriBrowserCookie(
  browserPageId: string,
  args: { name: string; domain?: string; url?: string }
): Promise<BrowserCookieDeleteResult> {
  const state = requireLiveBrowserWebview(browserPageId)
  const deleted = await invoke<boolean>('browser_guest_cookie_delete', {
    input: {
      label: state.nativeWebview!.label,
      ...args,
      ...(args.domain || args.url ? {} : { url: state.currentUrl })
    }
  })
  return { deleted }
}

function requireLiveBrowserWebview(browserPageId: string): TauriBrowserWebviewState {
  const state = readTauriBrowserWebviewState(browserPageId)
  if (!state || state.destroyed || !state.nativeWebview) {
    throw new Error(`Browser tab is not ready: ${browserPageId}`)
  }
  return state
}

export async function importTauriBrowserCookiesFromFile(args: {
  profileId: string
}): Promise<BrowserCookieImportResult> {
  const state = findLiveProfileWebview(args.profileId)
  if (state) {
    return invoke<BrowserCookieImportResult>('browser_guest_import_cookie_file', {
      input: { label: state.nativeWebview!.label, profileId: args.profileId }
    })
  }
  return {
    ok: false,
    reason: 'Open a browser tab with this profile before importing cookies.'
  }
}

export async function importTauriBrowserCookiesFromBrowser(args: {
  profileId: string
  browserFamily: string
  browserProfile?: string
}): Promise<BrowserCookieImportResult> {
  const state = findLiveProfileWebview(args.profileId)
  if (!state) {
    return {
      ok: false,
      reason: 'Open a browser tab with this profile before importing cookies.'
    }
  }
  return invoke<BrowserCookieImportResult>('browser_guest_import_from_browser', {
    input: {
      label: state.nativeWebview!.label,
      profileId: args.profileId,
      browserFamily: args.browserFamily,
      browserProfile: args.browserProfile ?? null
    }
  })
}

function findLiveProfileWebview(profileId: string): TauriBrowserWebviewState | null {
  const partition =
    profileId === 'default'
      ? PEBBLE_BROWSER_PARTITION
      : `persist:pebble-browser-session-${profileId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  for (const webview of webviewRegistry.values()) {
    const state = (webview as TauriBrowserWebview).__pebbleTauriBrowserWebviewState
    if (state && !state.destroyed && state.nativeWebview && state.webviewPartition === partition) {
      return state
    }
  }
  return null
}

export async function setTauriBrowserAnnotationViewportBridge(
  args: BrowserSetAnnotationViewportBridgeArgs
): Promise<boolean> {
  const state = readTauriBrowserWebviewState(args.browserPageId)
  if (!state || state.destroyed || !state.nativeWebview) {
    return false
  }
  // Why: the Tauri bridge owns only visual marker geometry. It does not accept
  // page scripts from the renderer or expand the missing grab/CDP boundary.
  return invoke<boolean>('browser_annotation_overlay_set', {
    input: {
      label: state.nativeWebview.label,
      enabled: args.enabled,
      markers: args.markers
    }
  }).catch(() => false)
}

export async function setTauriBrowserGrabMode(
  args: BrowserSetGrabModeArgs
): Promise<BrowserSetGrabModeResult> {
  const state = readTauriBrowserWebviewState(args.browserPageId)
  if (!state || state.destroyed || !state.nativeWebview) {
    return { ok: false, reason: 'not-ready' }
  }
  try {
    await evaluateTauriBrowserGuest(
      state,
      buildGuestOverlayScript(args.enabled ? 'arm' : 'teardown'),
      5_000
    )
    return { ok: true }
  } catch {
    return { ok: false, reason: 'not-ready' }
  }
}

export async function awaitTauriBrowserGrabSelection(
  args: BrowserAwaitGrabSelectionArgs
): Promise<BrowserGrabResult> {
  const state = readTauriBrowserWebviewState(args.browserPageId)
  if (!state || state.destroyed || !state.nativeWebview) {
    return { opId: args.opId, kind: 'error', reason: 'Guest not ready' }
  }
  try {
    const response = await evaluateTauriBrowserGuest(
      state,
      buildGuestOverlayScript('awaitClick'),
      120_000
    )
    const raw = JSON.parse(response) as unknown
    if (isTauriGrabCancellation(raw)) {
      return { opId: args.opId, kind: 'cancelled', reason: 'user' }
    }
    const isContextSelection = isRecord(raw) && raw.__pebbleContextMenu === true && 'payload' in raw
    const payload = clampGrabPayload(isContextSelection && isRecord(raw) ? raw.payload : raw)
    if (!payload) {
      return {
        opId: args.opId,
        kind: 'error',
        reason: 'Guest returned invalid payload structure'
      }
    }
    return {
      opId: args.opId,
      kind: isContextSelection ? 'context-selected' : 'selected',
      payload
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('timed out')) {
      return { opId: args.opId, kind: 'cancelled', reason: 'timeout' }
    }
    if (message.includes('cancelled')) {
      return { opId: args.opId, kind: 'cancelled', reason: 'user' }
    }
    return { opId: args.opId, kind: 'error', reason: message }
  }
}

export async function cancelTauriBrowserGrab(args: BrowserCancelGrabArgs): Promise<boolean> {
  const state = readTauriBrowserWebviewState(args.browserPageId)
  if (!state || state.destroyed || !state.nativeWebview) {
    return false
  }
  await evaluateTauriBrowserGuest(state, buildGuestOverlayScript('teardown'), 5_000).catch(
    () => undefined
  )
  return true
}

export async function extractTauriBrowserHoverPayload(
  args: BrowserExtractHoverArgs
): Promise<BrowserExtractHoverResult> {
  const state = readTauriBrowserWebviewState(args.browserPageId)
  if (!state || state.destroyed || !state.nativeWebview) {
    return { ok: false, reason: 'Guest not ready' }
  }
  try {
    const response = await evaluateTauriBrowserGuest(
      state,
      buildGuestOverlayScript('extractHover'),
      5_000
    )
    const payload = clampGrabPayload(JSON.parse(response) as unknown)
    return payload ? { ok: true, payload } : { ok: false, reason: 'No element hovered' }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function evaluateTauriBrowserPageExpression(
  browserPageId: string,
  expression: string
): Promise<{ result: string; origin: string }> {
  const state = readTauriBrowserWebviewState(browserPageId)
  if (!state || state.destroyed || !state.nativeWebview) {
    throw new Error('Guest not ready')
  }
  const encodedExpression = JSON.stringify(expression)
  const script = `(async () => {
    try {
      const value = await (0, eval)(${encodedExpression});
      return { ok: true, result: value === undefined ? '' : String(value), origin: location.origin };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })()`
  const response = await evaluateTauriBrowserGuest(state, script, 15_000)
  const parsed = JSON.parse(response) as unknown
  if (!isRecord(parsed) || parsed.ok !== true) {
    throw new Error(
      isRecord(parsed) && typeof parsed.error === 'string'
        ? parsed.error
        : 'Browser evaluation returned an invalid response.'
    )
  }
  return {
    result: typeof parsed.result === 'string' ? parsed.result : '',
    origin: typeof parsed.origin === 'string' ? parsed.origin : ''
  }
}

export async function setTauriBrowserPageDeviceEmulation(
  browserPageId: string,
  profile: TauriBrowserDeviceEmulation
): Promise<{ applied: true; scope: 'native-request-and-document-device' }> {
  const state = readTauriBrowserWebviewState(browserPageId)
  if (!state || state.destroyed || !state.nativeWebview) {
    throw new Error('Guest not ready')
  }
  const nextUserAgent = profile.mobile ? browserDeviceIdentity(profile).userAgent : null
  const requestUserAgentChanged = state.nativeUserAgent !== nextUserAgent
  state.deviceEmulation = profile
  state.nativeUserAgent = nextUserAgent
  await (requestUserAgentChanged && state.currentUrl !== PEBBLE_BROWSER_BLANK_URL
    ? navigateTauriBrowserWebview(state.element, state, state.currentUrl, {
        pushHistory: false
      })
    : applyTauriBrowserDeviceEmulation(state))
  return { applied: true, scope: 'native-request-and-document-device' }
}

export async function setTauriBrowserPageHeaders(
  browserPageId: string,
  headersJson: string
): Promise<{ applied: number; scope: 'fetch-xhr' }> {
  const state = readTauriBrowserWebviewState(browserPageId)
  if (!state || state.destroyed || !state.nativeWebview) {
    throw new Error('Guest not ready')
  }
  const headers = parseTauriBrowserExtraHeaders(headersJson)
  const script = `(() => {
    const capture = globalThis.__pebbleAutomationCapture;
    if (!capture) return { ok: false, error: 'Browser request hooks are unavailable. Reload and retry.' };
    capture.extraHeaders = ${JSON.stringify(headers)};
    return { ok: true, applied: Object.keys(capture.extraHeaders).length, scope: 'fetch-xhr' };
  })()`
  const response = await evaluateTauriBrowserGuest(state, script, 5_000)
  const parsed = JSON.parse(response) as unknown
  if (!isRecord(parsed) || parsed.ok !== true) {
    throw new Error(
      isRecord(parsed) && typeof parsed.error === 'string'
        ? parsed.error
        : 'Browser header update returned an invalid response.'
    )
  }
  return {
    applied: typeof parsed.applied === 'number' ? parsed.applied : 0,
    scope: 'fetch-xhr'
  }
}

export async function setTauriBrowserPageOffline(
  browserPageId: string,
  requestedState?: string
): Promise<{ offline: boolean; scope: 'fetch-xhr' }> {
  const state = readTauriBrowserWebviewState(browserPageId)
  if (!state || state.destroyed || !state.nativeWebview) {
    throw new Error('Guest not ready')
  }
  const normalized = requestedState?.trim().toLowerCase()
  if (normalized && !['on', 'off', 'true', 'false'].includes(normalized)) {
    throw new Error('Browser offline state must be on or off.')
  }
  const nextState =
    normalized === 'on' || normalized === 'true'
      ? 'true'
      : normalized === 'off' || normalized === 'false'
        ? 'false'
        : '!capture.offline'
  const script = `(() => {
    const capture = globalThis.__pebbleAutomationCapture;
    if (!capture) return { ok: false, error: 'Browser request hooks are unavailable. Reload and retry.' };
    capture.offline = ${nextState};
    return { ok: true, offline: capture.offline, scope: 'fetch-xhr' };
  })()`
  const response = await evaluateTauriBrowserGuest(state, script, 5_000)
  const parsed = JSON.parse(response) as unknown
  if (!isRecord(parsed) || parsed.ok !== true || typeof parsed.offline !== 'boolean') {
    throw new Error(
      isRecord(parsed) && typeof parsed.error === 'string'
        ? parsed.error
        : 'Browser offline update returned an invalid response.'
    )
  }
  return { offline: parsed.offline, scope: 'fetch-xhr' }
}

export async function setTauriBrowserPageCredentials(
  browserPageId: string,
  user: string,
  password: string
): Promise<{ configured: true; scope: 'native-http-basic' }> {
  const state = readTauriBrowserWebviewState(browserPageId)
  if (!state || state.destroyed || !state.nativeWebview) {
    throw new Error('Guest not ready')
  }
  if (
    !user ||
    user.length > 1024 ||
    password.length > 8 * 1024 ||
    /[\r\n]/.test(user) ||
    /[\r\n]/.test(password)
  ) {
    throw new Error('Browser credentials are invalid.')
  }
  const authorization = `Basic ${encodeUtf8Base64(`${user}:${password}`)}`
  await invoke('browser_child_webview_set_http_auth', {
    input: { label: state.nativeWebview.label, user, password }
  })
  const script = `(() => {
    const capture = globalThis.__pebbleAutomationCapture;
    if (!capture) return { ok: false, error: 'Browser request hooks are unavailable. Reload and retry.' };
    capture.authorization = ${JSON.stringify(authorization)};
    return { ok: true, configured: true, scope: 'fetch-xhr-basic' };
  })()`
  const response = await evaluateTauriBrowserGuest(state, script, 5_000)
  const parsed = JSON.parse(response) as unknown
  if (!isRecord(parsed) || parsed.ok !== true || parsed.configured !== true) {
    throw new Error(
      isRecord(parsed) && typeof parsed.error === 'string'
        ? parsed.error
        : 'Browser credential update returned an invalid response.'
    )
  }
  return { configured: true, scope: 'native-http-basic' }
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function parseTauriBrowserExtraHeaders(headersJson: string): Record<string, string> {
  if (headersJson.length > 64 * 1024) {
    throw new Error('Browser headers exceed the 64 KB limit.')
  }
  let value: unknown
  try {
    value = JSON.parse(headersJson)
  } catch {
    throw new Error('Browser headers must be a JSON object.')
  }
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error('Browser headers must be a JSON object.')
  }
  const entries = Object.entries(value)
  if (entries.length > 64) {
    throw new Error('Browser headers cannot contain more than 64 entries.')
  }
  const headers: Record<string, string> = {}
  for (const [name, rawValue] of entries) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || typeof rawValue !== 'string') {
      throw new Error('Browser header names and values are invalid.')
    }
    if (rawValue.length > 8 * 1024 || /[\r\n]/.test(rawValue)) {
      throw new Error('Browser header names and values are invalid.')
    }
    headers[name] = rawValue
  }
  return headers
}

function isTauriGrabCancellation(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.__pebbleCancelled === true ||
      (value.message === 'cancelled' && !('page' in value) && !('target' in value)))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function evaluateTauriBrowserGuest(
  state: TauriBrowserWebviewState,
  script: string,
  timeoutMs: number
): Promise<string> {
  const label = state.nativeWebview?.label
  if (!label || state.destroyed) {
    return Promise.reject(new Error('Guest not ready'))
  }
  return invoke<string>('browser_guest_evaluate', {
    input: { label, script, timeoutMs }
  })
}

async function applyTauriBrowserDeviceEmulation(state: TauriBrowserWebviewState): Promise<void> {
  const profile = state.deviceEmulation
  if (!profile) {
    return
  }
  const identity = browserDeviceIdentity(profile)
  const script = `(() => {
    const key = '__pebbleDeviceEmulationOriginals';
    const originals = globalThis[key] || (globalThis[key] = {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
      screenWidth: screen.width,
      screenHeight: screen.height,
      devicePixelRatio: globalThis.devicePixelRatio,
      matchMedia: globalThis.matchMedia.bind(globalThis)
    });
    const profile = ${JSON.stringify({ ...profile, ...identity })};
    const define = (target, name, value) => {
      try { Object.defineProperty(target, name, { configurable: true, get: () => value }); } catch {}
    };
    define(navigator, 'userAgent', profile.mobile ? profile.userAgent : originals.userAgent);
    define(navigator, 'platform', profile.mobile ? profile.platform : originals.platform);
    define(navigator, 'maxTouchPoints', profile.mobile ? profile.maxTouchPoints : originals.maxTouchPoints);
    define(screen, 'width', profile.width);
    define(screen, 'height', profile.height);
    define(globalThis, 'devicePixelRatio', profile.deviceScaleFactor);
    globalThis.matchMedia = (query) => {
      const normalized = String(query).replace(/\\s+/g, '').toLowerCase();
      const mobileMatch = profile.mobile && (
        normalized.includes('(pointer:coarse)') || normalized.includes('(any-pointer:coarse)') ||
        normalized.includes('(hover:none)') || normalized.includes('(any-hover:none)')
      );
      if (!mobileMatch) return originals.matchMedia(query);
      return { matches: true, media: String(query), onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } };
    };
    globalThis.dispatchEvent(new Event('resize'));
    return { ok: true };
  })()`
  const response = await evaluateTauriBrowserGuest(state, script, 5_000)
  const parsed = JSON.parse(response) as unknown
  if (!isRecord(parsed) || parsed.ok !== true) {
    throw new Error('Browser device emulation returned an invalid response.')
  }
}

function browserDeviceIdentity(profile: TauriBrowserDeviceEmulation): {
  userAgent: string
  platform: string
  maxTouchPoints: number
} {
  const name = profile.name.toLowerCase()
  if (name.includes('pixel')) {
    return {
      userAgent:
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      platform: 'Linux armv8l',
      maxTouchPoints: 5
    }
  }
  if (name.includes('ipad') || name === 'tablet') {
    return {
      userAgent:
        'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      platform: 'iPad',
      maxTouchPoints: 5
    }
  }
  return {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
    maxTouchPoints: 5
  }
}

function installTauriBrowserWebviewShape(
  element: TauriBrowserWebview,
  state: TauriBrowserWebviewState
): void {
  const nativeFocus = element.focus.bind(element)
  Object.defineProperty(element, 'src', {
    get: () => state.currentUrl,
    set: (value: string) => {
      void navigateTauriBrowserWebview(element, state, normalizeTauriBrowserUrl(value), {
        pushHistory: true
      })
    }
  })
  Object.assign(element, {
    getWebContentsId: () => stableNegativeId(state.browserTabId),
    getURL: () => state.currentUrl,
    getTitle: () => state.title,
    canGoBack: () => state.historyIndex > 0,
    canGoForward: () => state.historyIndex >= 0 && state.historyIndex < state.history.length - 1,
    isLoading: () => state.loading,
    isDestroyed: () => state.destroyed,
    getZoomLevel: () => state.zoomLevel,
    setZoomLevel: (level: number) => {
      state.zoomLevel = level
      void state.nativeWebview?.setZoom(Math.pow(1.2, level))
    },
    goBack: () => {
      if (state.historyIndex <= 0) {
        return
      }
      state.historyIndex -= 1
      void navigateTauriBrowserWebview(element, state, state.history[state.historyIndex], {
        pushHistory: false
      })
    },
    goForward: () => {
      if (state.historyIndex < 0 || state.historyIndex >= state.history.length - 1) {
        return
      }
      state.historyIndex += 1
      void navigateTauriBrowserWebview(element, state, state.history[state.historyIndex], {
        pushHistory: false
      })
    },
    reload: () => {
      void navigateTauriBrowserWebview(element, state, state.currentUrl, {
        pushHistory: false
      })
    },
    reloadIgnoringCache: () => {
      void navigateTauriBrowserWebview(element, state, state.currentUrl, {
        pushHistory: false
      })
    },
    findInPage: (text: string, options?: BrowserFindInPageOptions) => {
      // Why: callers receive Electron's synchronous request token even though
      // the Tauri host evaluates the native WebView asynchronously.
      const requestId = ++state.findRequestId
      void findInTauriBrowserWebview(element, state, text, options, requestId)
      return requestId
    },
    stopFindInPage: () => {
      void stopFindingInTauriBrowserWebview(element, state)
    },
    stop: () => {
      state.loading = false
      dispatchTauriBrowserWebviewEvent(element, 'did-stop-loading')
    },
    focus: () => {
      nativeFocus()
      void focusTauriNativeWebview(state)
    }
  })
  element.__pebbleDestroyNativeWebview = () => destroyTauriBrowserWebview(state)
  element.__pebbleSetNativeBrowserInputLocked = (locked) => {
    state.inputLocked = locked
    syncTauriBrowserWebviewLayout(state)
  }
}

async function navigateTauriBrowserWebview(
  element: TauriBrowserWebview,
  state: TauriBrowserWebviewState,
  url: string,
  options: { pushHistory: boolean }
): Promise<void> {
  if (state.destroyed) {
    return
  }
  if (options.pushHistory) {
    pushTauriBrowserHistory(state, url)
  }
  element.setAttribute('src', url)
  state.currentUrl = url
  state.title = titleForTauriBrowserUrl(url)
  state.loading = url !== PEBBLE_BROWSER_BLANK_URL
  dispatchTauriBrowserWebviewEvent(element, 'did-start-loading')

  const generation = ++state.generation
  if (state.performanceProfile && state.nativeWebview) {
    await collectTauriBrowserPerformanceSegment(state).catch(() => undefined)
  }
  await closeTauriBrowserNativeWebview(state.nativeWebview)
  state.nativeWebview = null

  const bounds = readTauriBrowserWebviewBounds(state)
  let unlistenPageLoad: UnlistenFn | null = null
  try {
    const grabShortcuts = await readTauriBrowserGrabShortcuts()
    const permissionProfileId = await ensureTauriBrowserPermissionProfile(state.webviewPartition)
    const { Webview } = await import('@tauri-apps/api/webview')
    if (state.destroyed || generation !== state.generation) {
      return
    }
    const label = `${tauriWebviewLabel(state)}-${generation}`
    let resolvePageLoad: (() => void) | null = null
    const pageLoadFinished = new Promise<void>((resolve) => {
      resolvePageLoad = resolve
    })
    unlistenPageLoad = await listen<TauriBrowserPageLoadEvent>(
      TAURI_BROWSER_PAGE_LOAD_EVENT,
      ({ payload }) => {
        if (
          payload.event === 'finished' &&
          payload.browserTabId === state.browserTabId &&
          payload.label === label &&
          generation === state.generation
        ) {
          resolvePageLoad?.()
        }
      }
    )
    await invoke('browser_child_webview_create', {
      input: {
        label,
        url,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        profileKey: tauriBrowserProfileKey(state.webviewPartition),
        userAgent: state.nativeUserAgent,
        browserTabId: state.browserTabId,
        permissionProfileId: permissionProfileId || null,
        grabShortcuts,
        initScripts: [...state.initScripts.values()]
      }
    })
    const nativeWebview = await Webview.getByLabel(label)
    if (!nativeWebview) {
      throw new Error('Tauri browser child WebView was created without a live handle.')
    }
    if (state.destroyed || generation !== state.generation) {
      await nativeWebview.close().catch(() => undefined)
      return
    }
    state.nativeWebview = nativeWebview
    await nativeWebview.setZoom(Math.pow(1.2, state.zoomLevel)).catch(() => undefined)
    await waitForTauriBrowserPageLoad(pageLoadFinished)
    unlistenPageLoad()
    unlistenPageLoad = null
    if (state.destroyed || generation !== state.generation) {
      return
    }
    state.loading = false
    syncTauriBrowserWebviewLayout(state)
    // Why: navigation replaces the document and its JS globals. Reapply the
    // selected device before dom-ready observers inspect navigator/media state.
    await applyTauriBrowserDeviceEmulation(state).catch(() => undefined)
    if (state.performanceProfile) {
      await executeTauriBrowserDomAction(state, 'profilerStart', {}).catch(() => undefined)
    }
    await window.__pebbleTauriBrowserScreencasts
      ?.rebind(state.browserTabId, nativeWebview.label)
      .catch(() => undefined)
    await window.__pebbleTauriBrowserVideoRecordings
      ?.rebind(state.browserTabId, nativeWebview.label)
      .catch(() => undefined)
    dispatchTauriBrowserWebviewEvent(element, 'dom-ready')
    dispatchTauriBrowserWebviewEvent(element, 'did-navigate', {
      url,
      isMainFrame: true
    })
    dispatchTauriBrowserWebviewEvent(element, 'page-title-updated', {
      title: state.title
    })
    dispatchTauriBrowserWebviewEvent(element, 'did-stop-loading')
  } catch (error) {
    unlistenPageLoad?.()
    state.loading = false
    const description = error instanceof Error ? error.message : String(error)
    dispatchTauriBrowserWebviewEvent(element, 'did-fail-load', {
      errorCode: -1,
      errorDescription: description,
      validatedURL: url,
      isMainFrame: true
    })
    window.__pebbleReportTauriBrowserLoadFailure?.({
      browserPageId: state.browserTabId,
      loadError: { code: -1, description, validatedUrl: url }
    })
  }
}

async function waitForTauriBrowserPageLoad(pageLoadFinished: Promise<void>): Promise<void> {
  let timeoutId: number | null = null
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(
      () => reject(new Error('Tauri browser page load timed out.')),
      TAURI_BROWSER_PAGE_LOAD_TIMEOUT_MS
    )
  })
  try {
    await Promise.race([pageLoadFinished, timeout])
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId)
    }
  }
}

async function readTauriBrowserGrabShortcuts(): Promise<string[]> {
  try {
    const snapshot = await window.api.keybindings.get()
    return getEffectiveKeybindingsForAction(
      'browser.grabElement',
      snapshot.platform,
      snapshot.overrides
    )
  } catch {
    return getEffectiveKeybindingsForAction(
      'browser.grabElement',
      navigator.userAgent.includes('Mac')
        ? 'darwin'
        : navigator.userAgent.includes('Windows')
          ? 'win32'
          : 'linux'
    )
  }
}

function readTauriBrowserWebviewState(browserTabId: string): TauriBrowserWebviewState | null {
  const webview = webviewRegistry.get(browserTabId) as TauriBrowserWebview | undefined
  return webview?.__pebbleTauriBrowserWebviewState ?? null
}

function installTauriBrowserActionExecutor(
  element: TauriBrowserWebview,
  state: TauriBrowserWebviewState
): void {
  state.unregisterActionExecutor =
    window.__pebbleTauriBrowserActionExecutors?.register(state.browserTabId, async (action) =>
      executeTauriBrowserAction(element, state, action)
    ) ?? null
}

async function executeTauriBrowserAction(
  element: TauriBrowserWebview,
  state: TauriBrowserWebviewState,
  action: RuntimeComputerAction
): Promise<Record<string, unknown>> {
  const command = readTauriBrowserActionCommand(action)
  if (!command) {
    throw new Error(`Unsupported browser action: ${action.kind}`)
  }
  switch (command) {
    case 'goto': {
      const url = readActionString(action.payload?.url) ?? PEBBLE_BROWSER_BLANK_URL
      await navigateTauriBrowserWebview(element, state, normalizeTauriBrowserUrl(url), {
        pushHistory: true
      })
      return readTauriBrowserActionResult(state)
    }
    case 'reload':
      await navigateTauriBrowserWebview(element, state, state.currentUrl, {
        pushHistory: false
      })
      return readTauriBrowserActionResult(state)
    case 'goBack':
      element.goBack()
      return readTauriBrowserActionResult(state)
    case 'goForward':
      element.goForward()
      return readTauriBrowserActionResult(state)
    case 'stop':
      element.stop()
      return readTauriBrowserActionResult(state)
    case 'screenshot':
      return captureTauriBrowserWebviewScreenshot(state, action.payload?.format)
    case 'screencastStart':
      return startTauriBrowserScreencastAction(state, action.payload)
    case 'screencastStop':
      return stopTauriBrowserScreencastAction(action.payload)
    case 'recordingStart':
      return startTauriBrowserVideoRecordingAction(state, action.payload)
    case 'recordingStop':
      return stopTauriBrowserVideoRecordingAction(state)
    case 'mouseMove':
    case 'mouseDown':
    case 'mouseUp':
    case 'mouseClick':
      if (supportsTauriNativeBrowserInput()) {
        return executeTauriBrowserNativeMouseAction(state, command, action.payload ?? {})
      }
      return executeTauriBrowserDomAction(state, command, action.payload ?? {})
    case 'mouseWheel':
      if (supportsTauriNativeBrowserInput()) {
        return executeTauriBrowserNativeWheelAction(state, action.payload ?? {})
      }
      return executeTauriBrowserDomAction(state, command, action.payload ?? {})
    case 'fullScreenshot':
      return captureTauriBrowserFullPageScreenshot(state, action.payload?.format)
    case 'pdf':
      return captureTauriBrowserPdf(state)
    case 'initScriptAdd':
      return addTauriBrowserInitScript(state, action.payload)
    case 'initScriptRemove':
      return removeTauriBrowserInitScript(state, action.payload)
    case 'profilerStart':
      return startTauriBrowserPerformanceProfile(state)
    case 'profilerStop':
      return stopTauriBrowserPerformanceProfile(state)
    case 'snapshot':
    case 'resolvePoint':
    case 'resolveSelectOption':
    case 'readSelectValues':
      return executeTauriBrowserDomAction(state, command, action.payload ?? {})
    case 'click':
    case 'dblclick':
      if (supportsTauriNativeBrowserInput()) {
        return executeTauriBrowserNativeElementClick(state, command, action.payload ?? {})
      }
      return executeTauriBrowserDomAction(state, command, action.payload ?? {})
    case 'hover':
      if (supportsTauriNativeBrowserInput()) {
        return executeTauriBrowserNativeElementHover(state, action.payload ?? {})
      }
      return executeTauriBrowserDomAction(state, command, action.payload ?? {})
    case 'fill':
    case 'type':
      if (supportsTauriNativeBrowserInput()) {
        return executeTauriBrowserNativeTextAction(state, command, action.payload ?? {})
      }
      return executeTauriBrowserDomAction(state, command, action.payload ?? {})
    case 'focus':
    case 'clear':
      return executeTauriBrowserDomAction(state, command, action.payload ?? {})
    case 'keypress':
    case 'keyDown':
    case 'keyUp':
      if (supportsTauriNativeBrowserInput()) {
        return executeTauriBrowserNativeKeyAction(state, command, action.payload ?? {})
      }
      return executeTauriBrowserDomAction(state, command, action.payload ?? {})
    case 'scroll':
    case 'scrollIntoView':
      return executeTauriBrowserDomAction(state, command, action.payload ?? {})
    case 'select':
      if (!supportsTauriNativeBrowserInput()) {
        throw new Error(nativeSelectUnavailableMessage(resolveTauriNativeBrowserInputPlatform()))
      }
      return executeTauriBrowserNativeSelectAction(state, action.payload ?? {})
    case 'check':
      if (supportsTauriNativeBrowserInput()) {
        return executeTauriBrowserNativeCheckAction(state, action.payload ?? {})
      }
      return executeTauriBrowserDomAction(state, command, action.payload ?? {})
    case 'selectAll':
      return executeTauriBrowserDomAction(state, command, action.payload ?? {})
    case 'drag':
      if (supportsTauriNativeBrowserInput()) {
        return executeTauriBrowserNativeDragAction(state, action.payload ?? {})
      }
      return executeTauriBrowserDomAction(state, command, action.payload ?? {})
    case 'upload':
    case 'get':
    case 'is':
    case 'find':
    case 'keyboardInsertText':
    case 'wait':
    case 'captureStart':
    case 'captureStop':
    case 'harStart':
    case 'harStop':
    case 'console':
    case 'network':
    case 'interceptEnable':
    case 'interceptDisable':
    case 'interceptList':
    case 'geolocation':
    case 'setMedia':
    case 'pushState':
    case 'eval':
    case 'storageLocalGet':
    case 'storageLocalSet':
    case 'storageLocalClear':
    case 'storageSessionGet':
    case 'storageSessionSet':
    case 'storageSessionClear':
    case 'highlight':
    case 'clipboardRead':
    case 'clipboardWrite':
    case 'clipboardCopy':
    case 'clipboardPaste':
      return executeTauriBrowserDomAction(
        state,
        command,
        command === 'upload'
          ? await prepareTauriBrowserUpload(action.payload ?? {})
          : (action.payload ?? {})
      )
    case 'download':
      return executeTauriBrowserDownload(state, action.payload ?? {})
    case 'viewport': {
      const width = readActionNumber(action.payload?.width)
      const height = readActionNumber(action.payload?.height)
      if (!width || !height) {
        throw new Error('Browser viewport requires positive dimensions.')
      }
      return setTauriBrowserPageDeviceEmulation(state.browserTabId, {
        name: 'remote-viewport',
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false
      })
    }
    case 'setHeaders':
      return setTauriBrowserPageHeaders(
        state.browserTabId,
        readActionString(action.payload?.headers) ?? '{}'
      )
    case 'setOffline':
      return setTauriBrowserPageOffline(
        state.browserTabId,
        readActionString(action.payload?.state) ?? undefined
      )
    case 'setCredentials':
      return setTauriBrowserPageCredentials(
        state.browserTabId,
        readActionString(action.payload?.user) ?? '',
        readActionString(action.payload?.pass) ?? ''
      )
    case 'cookieGet':
      return getTauriBrowserCookies(
        state.browserTabId,
        readActionString(action.payload?.url) ?? undefined
      )
    case 'cookieSet':
      return setTauriBrowserCookie(state.browserTabId, {
        name: requireActionString(action.payload?.name, 'Browser cookie name'),
        value: requireActionText(action.payload?.value, 'Browser cookie value'),
        domain: readActionString(action.payload?.domain) ?? undefined,
        path: readActionString(action.payload?.path) ?? undefined,
        secure: readActionBoolean(action.payload?.secure),
        httpOnly: readActionBoolean(action.payload?.httpOnly),
        sameSite: readActionString(action.payload?.sameSite) ?? undefined,
        expires: readActionFiniteNumber(action.payload?.expires) ?? undefined,
        url: readActionString(action.payload?.url) ?? undefined
      })
    case 'cookieDelete':
      return deleteTauriBrowserCookie(state.browserTabId, {
        name: requireActionString(action.payload?.name, 'Browser cookie name'),
        domain: readActionString(action.payload?.domain) ?? undefined,
        url: readActionString(action.payload?.url) ?? undefined
      })
    case 'cookieClear':
      return clearTauriBrowserPageCookies(state.browserTabId)
    case 'dialogAccept':
      return resolveTauriBrowserPageDialog(
        state.browserTabId,
        true,
        typeof action.payload?.text === 'string' ? action.payload.text : undefined
      )
    case 'dialogDismiss':
      return resolveTauriBrowserPageDialog(state.browserTabId, false)
  }
}

async function executeTauriBrowserNativeMouseAction(
  state: TauriBrowserWebviewState,
  command: 'mouseMove' | 'mouseDown' | 'mouseUp' | 'mouseClick',
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const nativeWebview = state.nativeWebview
  if (!nativeWebview) {
    throw new Error('Tauri browser native input requires a live WebView.')
  }
  const button = readActionString(payload.button) ?? 'left'
  const modifiers = Array.isArray(payload.modifiers)
    ? payload.modifiers.filter((value): value is string => typeof value === 'string')
    : []
  const point = {
    ...(typeof payload.x === 'number' ? { x: payload.x } : {}),
    ...(typeof payload.y === 'number' ? { y: payload.y } : {})
  }
  const send = (phase: 'down' | 'up') =>
    invoke<Record<string, unknown>>('browser_child_webview_input', {
      input: {
        label: nativeWebview.label,
        action: {
          kind: 'mouseButton',
          phase,
          button,
          clickCount: readActionNumber(payload.clickCount) ?? 1,
          modifiers,
          ...point
        }
      }
    })
  if (command === 'mouseMove') {
    return invokeTauriBrowserNativeInput({
      input: {
        label: nativeWebview.label,
        action: {
          kind: 'mouseMove',
          x: payload.x,
          y: payload.y,
          modifiers
        }
      }
    })
  }
  if (command === 'mouseClick') {
    await send('down')
    return send('up')
  }
  return send(command === 'mouseDown' ? 'down' : 'up')
}

async function executeTauriBrowserNativeWheelAction(
  state: TauriBrowserWebviewState,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const nativeWebview = state.nativeWebview
  if (!nativeWebview) {
    throw new Error('Tauri browser native input requires a live WebView.')
  }
  const dx = readActionFiniteNumber(payload.dx ?? 0) ?? 0
  const dy = readActionFiniteNumber(payload.dy)
  if (dy === null) {
    throw new Error('Browser mouse wheel dy is required.')
  }
  const modifiers = Array.isArray(payload.modifiers)
    ? payload.modifiers.filter((value): value is string => typeof value === 'string')
    : []
  await invokeTauriBrowserNativeInput({
    input: {
      label: nativeWebview.label,
      action: {
        kind: 'mouseWheel',
        deltaX: dx,
        deltaY: dy,
        modifiers,
        ...(typeof payload.x === 'number' ? { x: payload.x } : {}),
        ...(typeof payload.y === 'number' ? { y: payload.y } : {})
      }
    }
  })
  return { dx, dy }
}

async function executeTauriBrowserNativeDragAction(
  state: TauriBrowserWebviewState,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const nativeWebview = state.nativeWebview
  if (!nativeWebview) {
    throw new Error('Tauri browser native input requires a live WebView.')
  }
  const from = requireActionString(payload.from ?? payload.element, 'Browser drag source')
  const to = requireActionString(payload.to, 'Browser drag destination')
  const [start, end] = await Promise.all([
    resolveTauriBrowserNativeElementPoint(state, from),
    resolveTauriBrowserNativeElementPoint(state, to)
  ])
  await invokeTauriBrowserNativeInput({
    input: {
      label: nativeWebview.label,
      action: {
        kind: 'mouseDrag',
        fromX: start.x,
        fromY: start.y,
        toX: end.x,
        toY: end.y,
        steps: 8,
        modifiers: []
      }
    }
  })
  return { dragged: from, to }
}

async function executeTauriBrowserNativeCheckAction(
  state: TauriBrowserWebviewState,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const element = requireActionString(payload.element ?? payload.selector, 'Browser element')
  await executeTauriBrowserNativeElementClick(state, 'click', { element })
  const result = await executeTauriBrowserDomAction(state, 'is', { element, what: 'checked' })
  if (typeof result.checked !== 'boolean') {
    throw new Error('Browser checkbox did not return a checked state.')
  }
  return { checked: element, value: result.checked }
}

async function executeTauriBrowserNativeSelectAction(
  state: TauriBrowserWebviewState,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const element = requireActionString(payload.element ?? payload.selector, 'Browser element')
  const values = Array.isArray(payload.values)
    ? payload.values
    : payload.value === undefined
      ? []
      : [payload.value]
  if (
    values.length < 1 ||
    values.length > 64 ||
    values.some((value) => typeof value !== 'string')
  ) {
    throw new Error('Native browser select requires 1 to 64 string values.')
  }
  const requestedValues = [...new Set(values as string[])]
  const value = requestedValues[0]
  const resolved = await executeTauriBrowserDomAction(state, 'resolveSelectOption', {
    element,
    value
  })
  if (resolved.multiple === true) {
    return executeTauriBrowserNativeMultiSelectAction(state, element, requestedValues, resolved)
  }
  if (requestedValues.length !== 1) {
    throw new Error('Browser single-select accepts exactly one value.')
  }
  const canonicalValue = requireActionString(resolved.value, 'Browser select option value')
  const optionText = requireActionString(
    resolved.text ?? canonicalValue,
    'Browser select option text'
  )
  const index = readActionFiniteNumber(resolved.index)
  if (index === null || index < 0 || !Number.isInteger(index)) {
    throw new Error('Browser select option returned an invalid index.')
  }
  if (resolveTauriNativeBrowserInputPlatform() === 'macos') {
    // Why: macOS select menus enter a blocking AppKit loop when driven with
    // Enter; WebKit's native type-ahead changes selection without opening it.
    for (const key of optionText) {
      await executeTauriBrowserNativeKeyAction(state, 'keypress', { key })
    }
    return { selected: element, values: [canonicalValue] }
  }
  await executeTauriBrowserNativeKeyAction(state, 'keypress', { key: 'Home' })
  for (let offset = 0; offset < index; offset += 1) {
    await executeTauriBrowserNativeKeyAction(state, 'keypress', { key: 'ArrowDown' })
  }
  await executeTauriBrowserNativeKeyAction(state, 'keypress', { key: 'Enter' })
  return { selected: element, values: [canonicalValue] }
}

async function executeTauriBrowserNativeMultiSelectAction(
  state: TauriBrowserWebviewState,
  element: string,
  requestedValues: string[],
  firstResolved: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const platform = resolveTauriNativeBrowserInputPlatform()
  if (platform === 'unsupported') {
    throw new Error(nativeSelectUnavailableMessage(platform))
  }
  const additiveModifier = platform === 'macos' ? 'Meta' : 'Control'
  const canonicalValues: string[] = []
  const canonicalValueSet = new Set<string>()

  for (const [index, value] of requestedValues.entries()) {
    const resolved =
      index === 0
        ? firstResolved
        : await executeTauriBrowserDomAction(state, 'resolveSelectOption', { element, value })
    if (resolved.multiple !== true) {
      throw new Error('Browser select changed type during native multi-select input.')
    }
    const canonicalValue = requireActionString(resolved.value, 'Browser select option value')
    if (canonicalValueSet.has(canonicalValue)) {
      continue
    }
    const x = readActionFiniteNumber(resolved.x)
    const y = readActionFiniteNumber(resolved.y)
    if (x === null || y === null || x < 0 || y < 0) {
      throw new Error('Browser select option returned an invalid native point.')
    }
    const modifiers = canonicalValues.length === 0 ? [] : [additiveModifier]
    await executeTauriBrowserNativeMouseAction(state, 'mouseClick', {
      x,
      y,
      button: 'left',
      modifiers
    })
    canonicalValues.push(canonicalValue)
    canonicalValueSet.add(canonicalValue)
  }

  const result = await executeTauriBrowserDomAction(state, 'readSelectValues', { element })
  const selectedValues = Array.isArray(result.values)
    ? result.values.filter((value): value is string => typeof value === 'string')
    : []
  const selected = new Set(selectedValues)
  if (
    selected.size !== canonicalValues.length ||
    canonicalValues.some((value) => !selected.has(value))
  ) {
    throw new Error('Browser native multi-select did not produce the requested selection.')
  }
  return { selected: element, values: selectedValues }
}

async function executeTauriBrowserNativeElementClick(
  state: TauriBrowserWebviewState,
  command: 'click' | 'dblclick',
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const element = requireActionString(payload.element ?? payload.selector, 'Browser element')
  const { x, y } = await resolveTauriBrowserNativeElementPoint(state, element)
  const result = await executeTauriBrowserNativeMouseAction(state, 'mouseClick', {
    x,
    y,
    button: 'left',
    clickCount: command === 'dblclick' ? 2 : 1
  })
  return { ...result, clicked: element }
}

async function executeTauriBrowserNativeElementHover(
  state: TauriBrowserWebviewState,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const element = requireActionString(payload.element ?? payload.selector, 'Browser element')
  const { x, y } = await resolveTauriBrowserNativeElementPoint(state, element)
  await executeTauriBrowserNativeMouseAction(state, 'mouseMove', { x, y })
  return { hovered: element }
}

async function executeTauriBrowserNativeTextAction(
  state: TauriBrowserWebviewState,
  command: 'fill' | 'type',
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const nativeWebview = state.nativeWebview
  if (!nativeWebview) {
    throw new Error('Tauri browser native input requires a live WebView.')
  }
  const element = requireActionString(payload.element ?? payload.selector, 'Browser element')
  const text = requireActionText(command === 'fill' ? payload.value : payload.input, 'Browser text')
  await executeTauriBrowserDomAction(state, 'resolvePoint', { element, focus: true })
  await invokeTauriBrowserNativeInput({
    input: {
      label: nativeWebview.label,
      action: { kind: 'textInput', text, replace: command === 'fill' }
    }
  })
  return command === 'fill' ? { filled: element } : { typed: element }
}

async function executeTauriBrowserNativeKeyAction(
  state: TauriBrowserWebviewState,
  command: 'keypress' | 'keyDown' | 'keyUp',
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const nativeWebview = state.nativeWebview
  if (!nativeWebview) {
    throw new Error('Tauri browser native input requires a live WebView.')
  }
  const key = requireActionString(payload.key, 'Browser key')
  const modifiers = Array.isArray(payload.modifiers)
    ? payload.modifiers.filter((value): value is string => typeof value === 'string')
    : []
  await invokeTauriBrowserNativeInput({
    input: {
      label: nativeWebview.label,
      action: {
        kind: 'key',
        phase: command === 'keypress' ? 'press' : command === 'keyDown' ? 'down' : 'up',
        key,
        modifiers
      }
    }
  })
  return command === 'keypress'
    ? { pressed: key }
    : command === 'keyDown'
      ? { keyDown: key }
      : { keyUp: key }
}

async function resolveTauriBrowserNativeElementPoint(
  state: TauriBrowserWebviewState,
  element: string
): Promise<{ x: number; y: number }> {
  const point = await executeTauriBrowserDomAction(state, 'resolvePoint', { element })
  const x = readActionFiniteNumber(point.x)
  const y = readActionFiniteNumber(point.y)
  if (x === null || y === null || x < 0 || y < 0) {
    throw new Error('Browser element returned invalid native click coordinates.')
  }
  return { x, y }
}

async function invokeTauriBrowserNativeInput(
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>('browser_child_webview_input', args)
}

async function startTauriBrowserScreencastAction(
  state: TauriBrowserWebviewState,
  payload: Record<string, unknown> | undefined
): Promise<Record<string, unknown>> {
  const nativeWebview = state.nativeWebview
  const subscriptionId = readActionString(payload?.subscriptionId)
  if (!nativeWebview || !subscriptionId || !window.__pebbleTauriBrowserScreencasts) {
    throw new Error('Tauri browser screencast requires a live native WebView.')
  }
  return window.__pebbleTauriBrowserScreencasts.start({
    browserTabId: state.browserTabId,
    label: nativeWebview.label,
    subscriptionId,
    format: payload?.format === 'png' ? 'png' : 'jpeg',
    minFrameIntervalMs:
      typeof payload?.minFrameIntervalMs === 'number' ? payload.minFrameIntervalMs : 50,
    deviceScaleFactor: window.devicePixelRatio
  })
}

async function stopTauriBrowserScreencastAction(
  payload: Record<string, unknown> | undefined
): Promise<Record<string, unknown>> {
  const subscriptionId = readActionString(payload?.subscriptionId)
  if (subscriptionId && window.__pebbleTauriBrowserScreencasts) {
    await window.__pebbleTauriBrowserScreencasts.stop(subscriptionId)
  }
  return { stopped: true }
}

async function startTauriBrowserVideoRecordingAction(
  state: TauriBrowserWebviewState,
  payload: Record<string, unknown> | undefined
): Promise<Record<string, unknown>> {
  const nativeWebview = state.nativeWebview
  const path = readActionString(payload?.path)
  const bridge = window.__pebbleTauriBrowserVideoRecordings
  if (!nativeWebview || !path || !bridge) {
    throw new Error('Tauri browser video recording requires a live native WebView and path.')
  }
  return bridge.start({
    browserTabId: state.browserTabId,
    label: nativeWebview.label,
    path,
    worktree: readActionString(payload?.outputWorktree) ?? undefined,
    format: path.toLowerCase().endsWith('.mp4') ? 'mp4' : 'webm'
  })
}

function stopTauriBrowserVideoRecordingAction(
  state: TauriBrowserWebviewState
): Promise<Record<string, unknown>> {
  const bridge = window.__pebbleTauriBrowserVideoRecordings
  if (!bridge) {
    throw new Error('Tauri browser video recording is unavailable.')
  }
  return bridge.stop(state.browserTabId)
}

async function addTauriBrowserInitScript(
  state: TauriBrowserWebviewState,
  payload: Record<string, unknown> | undefined
): Promise<Record<string, unknown>> {
  const script = typeof payload?.script === 'string' ? payload.script : ''
  if (!script.trim() || script.length > 512 * 1024) {
    throw new Error('Browser init script must contain at most 512 KiB of JavaScript.')
  }
  if (state.initScripts.size >= 32) {
    throw new Error('Browser init scripts exceed 32 entries.')
  }
  const aggregateBytes = [...state.initScripts.values()].reduce(
    (total, value) => total + new TextEncoder().encode(value).byteLength,
    new TextEncoder().encode(script).byteLength
  )
  if (aggregateBytes > 1024 * 1024) {
    throw new Error('Browser init scripts exceed the 1 MiB aggregate limit.')
  }
  const id = crypto.randomUUID()
  state.initScripts.set(id, script)
  await evaluateTauriBrowserGuest(state, script, 15_000)
  return { identifier: id }
}

function removeTauriBrowserInitScript(
  state: TauriBrowserWebviewState,
  payload: Record<string, unknown> | undefined
): Record<string, unknown> {
  const identifier = readActionString(payload?.identifier)
  if (!identifier) {
    throw new Error('Browser init script identifier is required.')
  }
  return { identifier, removed: state.initScripts.delete(identifier) }
}

async function startTauriBrowserPerformanceProfile(
  state: TauriBrowserWebviewState
): Promise<Record<string, unknown>> {
  if (state.performanceProfile) {
    throw new Error('Browser profiler is already recording.')
  }
  const startedAt = Date.now()
  state.performanceProfile = { startedAt, segments: [] }
  try {
    return await executeTauriBrowserDomAction(state, 'profilerStart', {})
  } catch (error) {
    state.performanceProfile = null
    throw error
  }
}

async function collectTauriBrowserPerformanceSegment(
  state: TauriBrowserWebviewState
): Promise<void> {
  const active = state.performanceProfile
  if (!active) {
    return
  }
  const result = await executeTauriBrowserDomAction(state, 'profilerStop', {})
  if (isRecord(result.profile)) {
    active.segments.push(result.profile)
  }
}

async function stopTauriBrowserPerformanceProfile(
  state: TauriBrowserWebviewState
): Promise<Record<string, unknown>> {
  const active = state.performanceProfile
  if (!active) {
    throw new Error('Browser profiler has not started.')
  }
  await collectTauriBrowserPerformanceSegment(state)
  state.performanceProfile = null
  const traceEvents = active.segments.flatMap((segment) =>
    Array.isArray(segment.traceEvents)
      ? segment.traceEvents.filter((event): event is Record<string, unknown> => isRecord(event))
      : []
  )
  return {
    profile: {
      traceEvents,
      metadata: {
        source: 'Performance Timeline',
        startedAt: active.startedAt,
        stoppedAt: Date.now(),
        segments: active.segments.length,
        crossNavigation: active.segments.length > 1
      }
    }
  }
}

async function executeTauriBrowserDownload(
  state: TauriBrowserWebviewState,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const nativeWebview = state.nativeWebview
  const path = readActionString(payload.path)
  if (!nativeWebview || !path) {
    throw new Error('Browser download requires a live WebView and an absolute target path.')
  }
  const requestId = await invoke<string>('browser_child_webview_prepare_download', {
    input: {
      label: nativeWebview.label,
      browserTabId: state.browserTabId,
      path
    }
  })
  await executeTauriBrowserDomAction(state, 'download', payload)
  const completion = await invoke<{ path: string; success: boolean }>(
    'browser_child_webview_wait_download',
    { input: { requestId } }
  )
  if (!completion.success) {
    throw new Error('Native WebView download failed.')
  }
  return { path: completion.path }
}

async function prepareTauriBrowserUpload(
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const paths = Array.isArray(payload.files)
    ? payload.files.filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      )
    : []
  const files = await invoke<{ name: string; mimeType: string; dataBase64: string }[]>(
    'browser_read_upload_files',
    { paths }
  )
  return { ...payload, files }
}

async function executeTauriBrowserDomAction(
  state: TauriBrowserWebviewState,
  command: TauriBrowserDomCommand,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const timeoutMs =
    command === 'wait' && typeof payload.timeout === 'number'
      ? Math.max(1, Math.min(120_000, payload.timeout + 1_000))
      : 15_000
  const response = await evaluateTauriBrowserGuest(
    state,
    buildTauriBrowserDomAutomationScript(command, payload),
    timeoutMs
  )
  const parsed = JSON.parse(response) as unknown
  if (!isRecord(parsed)) {
    throw new Error('Browser DOM automation returned an invalid response.')
  }
  return command === 'snapshot' ? { browserPageId: state.browserTabId, ...parsed } : parsed
}

async function captureTauriBrowserWebviewScreenshot(
  state: TauriBrowserWebviewState,
  requestedFormat: unknown
): Promise<{ data: string; format: 'png' | 'jpeg' }> {
  const nativeWebview = state.nativeWebview
  if (!nativeWebview) {
    throw new Error('Tauri browser screenshot requires a live native WebView.')
  }
  const format = requestedFormat === 'jpeg' ? 'jpeg' : 'png'
  return invoke<{ data: string; format: 'png' | 'jpeg' }>('browser_child_webview_screenshot', {
    input: {
      label: nativeWebview.label,
      format,
      crop: null,
      deviceScaleFactor: window.devicePixelRatio
    }
  })
}

async function captureTauriBrowserPdf(state: TauriBrowserWebviewState): Promise<{ data: string }> {
  const nativeWebview = state.nativeWebview
  if (!nativeWebview) {
    throw new Error('Tauri browser PDF capture requires a live native WebView.')
  }
  return invoke<{ data: string }>('browser_child_webview_pdf', {
    input: { label: nativeWebview.label }
  })
}

async function captureTauriBrowserFullPageScreenshot(
  state: TauriBrowserWebviewState,
  requestedFormat: unknown
): Promise<{ data: string; format: 'png' | 'jpeg' }> {
  const format = requestedFormat === 'jpeg' ? 'jpeg' : 'png'
  const metrics = JSON.parse(
    await evaluateTauriBrowserGuest(
      state,
      `(function(){
    const root=document.documentElement; const body=document.body;
    return {
      viewportWidth:Math.max(1,window.innerWidth), viewportHeight:Math.max(1,window.innerHeight),
      pageHeight:Math.max(root?.scrollHeight||0,body?.scrollHeight||0,root?.offsetHeight||0,body?.offsetHeight||0,window.innerHeight),
      scrollX:window.scrollX, scrollY:window.scrollY
    };
  })()`,
      5_000
    )
  ) as {
    viewportWidth: number
    viewportHeight: number
    pageHeight: number
    scrollX: number
    scrollY: number
  }
  if (
    !Number.isFinite(metrics.pageHeight) ||
    metrics.pageHeight <= 0 ||
    metrics.pageHeight > 100_000
  ) {
    throw new Error('Browser page height is outside the full-screenshot limit.')
  }
  const positions: number[] = []
  for (let y = 0; y < metrics.pageHeight; y += metrics.viewportHeight) {
    positions.push(Math.min(y, Math.max(0, metrics.pageHeight - metrics.viewportHeight)))
    if (positions.length > 100) {
      throw new Error('Browser page requires too many screenshot segments.')
    }
  }
  const uniquePositions = [...new Set(positions)]
  const segments: { dataBase64: string; y: number }[] = []
  try {
    await evaluateTauriBrowserGuest(
      state,
      `(function(){
      globalThis.__pebbleFullScreenshotRestore={scrollBehavior:document.documentElement.style.scrollBehavior,hidden:[]};
      document.documentElement.style.scrollBehavior='auto'; return true;
    })()`,
      5_000
    )
    for (const [index, y] of uniquePositions.entries()) {
      if (index === 1) {
        await evaluateTauriBrowserGuest(
          state,
          `(function(){
          const restore=globalThis.__pebbleFullScreenshotRestore;
          for(const node of document.querySelectorAll('*')){
            if(!(node instanceof HTMLElement)) continue;
            const position=getComputedStyle(node).position;
            if(position==='fixed'||position==='sticky'){
              restore.hidden.push([node,node.style.visibility]); node.style.visibility='hidden';
            }
          }
          return true;
        })()`,
          5_000
        )
      }
      await evaluateTauriBrowserGuest(
        state,
        `(async function(){
        window.scrollTo(${metrics.scrollX},${y});
        await new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        return {y:window.scrollY};
      })()`,
        5_000
      )
      const screenshot = await captureTauriBrowserWebviewScreenshot(state, format)
      segments.push({ dataBase64: screenshot.data, y })
    }
  } finally {
    await evaluateTauriBrowserGuest(
      state,
      `(function(){
      const restore=globalThis.__pebbleFullScreenshotRestore;
      if(restore){
        document.documentElement.style.scrollBehavior=restore.scrollBehavior;
        for(const [node,visibility] of restore.hidden) if(node instanceof HTMLElement) node.style.visibility=visibility;
        delete globalThis.__pebbleFullScreenshotRestore;
      }
      window.scrollTo(${metrics.scrollX},${metrics.scrollY}); return true;
    })()`,
      5_000
    ).catch(() => undefined)
  }
  return invoke<{ data: string; format: 'png' | 'jpeg' }>('browser_stitch_full_page_screenshot', {
    input: {
      format,
      viewportWidth: metrics.viewportWidth,
      pageHeight: metrics.pageHeight,
      segments
    }
  })
}

function readTauriBrowserActionResult(state: TauriBrowserWebviewState): Record<string, unknown> {
  return {
    url: state.currentUrl,
    title: state.title,
    canGoBack: state.historyIndex > 0,
    canGoForward: state.historyIndex >= 0 && state.historyIndex < state.history.length - 1
  }
}

function readTauriBrowserActionCommand(
  action: RuntimeComputerAction
):
  | 'goto'
  | 'reload'
  | 'goBack'
  | 'goForward'
  | 'stop'
  | 'screenshot'
  | 'screencastStart'
  | 'screencastStop'
  | 'recordingStart'
  | 'recordingStop'
  | 'fullScreenshot'
  | 'pdf'
  | 'viewport'
  | 'setHeaders'
  | 'setOffline'
  | 'setCredentials'
  | 'cookieGet'
  | 'cookieSet'
  | 'cookieDelete'
  | 'cookieClear'
  | 'dialogAccept'
  | 'dialogDismiss'
  | 'initScriptAdd'
  | 'initScriptRemove'
  | TauriBrowserDomCommand
  | null {
  const payloadCommand = readActionString(action.payload?.command)
  if (isSupportedTauriBrowserCommand(payloadCommand)) {
    return payloadCommand
  }
  const fromKind = action.kind.startsWith('browser.') ? action.kind.slice('browser.'.length) : null
  return isSupportedTauriBrowserCommand(fromKind) ? fromKind : null
}

function isSupportedTauriBrowserCommand(
  command: string | null
): command is
  | 'goto'
  | 'reload'
  | 'goBack'
  | 'goForward'
  | 'stop'
  | 'screenshot'
  | 'screencastStart'
  | 'screencastStop'
  | 'recordingStart'
  | 'recordingStop'
  | 'fullScreenshot'
  | 'pdf'
  | 'viewport'
  | 'setHeaders'
  | 'setOffline'
  | 'setCredentials'
  | 'cookieGet'
  | 'cookieSet'
  | 'cookieDelete'
  | 'cookieClear'
  | 'dialogAccept'
  | 'dialogDismiss'
  | 'initScriptAdd'
  | 'initScriptRemove'
  | TauriBrowserDomCommand {
  return (
    command === 'goto' ||
    command === 'reload' ||
    command === 'goBack' ||
    command === 'goForward' ||
    command === 'stop' ||
    command === 'screenshot' ||
    command === 'screencastStart' ||
    command === 'screencastStop' ||
    command === 'recordingStart' ||
    command === 'recordingStop' ||
    command === 'fullScreenshot' ||
    command === 'pdf' ||
    command === 'snapshot' ||
    command === 'resolvePoint' ||
    command === 'resolveSelectOption' ||
    command === 'readSelectValues' ||
    command === 'click' ||
    command === 'dblclick' ||
    command === 'fill' ||
    command === 'type' ||
    command === 'focus' ||
    command === 'clear' ||
    command === 'keypress' ||
    command === 'keyDown' ||
    command === 'keyUp' ||
    command === 'scroll' ||
    command === 'scrollIntoView' ||
    command === 'select' ||
    command === 'check' ||
    command === 'hover' ||
    command === 'selectAll' ||
    command === 'drag' ||
    command === 'upload' ||
    command === 'get' ||
    command === 'is' ||
    command === 'find' ||
    command === 'keyboardInsertText' ||
    command === 'wait' ||
    command === 'captureStart' ||
    command === 'captureStop' ||
    command === 'harStart' ||
    command === 'harStop' ||
    command === 'profilerStart' ||
    command === 'profilerStop' ||
    command === 'console' ||
    command === 'network' ||
    command === 'interceptEnable' ||
    command === 'interceptDisable' ||
    command === 'interceptList' ||
    command === 'storageLocalGet' ||
    command === 'storageLocalSet' ||
    command === 'storageLocalClear' ||
    command === 'storageSessionGet' ||
    command === 'storageSessionSet' ||
    command === 'storageSessionClear' ||
    command === 'highlight' ||
    command === 'mouseMove' ||
    command === 'mouseDown' ||
    command === 'mouseUp' ||
    command === 'mouseClick' ||
    command === 'mouseWheel' ||
    command === 'clipboardRead' ||
    command === 'clipboardWrite' ||
    command === 'clipboardCopy' ||
    command === 'clipboardPaste' ||
    command === 'download' ||
    command === 'geolocation' ||
    command === 'setMedia' ||
    command === 'pushState' ||
    command === 'eval' ||
    command === 'viewport' ||
    command === 'setHeaders' ||
    command === 'setOffline' ||
    command === 'setCredentials' ||
    command === 'cookieGet' ||
    command === 'cookieSet' ||
    command === 'cookieDelete' ||
    command === 'cookieClear' ||
    command === 'dialogAccept' ||
    command === 'dialogDismiss' ||
    command === 'initScriptAdd' ||
    command === 'initScriptRemove'
  )
}

function readActionNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

function readActionBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function readActionFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function requireActionString(value: unknown, label: string): string {
  const result = readActionString(value)
  if (!result) {
    throw new Error(`${label} is required.`)
  }
  return result
}

function requireActionText(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} is required.`)
  }
  return value
}

function readActionString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function pushTauriBrowserHistory(state: TauriBrowserWebviewState, url: string): void {
  if (state.history[state.historyIndex] === url) {
    return
  }
  state.history = state.history.slice(0, state.historyIndex + 1)
  state.history.push(url)
  state.historyIndex = state.history.length - 1
}

function startTauriBrowserWebviewLayoutSync(
  element: TauriBrowserWebview,
  state: TauriBrowserWebviewState
): void {
  const sync = (): void => syncTauriBrowserWebviewLayout(state)
  if (typeof ResizeObserver !== 'undefined') {
    state.resizeObserver = new ResizeObserver(sync)
    state.resizeObserver.observe(state.container)
    state.resizeObserver.observe(element)
  }
  if (typeof MutationObserver !== 'undefined') {
    state.mutationObserver = new MutationObserver(sync)
    state.mutationObserver.observe(element, {
      attributes: true,
      attributeFilter: ['style', 'hidden']
    })
  }
  window.addEventListener('resize', sync)
  window.addEventListener('scroll', sync, true)
  state.removeWindowListeners = () => {
    window.removeEventListener('resize', sync)
    window.removeEventListener('scroll', sync, true)
  }
  window.requestAnimationFrame(sync)
}

function syncTauriBrowserWebviewLayout(state: TauriBrowserWebviewState): void {
  const nativeWebview = state.nativeWebview
  if (!nativeWebview || state.destroyed) {
    return
  }
  const bounds = readTauriBrowserWebviewBounds(state)
  const visible =
    !state.inputLocked &&
    state.element.isConnected &&
    state.element.style.display !== 'none' &&
    !state.element.hidden &&
    state.element.getClientRects().length > 0 &&
    bounds.width > 1 &&
    bounds.height > 1
  void (visible ? nativeWebview.show?.() : nativeWebview.hide?.())
  if (!visible) {
    return
  }
  void setTauriNativeWebviewBounds(nativeWebview, bounds)
}

export function syncTauriBrowserPageWebviews(): void {
  document
    .querySelectorAll<TauriBrowserWebview>('[data-tauri-browser-page-webview]')
    .forEach((element) => {
      const state = element.__pebbleTauriBrowserWebviewState
      if (state) {
        syncTauriBrowserWebviewLayout(state)
      }
    })
}

function readTauriBrowserWebviewBounds(state: TauriBrowserWebviewState): {
  x: number
  y: number
  width: number
  height: number
} {
  if (!state.container.isConnected) {
    return { x: 0, y: 0, width: 1, height: 1 }
  }
  const rect = state.container.getBoundingClientRect()
  return {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height))
  }
}

async function focusTauriNativeWebview(state: TauriBrowserWebviewState): Promise<void> {
  await state.nativeWebview?.setFocus?.().catch(() => undefined)
}

async function findInTauriBrowserWebview(
  element: TauriBrowserWebview,
  state: TauriBrowserWebviewState,
  query: string,
  options: BrowserFindInPageOptions | undefined,
  requestId: number
): Promise<void> {
  const nativeWebview = state.nativeWebview
  if (state.destroyed || !nativeWebview || !query.trim()) {
    return
  }
  try {
    const result = await invoke<TauriBrowserFindResult>('browser_guest_find', {
      input: {
        label: nativeWebview.label,
        query,
        forward: options?.forward !== false,
        findNext: options?.findNext === true
      }
    })
    if (
      state.destroyed ||
      requestId !== state.findRequestId ||
      nativeWebview !== state.nativeWebview
    ) {
      return
    }
    dispatchTauriBrowserWebviewEvent(element, 'found-in-page', {
      result: {
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
        finalUpdate: result.finalUpdate
      }
    })
  } catch {
    if (!state.destroyed && requestId === state.findRequestId) {
      dispatchTauriBrowserWebviewEvent(element, 'found-in-page', {
        result: { activeMatchOrdinal: 0, matches: 0, finalUpdate: true }
      })
    }
  }
}

async function stopFindingInTauriBrowserWebview(
  element: TauriBrowserWebview,
  state: TauriBrowserWebviewState
): Promise<void> {
  const nativeWebview = state.nativeWebview
  const requestId = ++state.findRequestId
  if (!nativeWebview || state.destroyed) {
    return
  }
  await invoke('browser_guest_stop_find', {
    input: { label: nativeWebview.label }
  }).catch(() => undefined)
  if (!state.destroyed && requestId === state.findRequestId) {
    dispatchTauriBrowserWebviewEvent(element, 'found-in-page', {
      result: { activeMatchOrdinal: 0, matches: 0, finalUpdate: true }
    })
  }
}

async function setTauriNativeWebviewBounds(
  nativeWebview: NativeTauriBrowserWebview,
  bounds: { x: number; y: number; width: number; height: number }
): Promise<void> {
  const { LogicalPosition, LogicalSize } = await import('@tauri-apps/api/dpi')
  await Promise.all([
    nativeWebview.setPosition(new LogicalPosition(bounds.x, bounds.y)),
    nativeWebview.setSize(new LogicalSize(bounds.width, bounds.height))
  ]).catch(() => undefined)
}

function destroyTauriBrowserWebview(state: TauriBrowserWebviewState): void {
  if (state.destroyed) {
    return
  }
  state.destroyed = true
  state.resizeObserver?.disconnect()
  state.mutationObserver?.disconnect()
  state.removeWindowListeners?.()
  state.unregisterActionExecutor?.()
  void window.__pebbleTauriBrowserScreencasts?.stopForTab(state.browserTabId)
  void window.__pebbleTauriBrowserVideoRecordings?.stopForTab(state.browserTabId)
  void closeTauriBrowserNativeWebview(state.nativeWebview)
  state.nativeWebview = null
}

async function closeTauriBrowserNativeWebview(
  nativeWebview: NativeTauriBrowserWebview | null
): Promise<void> {
  if (!nativeWebview) {
    return
  }
  // Why: Tauri has no child-WebView destroyed event, so clear memory-only HTTP
  // credentials before closing or rebuilding the platform WebView.
  await invoke('browser_child_webview_clear_http_auth', {
    label: nativeWebview.label
  }).catch(() => false)
  await nativeWebview.close().catch(() => undefined)
}

function dispatchTauriBrowserWebviewEvent(
  element: EventTarget,
  type: string,
  detail: Record<string, unknown> = {}
): void {
  const event = new Event(type)
  Object.assign(event, detail)
  element.dispatchEvent(event)
}

function normalizeTauriBrowserUrl(url: string): string {
  const trimmed = url.trim()
  return trimmed.length > 0 ? trimmed : PEBBLE_BROWSER_BLANK_URL
}

function titleForTauriBrowserUrl(url: string): string {
  if (url === PEBBLE_BROWSER_BLANK_URL || url === 'about:blank') {
    return 'New Tab'
  }
  try {
    const parsed = new URL(url)
    return parsed.hostname || url
  } catch {
    return url
  }
}

function tauriWebviewLabel(state: TauriBrowserWebviewState): string {
  return `browser-${state.browserTabId.replace(/[^a-zA-Z0-9_/:_-]/g, '-')}`
}

function tauriBrowserProfileKey(webviewPartition: string): string | null {
  if (webviewPartition === PEBBLE_BROWSER_PARTITION) {
    return null
  }
  const key = webviewPartition
    .replace(/^persist:/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 160)
  return key || null
}

function stableNegativeId(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return -Math.max(1, Math.abs(hash))
}
