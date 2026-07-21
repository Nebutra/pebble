import type { DetectedBrowserInfo } from '../../../packages/product-core/shared/browser-api-types'
import { PEBBLE_BROWSER_PARTITION } from '../../../packages/product-core/shared/constants'
import type {
  BrowserSessionProfile,
  BrowserSessionProfileScope
} from '../../../packages/product-core/shared/types'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { notifyTauriBrowserActiveTab } from './tauri-browser-runtime-events'
import {
  deleteTauriBrowserProfileStorage,
  detectTauriBrowserSessionBrowsers
} from './tauri-browser-runtime-profiles'
import {
  normalizeRuntimeWorktreeId,
  readBrowserPageId,
  readObject,
  readRequiredString,
  readString
} from './tauri-browser-rpc-values'

type RuntimeBrowserProfile = { id: string; name: string }
type RuntimeBrowserTab = {
  id: string
  worktreeId?: string
  profileId?: string
  title: string
  url: string
  status?: 'loading' | 'ready' | 'error'
}
type BrowserTabInfo = ReturnType<typeof mapRuntimeTab>

const DEFAULT_PROFILE: BrowserSessionProfile = {
  id: 'default',
  scope: 'default',
  partition: PEBBLE_BROWSER_PARTITION,
  label: 'Default',
  source: null
}
const activeBrowserTabByWorktree = new Map<string, string>()

export async function listBrowserProfiles(): Promise<BrowserSessionProfile[]> {
  const profiles = await requestRuntimeJson<RuntimeBrowserProfile[]>('/v1/browser/profiles', {
    method: 'GET'
  })
  return [DEFAULT_PROFILE, ...profiles.map((profile) => mapRuntimeProfile(profile, 'isolated'))]
}

export async function createBrowserProfile(params: unknown): Promise<BrowserSessionProfile | null> {
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

export async function deleteBrowserProfile(
  params: unknown
): Promise<{ deleted: boolean; profileId: string }> {
  const profileId = readRequiredString(readObject(params).profileId, 'browser profile id')
  if (profileId === DEFAULT_PROFILE.id) {
    return { deleted: false, profileId }
  }
  await deleteTauriBrowserProfileStorage(profileId)
  await requestRuntimeJson<RuntimeBrowserProfile>(
    `/v1/browser/profiles/${encodeURIComponent(profileId)}`,
    { method: 'DELETE' }
  )
  return { deleted: true, profileId }
}

export function detectBrowserProfiles(): Promise<DetectedBrowserInfo[]> {
  return detectTauriBrowserSessionBrowsers()
}

export async function listBrowserTabs(): Promise<BrowserTabInfo[]> {
  const tabs = await requestRuntimeJson<RuntimeBrowserTab[]>('/v1/browser/tabs', { method: 'GET' })
  return tabs.map(mapRuntimeTab)
}

export async function createBrowserTab(params: unknown): Promise<string> {
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
  activeBrowserTabByWorktree.set(tab.worktreeId ?? '', tab.id)
  return tab.id
}

export async function closeBrowserTab(params: unknown): Promise<boolean> {
  const pageId = readBrowserPageId(params)
  await requestRuntimeJson<RuntimeBrowserTab>(`/v1/browser/tabs/${encodeURIComponent(pageId)}`, {
    method: 'DELETE'
  })
  for (const [worktreeId, activePageId] of activeBrowserTabByWorktree) {
    if (activePageId === pageId) {
      activeBrowserTabByWorktree.delete(worktreeId)
    }
  }
  return true
}

export async function showBrowserTab(params: unknown): Promise<BrowserTabInfo> {
  const pageId = readBrowserPageId(params)
  const tab = (await listBrowserTabs()).find((entry) => entry.browserPageId === pageId)
  if (!tab) {
    throw new Error(`Browser tab not found: ${pageId}`)
  }
  return tab
}

export async function currentBrowserTab(params: unknown): Promise<BrowserTabInfo> {
  const worktreeId = normalizeRuntimeWorktreeId(readString(readObject(params).worktree)) ?? ''
  const tabs = (await listBrowserTabs()).filter((tab) => (tab.worktreeId ?? '') === worktreeId)
  const activePageId = activeBrowserTabByWorktree.get(worktreeId)
  const tab = tabs.find((entry) => entry.browserPageId === activePageId) ?? tabs[0]
  if (!tab) {
    throw new Error('No browser tab open in this worktree')
  }
  activeBrowserTabByWorktree.set(worktreeId, tab.browserPageId)
  return { ...tab, active: true }
}

export async function switchBrowserTab(params: unknown): Promise<{ browserPageId: string }> {
  const input = readObject(params)
  const worktreeId = normalizeRuntimeWorktreeId(readString(input.worktree)) ?? ''
  const allTabs = await listBrowserTabs()
  const requestedPageId = readString(input.page ?? input.browserPageId ?? input.tabId)
  const tabs =
    requestedPageId && !readString(input.worktree)
      ? allTabs
      : allTabs.filter((tab) => (tab.worktreeId ?? '') === worktreeId)
  const index =
    typeof input.index === 'number' && Number.isInteger(input.index) ? input.index : null
  const tab = requestedPageId
    ? tabs.find((entry) => entry.browserPageId === requestedPageId)
    : index !== null
      ? tabs[index]
      : undefined
  if (!tab) {
    throw new Error('Browser tab was not found in this worktree')
  }
  activeBrowserTabByWorktree.set(tab.worktreeId ?? worktreeId, tab.browserPageId)
  if (input.focus === true) {
    notifyTauriBrowserActiveTab(tab.browserPageId)
  }
  return { browserPageId: tab.browserPageId }
}

export async function setBrowserTabProfile(params: unknown) {
  const input = readObject(params)
  const pageId = readBrowserPageId(input)
  const profileId = readRequiredString(input.profileId, 'browser profile id')
  const profile = (await listBrowserProfiles()).find((entry) => entry.id === profileId)
  if (!profile) {
    throw new Error(`Browser profile not found: ${profileId}`)
  }
  const tab = await requestRuntimeJson<RuntimeBrowserTab>(
    `/v1/browser/tabs/${encodeURIComponent(pageId)}`,
    { method: 'PATCH', body: { profileId } }
  )
  return { browserPageId: tab.id, profileId, profileLabel: profile.label }
}

export async function showBrowserTabProfile(params: unknown) {
  const tab = await showBrowserTab(params)
  const profile = (await listBrowserProfiles()).find((entry) => entry.id === tab.profileId)
  return {
    browserPageId: tab.browserPageId,
    worktreeId: tab.worktreeId,
    profileId: tab.profileId,
    profileLabel: profile?.label ?? null
  }
}

export async function cloneBrowserTabProfile(params: unknown) {
  const input = readObject(params)
  const source = await showBrowserTab(input)
  const profileId = readRequiredString(input.profileId, 'browser profile id')
  const browserPageId = await createBrowserTab({
    url: source.url,
    title: source.title,
    worktree: source.worktreeId,
    profileId
  })
  return { browserPageId, sourceBrowserPageId: source.browserPageId, profileId }
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
  const worktreeId = tab.worktreeId || null
  return {
    browserPageId: tab.id,
    index: 0,
    url: tab.url,
    title: tab.title || tab.url,
    active: activeBrowserTabByWorktree.get(worktreeId ?? '') === tab.id,
    worktreeId,
    profileId: tab.profileId || null,
    profileLabel: null
  }
}

function readProfileScope(value: unknown): BrowserSessionProfileScope {
  return value === 'default' || value === 'isolated' || value === 'imported' ? value : 'isolated'
}
