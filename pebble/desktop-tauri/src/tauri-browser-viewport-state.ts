import type { BrowserViewportResult } from '../../../src/shared/runtime-types'
import type { BrowserViewportOverride } from '../../../src/shared/types'

const DEFAULT_TAURI_BROWSER_VIEWPORT: BrowserViewportResult = {
  width: 1280,
  height: 720,
  deviceScaleFactor: 1,
  mobile: false
}

const viewportOverridesByPageId = new Map<string, BrowserViewportOverride>()

export function setTauriBrowserViewportOverride(args: {
  browserPageId: string
  override: BrowserViewportOverride | null
}): void {
  const pageId = readString(args.browserPageId)
  if (!pageId) {
    return
  }
  const override = normalizeViewportOverride(args.override)
  if (!override) {
    viewportOverridesByPageId.delete(pageId)
    return
  }
  viewportOverridesByPageId.set(pageId, override)
}

export function readTauriBrowserViewport(params: unknown): BrowserViewportResult {
  const input = readObject(params)
  const pageId = readString(input.page ?? input.browserPageId ?? input.tabId)
  const stored = pageId ? viewportOverridesByPageId.get(pageId) : undefined
  return {
    width:
      readPositiveNumber(input.width) ?? stored?.width ?? DEFAULT_TAURI_BROWSER_VIEWPORT.width,
    height:
      readPositiveNumber(input.height) ?? stored?.height ?? DEFAULT_TAURI_BROWSER_VIEWPORT.height,
    deviceScaleFactor:
      readPositiveNumber(input.deviceScaleFactor) ??
      stored?.deviceScaleFactor ??
      DEFAULT_TAURI_BROWSER_VIEWPORT.deviceScaleFactor,
    mobile:
      typeof input.mobile === 'boolean'
        ? input.mobile
        : (stored?.mobile ?? DEFAULT_TAURI_BROWSER_VIEWPORT.mobile)
  }
}

export function clearTauriBrowserViewportOverrides(): void {
  viewportOverridesByPageId.clear()
}

function normalizeViewportOverride(
  override: BrowserViewportOverride | null
): BrowserViewportOverride | null {
  if (!override) {
    return null
  }
  const width = readPositiveNumber(override.width)
  const height = readPositiveNumber(override.height)
  const deviceScaleFactor = readPositiveNumber(override.deviceScaleFactor)
  if (!width || !height || !deviceScaleFactor) {
    return null
  }
  return {
    width,
    height,
    deviceScaleFactor,
    mobile: override.mobile === true
  }
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
