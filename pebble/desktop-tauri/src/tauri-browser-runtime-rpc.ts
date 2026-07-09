import type { DetectedBrowserInfo } from '../../../src/preload/api-types'
import { PEBBLE_BROWSER_PARTITION } from '../../../src/shared/constants'
import type { BrowserViewportResult } from '../../../src/shared/runtime-types'
import type { BrowserSessionProfile, BrowserSessionProfileScope } from '../../../src/shared/types'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { detectTauriBrowserSessionBrowsers } from './tauri-browser-runtime-profiles'

type RuntimeBrowserProfile = {
  id: string
  name: string
}

type RuntimeBrowserTab = {
  id: string
  worktreeId?: string
  profileId?: string
  title: string
  url: string
  status?: 'loading' | 'ready' | 'error'
}

type BrowserTabInfo = ReturnType<typeof mapRuntimeTab>
type BrowserNavigationResult = Pick<BrowserTabInfo, 'url' | 'title'>

type RuntimeBrowserRpcResult = {
  handled: boolean
  result?: unknown
}

const DEFAULT_PROFILE: BrowserSessionProfile = {
  id: 'default',
  scope: 'default',
  partition: PEBBLE_BROWSER_PARTITION,
  label: 'Default',
  source: null
}

export async function callTauriBrowserRuntimeRpc(
  method: string,
  params: unknown
): Promise<RuntimeBrowserRpcResult> {
  switch (method) {
    case 'browser.profileList':
      return handled({ profiles: await listBrowserProfiles() })
    case 'browser.profileCreate':
      return handled({ profile: await createBrowserProfile(params) })
    case 'browser.profileDelete':
      return handled(await deleteBrowserProfile(params))
    case 'browser.profileDetectBrowsers':
      return handled({ browsers: await detectBrowserProfiles() })
    case 'browser.profileImportFromBrowser':
      return handled({
        ok: false,
        reason: 'Browser cookie import requires the Tauri WebView adapter.'
      })
    case 'browser.profileClearDefaultCookies':
      return handled({ cleared: false })
    case 'browser.tabList':
      return handled({ tabs: await listBrowserTabs() })
    case 'browser.tabCreate':
      return handled({ browserPageId: await createBrowserTab(params) })
    case 'browser.tabClose':
      return handled({ closed: await closeBrowserTab(params) })
    case 'browser.tabShow':
      return handled({ tab: await showBrowserTab(params) })
    case 'browser.goto':
      return handled(await queueBrowserNavigation('goto', params))
    case 'browser.back':
      return handled(await queueBrowserNavigation('goBack', params))
    case 'browser.forward':
      return handled(await queueBrowserNavigation('goForward', params))
    case 'browser.reload':
      return handled(await queueBrowserNavigation('reload', params))
    case 'browser.viewport':
      return handled(readBrowserViewport(params))
    default:
      return { handled: false }
  }
}

async function listBrowserProfiles(): Promise<BrowserSessionProfile[]> {
  const profiles = await requestRuntimeJson<RuntimeBrowserProfile[]>('/v1/browser/profiles', {
    method: 'GET'
  })
  return [DEFAULT_PROFILE, ...profiles.map((profile) => mapRuntimeProfile(profile, 'isolated'))]
}

async function createBrowserProfile(params: unknown): Promise<BrowserSessionProfile | null> {
  const input = readObject(params)
  const scope = readProfileScope(input.scope)
  if (scope === 'default') {
    return null
  }
  const profile = await requestRuntimeJson<RuntimeBrowserProfile>('/v1/browser/profiles', {
    method: 'POST',
    body: {
      name: readString(input.label) ?? readString(input.name) ?? 'Browser Profile',
      persistent: true
    }
  })
  return mapRuntimeProfile(profile, scope)
}

async function deleteBrowserProfile(
  params: unknown
): Promise<{ deleted: boolean; profileId: string }> {
  const profileId = readRequiredString(readObject(params).profileId, 'browser profile id')
  if (profileId === DEFAULT_PROFILE.id) {
    return { deleted: false, profileId }
  }
  await requestRuntimeJson<RuntimeBrowserProfile>(
    `/v1/browser/profiles/${encodeURIComponent(profileId)}`,
    { method: 'DELETE' }
  )
  return { deleted: true, profileId }
}

async function detectBrowserProfiles(): Promise<DetectedBrowserInfo[]> {
  return detectTauriBrowserSessionBrowsers()
}

async function listBrowserTabs(): Promise<BrowserTabInfo[]> {
  const tabs = await requestRuntimeJson<RuntimeBrowserTab[]>('/v1/browser/tabs', { method: 'GET' })
  return tabs.map(mapRuntimeTab)
}

