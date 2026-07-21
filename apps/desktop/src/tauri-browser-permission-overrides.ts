import { invoke } from '@tauri-apps/api/core'

import type { TauriBrowserPermissionWindow } from '@/components/browser-pane/tauri-browser-permission-profile'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { createRuntimeEventStreamCommand, readRuntimeEventStream } from './runtime-bridge'
import type { RuntimeEventStreamEntry } from './runtime-command-shapes'
import { subscribeRuntimeEventPush } from './tauri-runtime-event-push'
import {
  getTauriBrowserDeviceAccessCapabilities,
  resolveTauriBrowserDeviceSelection
} from './tauri-browser-device-access'

type RuntimeBrowserPermissionState = 'prompt' | 'granted' | 'denied'
export type TauriBrowserPersistedPermissionName = 'media' | 'hid' | 'webauthn'

export type RuntimeBrowserPermissionOverride = {
  profileId?: string
  origin: string
  name: string
  state: RuntimeBrowserPermissionState
  updatedAt: string
}

const profileHydrations = new Map<string, Promise<void>>()
let eventSyncStarted = false
let pollingActive = false
let pollingGeneration = 0

export function installTauriBrowserPermissionOverrideBridge(): void {
  ;(window as TauriBrowserPermissionWindow).__pebbleTauriBrowserPermissionOverrides = {
    ensureProfile: hydrateTauriBrowserPermissionProfile,
    deviceCapabilities: getTauriBrowserDeviceAccessCapabilities,
    resolveDeviceSelection: resolveTauriBrowserDeviceSelection,
    setPermission: persistTauriBrowserPermissionOverride
  }
  if (eventSyncStarted) {
    return
  }
  eventSyncStarted = true
  void subscribeRuntimeEventPush(handlePermissionRuntimeEvent, (pushActive) => {
    setPermissionPolling(!pushActive)
  })
    .then(({ supported }) => {
      if (!supported) {
        setPermissionPolling(true)
      }
    })
    .catch(() => setPermissionPolling(true))
}

export function syncTauriBrowserPermissionOverrideEvent(value: unknown): boolean {
  const permission = readRuntimeBrowserPermissionOverride(value)
  if (!permission) {
    return false
  }
  void syncNativePermissionOverrides([permission]).catch(() => undefined)
  return true
}

export async function persistTauriBrowserPermissionOverride(input: {
  profileId?: string
  origin: string
  name: TauriBrowserPersistedPermissionName
  state: RuntimeBrowserPermissionState
}): Promise<RuntimeBrowserPermissionOverride> {
  const persisted = await requestRuntimeJson<unknown>('/v1/browser/permissions', {
    method: 'POST',
    body: {
      profileId: input.profileId ?? '',
      origin: input.origin,
      name: input.name,
      state: input.state
    },
    timeoutMs: 5_000
  })
  const permission = readRuntimeBrowserPermissionOverride(persisted)
  if (!permission || permission.name !== input.name) {
    throw new Error('runtime returned an invalid browser permission')
  }
  await syncNativePermissionOverrides([permission])
  return permission
}

function setPermissionPolling(active: boolean): void {
  if (active === pollingActive) {
    return
  }
  pollingActive = active
  pollingGeneration += 1
  if (active) {
    void pumpPermissionEvents(pollingGeneration)
  }
}

async function pumpPermissionEvents(generation: number): Promise<void> {
  while (pollingActive && generation === pollingGeneration) {
    const result = await readRuntimeEventStream(
      createRuntimeEventStreamCommand({ topic: 'browser.changed', limit: 20 })
    ).catch(() => null)
    if (result?.transport === 'connected') {
      for (const event of result.events) {
        handlePermissionRuntimeEvent(event)
      }
    } else {
      await new Promise((resolve) => window.setTimeout(resolve, 1_000))
    }
  }
}

function handlePermissionRuntimeEvent(entry: RuntimeEventStreamEntry): void {
  if (entry.topic && entry.topic !== 'browser.changed') {
    return
  }
  try {
    const event = JSON.parse(entry.data) as { topic?: unknown; payload?: unknown }
    if (event.topic !== 'browser.changed') {
      return
    }
    const payload = readObject(event.payload)
    const deleted = readObject(payload.deleted)
    syncTauriBrowserPermissionOverrideEvent(Object.keys(deleted).length > 0 ? deleted : payload)
  } catch {
    // Malformed runtime events are ignored; profile hydration remains authoritative.
  }
}

async function hydrateTauriBrowserPermissionProfile(profileId: string): Promise<void> {
  const existing = profileHydrations.get(profileId)
  if (existing) {
    return existing
  }
  const hydration = fetchAndSyncPermissionProfile(profileId).catch((error) => {
    profileHydrations.delete(profileId)
    throw error
  })
  profileHydrations.set(profileId, hydration)
  return hydration
}

async function fetchAndSyncPermissionProfile(profileId: string): Promise<void> {
  const query = profileId ? `?profileId=${encodeURIComponent(profileId)}` : ''
  const records = await requestRuntimeJson<unknown[]>(`/v1/browser/permissions${query}`, {
    method: 'GET',
    timeoutMs: 5_000
  })
  const overrides = records
    .map(readRuntimeBrowserPermissionOverride)
    .filter((record): record is RuntimeBrowserPermissionOverride => record !== null)
  await syncNativePermissionOverrides(overrides)
}

async function syncNativePermissionOverrides(
  overrides: RuntimeBrowserPermissionOverride[]
): Promise<void> {
  await invoke('browser_permission_overrides_sync', { input: { overrides } })
}

export function readRuntimeBrowserPermissionOverride(
  value: unknown
): RuntimeBrowserPermissionOverride | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const input = value as Record<string, unknown>
  const state = input.state
  if (
    typeof input.origin !== 'string' ||
    typeof input.name !== 'string' ||
    typeof input.updatedAt !== 'string' ||
    (state !== 'prompt' && state !== 'granted' && state !== 'denied') ||
    (input.profileId !== undefined && typeof input.profileId !== 'string')
  ) {
    return null
  }
  return {
    ...(typeof input.profileId === 'string' ? { profileId: input.profileId } : {}),
    origin: input.origin,
    name: input.name,
    state,
    updatedAt: input.updatedAt
  }
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}
