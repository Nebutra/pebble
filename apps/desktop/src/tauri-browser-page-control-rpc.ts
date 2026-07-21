import type { BrowserViewportPresetId } from '../../../packages/product-core/shared/types'
import {
  browserViewportPresetToOverride,
  getBrowserViewportPreset
} from '../../../packages/product-core/shared/browser-viewport-presets'
import { queueTauriBrowserInteraction } from './tauri-browser-interaction-rpc'
import {
  disableTauriBrowserNavigationInterception,
  enableTauriBrowserNavigationInterception,
  listTauriBrowserNavigationInterceptions,
  resolveTauriBrowserRequest,
  tauriBrowserInterceptionScopes
} from './tauri-browser-navigation-interception'
import type { NativeBrowserInterceptRoute } from './tauri-browser-navigation-interception'
import {
  readBrowserPageId,
  readObject,
  readRequiredString,
  readString
} from './tauri-browser-rpc-values'
import { setTauriBrowserViewportOverride } from './tauri-browser-viewport-state'
import {
  deleteTauriBrowserCookie,
  evaluateTauriBrowserPageExpression,
  getTauriBrowserCookies,
  setTauriBrowserCookie,
  setTauriBrowserPageCredentials,
  setTauriBrowserPageDeviceEmulation,
  setTauriBrowserPageHeaders,
  setTauriBrowserPageOffline
} from '@/components/browser-pane/tauri-browser-page-webview'

const DEVICE_PRESET_BY_NAME: Readonly<Record<string, BrowserViewportPresetId>> = {
  'mobile-s': 'mobile-s',
  'iphone se': 'mobile-s',
  'mobile-m': 'mobile-m',
  'iphone 12': 'mobile-m',
  'iphone 13': 'mobile-m',
  'iphone 14': 'mobile-m',
  'mobile-l': 'mobile-l',
  'pixel 7': 'mobile-l',
  tablet: 'tablet',
  ipad: 'tablet',
  laptop: 'laptop',
  'laptop-l': 'laptop-l',
  desktop: 'desktop'
}

export function setBrowserHeaders(params: unknown) {
  const input = readObject(params)
  return setTauriBrowserPageHeaders(
    readBrowserPageId(input),
    readRequiredString(input.headers, 'browser headers JSON')
  )
}

export function setBrowserOffline(params: unknown) {
  const input = readObject(params)
  return setTauriBrowserPageOffline(readBrowserPageId(input), readString(input.state) ?? undefined)
}

export function setBrowserCredentials(params: unknown) {
  const input = readObject(params)
  if (typeof input.pass !== 'string') {
    throw new Error('Missing browser credential password')
  }
  return setTauriBrowserPageCredentials(
    readBrowserPageId(input),
    readRequiredString(input.user, 'browser credential user'),
    input.pass
  )
}

export async function setBrowserDevice(params: unknown) {
  const input = readObject(params)
  const pageId = readBrowserPageId(input)
  const name = readRequiredString(input.name, 'browser device name').toLowerCase()
  const presetId = DEVICE_PRESET_BY_NAME[name]
  const preset = getBrowserViewportPreset(presetId)
  if (!preset) {
    throw new Error(`Unsupported browser device: ${name}`)
  }
  const override = browserViewportPresetToOverride(preset)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('pebble:browser-viewport-preset', {
        detail: { browserPageId: pageId, presetId }
      })
    )
  }
  setTauriBrowserViewportOverride({ browserPageId: pageId, override })
  const emulation = await setTauriBrowserPageDeviceEmulation(pageId, { name, ...override })
  return { name, presetId, ...override, ...emulation }
}

export async function enableBrowserInterception(params: unknown) {
  const input = readObject(params)
  const pageId = readBrowserPageId(input)
  const routes = readBrowserInterceptRoutes(input)
  const patterns = routes.map((route) => route.pattern)
  const usesPausedRequests = routes.some((route) => route.action === 'pause')
  const native = await enableTauriBrowserNavigationInterception(pageId, routes)
  if (usesPausedRequests && !native.scope.includes('request-control')) {
    await disableTauriBrowserNavigationInterception(pageId)
    throw new Error(`Per-request interception is unavailable for native scope: ${native.scope}`)
  }
  let document: Record<string, unknown>
  try {
    document = await queueTauriBrowserInteraction('interceptEnable', {
      ...input,
      patterns,
      routes
    })
  } catch (error) {
    // Why: callers must never observe a half-enabled native/document route set.
    await disableTauriBrowserNavigationInterception(pageId).catch(() => undefined)
    throw error
  }
  return {
    enabled: native.enabled === true,
    patterns,
    routes,
    scopes: tauriBrowserInterceptionScopes(native.scope),
    document
  }
}

export async function disableBrowserInterception(params: unknown) {
  const input = readObject(params)
  const pageId = readBrowserPageId(input)
  const [nativeDisabled] = await Promise.all([
    disableTauriBrowserNavigationInterception(pageId),
    queueTauriBrowserInteraction('interceptDisable', input)
  ])
  return {
    disabled: true,
    nativeDisabled,
    scopes: ['top-level-navigation', 'document-main-frame-fetch-async-xhr']
  }
}