async function createBrowserTab(params: unknown): Promise<string> {
  const input = readObject(params)
  const url = readString(input.url) ?? 'about:blank'
  const tab = await requestRuntimeJson<RuntimeBrowserTab>('/v1/browser/tabs', {
    method: 'POST',
    body: {
      url,
      title: readString(input.title) ?? url,
      worktreeId: normalizeRuntimeWorktreeId(readString(input.worktree)),
      profileId: readString(input.profileId)
    }
  })
  return tab.id
}

async function closeBrowserTab(params: unknown): Promise<boolean> {
  const pageId = readBrowserPageId(params)
  await requestRuntimeJson<RuntimeBrowserTab>(`/v1/browser/tabs/${encodeURIComponent(pageId)}`, {
    method: 'DELETE'
  })
  return true
}

async function showBrowserTab(params: unknown): Promise<BrowserTabInfo> {
  const pageId = readBrowserPageId(params)
  const tabs = await listBrowserTabs()
  const tab = tabs.find((entry) => entry.browserPageId === pageId)
  if (!tab) {
    throw new Error(`Browser tab not found: ${pageId}`)
  }
  return tab
}

async function queueBrowserNavigation(
  command: 'goto' | 'goBack' | 'goForward' | 'reload',
  params: unknown
): Promise<BrowserNavigationResult> {
  const input = readObject(params)
  const pageId = readBrowserPageId(params)
  let tab = await readRuntimeBrowserTab(pageId)
  const payload: Record<string, unknown> = {}
  if (command === 'goto') {
    const url = readString(input.url) ?? 'about:blank'
    payload.url = url
    tab = await updateRuntimeBrowserTab(pageId, {
      url,
      title: url,
      status: 'loading'
    })
  } else if (command === 'reload') {
    tab = await updateRuntimeBrowserTab(pageId, { status: 'loading' })
  }

  await requestRuntimeJson(`/v1/browser/tabs/${encodeURIComponent(pageId)}/commands`, {
    method: 'POST',
    body: {
      command,
      payload
    }
  })

  return {
    url: tab.url,
    title: tab.title || tab.url
  }
}

async function readRuntimeBrowserTab(pageId: string): Promise<RuntimeBrowserTab> {
  const tabs = await requestRuntimeJson<RuntimeBrowserTab[]>('/v1/browser/tabs', { method: 'GET' })
  const tab = tabs.find((entry) => entry.id === pageId)
  if (!tab) {
    throw new Error(`Browser tab not found: ${pageId}`)
  }
  return tab
}

async function updateRuntimeBrowserTab(
  pageId: string,
  body: Partial<Pick<RuntimeBrowserTab, 'title' | 'url' | 'status'>>
): Promise<RuntimeBrowserTab> {
  return requestRuntimeJson<RuntimeBrowserTab>(`/v1/browser/tabs/${encodeURIComponent(pageId)}`, {
    method: 'PATCH',
    body
  })
}

function mapRuntimeProfile(
  profile: RuntimeBrowserProfile,
  scope: BrowserSessionProfileScope
): BrowserSessionProfile {
  return {
    id: profile.id,
    scope,
    partition: `persist:pebble-browser-session-${profile.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
    label: profile.name || 'Browser Profile',
    source: null
  }
}

function mapRuntimeTab(tab: RuntimeBrowserTab) {
  return {
    browserPageId: tab.id,
    index: 0,
    url: tab.url,
    title: tab.title || tab.url,
    active: false,
    worktreeId: tab.worktreeId || null,
    profileId: tab.profileId || null,
    profileLabel: null
  }
}

function handled(result: unknown): RuntimeBrowserRpcResult {
  return { handled: true, result }
}

// Why: until native WebView/CDP exists, echo the requested viewport so renderer
// input-scaling paths stay deterministic instead of failing before fallback.
function readBrowserViewport(params: unknown): BrowserViewportResult {
  const input = readObject(params)
  return {
    width: readPositiveNumber(input.width) ?? 1280,
    height: readPositiveNumber(input.height) ?? 720,
    deviceScaleFactor: readPositiveNumber(input.deviceScaleFactor) ?? 1,
    mobile: input.mobile === true
  }
}

function readBrowserPageId(params: unknown): string {
  const input = readObject(params)
  return readRequiredString(input.page ?? input.browserPageId ?? input.tabId, 'browser page id')
}

function readProfileScope(value: unknown): BrowserSessionProfileScope {
  if (value === 'default' || value === 'isolated' || value === 'imported') {
    return value
  }
  return 'isolated'
}

function normalizeRuntimeWorktreeId(value: string | null): string | undefined {
  if (!value) {
    return undefined
  }
  return value.startsWith('id:') ? value.slice(3) : value
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function readRequiredString(value: unknown, label: string): string {
  const result = readString(value)
  if (!result) {
    throw new Error(`${label} is required`)
  }
  return result
}