export async function listBrowserInterceptions(params: unknown) {
  const input = readObject(params)
  const pageId = readBrowserPageId(input)
  const [native, document] = await Promise.all([
    listTauriBrowserNavigationInterceptions(pageId),
    queueTauriBrowserInteraction('interceptList', input)
  ])
  const documentRequests = Array.isArray(document.requests) ? document.requests : []
  return {
    requests: [...native.requests, ...(native.pausedRequests ?? []), ...documentRequests],
    patterns: Array.isArray(document.patterns) ? document.patterns : native.patterns,
    routes: Array.isArray(document.routes) ? document.routes : native.routes,
    scopes: tauriBrowserInterceptionScopes(native.scope)
  }
}

export function resolveBrowserInterceptedRequest(params: unknown) {
  const input = readObject(params)
  const pageId = readBrowserPageId(input)
  const requestId = readRequiredString(input.requestId ?? input.id, 'browser request id')
  const action = readRequiredString(input.action, 'browser request action')
  if (action === 'continue') {
    return resolveTauriBrowserRequest(pageId, requestId, { action })
  }
  if (action === 'fail') {
    return resolveTauriBrowserRequest(pageId, requestId, {
      action,
      reason: readString(input.reason) ?? undefined
    })
  }
  if (action !== 'fulfill') {
    throw new Error('Browser request action must be continue, fulfill, or fail.')
  }
  const headers = readObject(input.headers)
  const responseHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      readRequiredString(value, `browser response header ${name}`)
    ])
  )
  return resolveTauriBrowserRequest(pageId, requestId, {
    action,
    body: typeof input.body === 'string' ? input.body : '',
    status: typeof input.status === 'number' ? input.status : 200,
    headers: responseHeaders
  })
}

export function getBrowserCookies(params: unknown) {
  const input = readObject(params)
  return getTauriBrowserCookies(readBrowserPageId(input), readString(input.url) ?? undefined)
}

export function setBrowserCookie(params: unknown) {
  const input = readObject(params)
  return setTauriBrowserCookie(readBrowserPageId(input), {
    name: readRequiredString(input.name, 'browser cookie name'),
    value: typeof input.value === 'string' ? input.value : '',
    domain: readString(input.domain) ?? undefined,
    path: readString(input.path) ?? undefined,
    secure: typeof input.secure === 'boolean' ? input.secure : undefined,
    httpOnly: typeof input.httpOnly === 'boolean' ? input.httpOnly : undefined,
    sameSite: readString(input.sameSite) ?? undefined,
    expires: typeof input.expires === 'number' ? input.expires : undefined,
    url: readString(input.url) ?? undefined
  })
}

export function deleteBrowserCookie(params: unknown) {
  const input = readObject(params)
  return deleteTauriBrowserCookie(readBrowserPageId(input), {
    name: readRequiredString(input.name, 'browser cookie name'),
    domain: readString(input.domain) ?? undefined,
    url: readString(input.url) ?? undefined
  })
}

export async function evaluateBrowserExpression(
  params: unknown
): Promise<{ result: string; origin: string }> {
  const input = readObject(params)
  return evaluateTauriBrowserPageExpression(
    readBrowserPageId(input),
    readRequiredString(input.expression, 'browser expression')
  )
}

function readBrowserInterceptRoutes(input: Record<string, unknown>): NativeBrowserInterceptRoute[] {
  if (!Array.isArray(input.routes)) {
    return readBrowserInterceptPatterns(input.patterns).map((pattern) => ({
      pattern,
      action: 'pause' as const
    }))
  }
  if (input.routes.length < 1 || input.routes.length > 32) {
    throw new Error('Browser interception requires 1 to 32 routes.')
  }
  return input.routes.map((value) => {
    const route = readObject(value)
    const pattern = readBrowserInterceptPatterns([route.pattern])[0]
    const action =
      route.action === 'fulfill'
        ? 'fulfill'
        : route.action === 'abort'
          ? 'abort'
          : route.action === 'pause'
            ? 'pause'
            : null
    if (!action) {
      throw new Error('Browser intercept action must be pause, abort, or fulfill.')
    }
    return {
      pattern,
      action,
      ...(action === 'fulfill'
        ? {
            body: typeof route.body === 'string' ? route.body : '',
            status: typeof route.status === 'number' ? route.status : 200,
            contentType:
              typeof route.contentType === 'string' ? route.contentType : 'application/json'
          }
        : {})
    }
  })
}

function readBrowserInterceptPatterns(value: unknown): string[] {
  const patterns = value === undefined ? ['**/*'] : value
  if (!Array.isArray(patterns) || patterns.length < 1 || patterns.length > 32) {
    throw new Error('Browser interception requires 1 to 32 URL patterns.')
  }
  return patterns.map((pattern) => {
    if (typeof pattern !== 'string' || !pattern.trim() || pattern.length > 2048) {
      throw new Error('Invalid browser intercept pattern.')
    }
    return pattern.trim()
  })
}
