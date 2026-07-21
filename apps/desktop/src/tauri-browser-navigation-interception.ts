import { invoke } from '@tauri-apps/api/core'

type NativeInterceptRequest = {
  id: string
  url: string
  method: string
  headers: Record<string, string>
  resourceType: string
  timestampMs: number
  browserTabId?: string
  frameId?: string
  requestId?: string
  state?: string
}

export type NativeBrowserInterceptRoute = {
  pattern: string
  action: 'pause' | 'abort' | 'fulfill'
  body?: string
  status?: number
  contentType?: string
}

export function tauriBrowserInterceptionScopes(nativeScope: string): string[] {
  return [nativeScope, 'document-main-frame-fetch-async-xhr']
}

export async function enableTauriBrowserNavigationInterception(
  browserTabId: string,
  routes: NativeBrowserInterceptRoute[]
): Promise<{
  enabled: boolean
  patterns: string[]
  routes: NativeBrowserInterceptRoute[]
  scope: string
}> {
  return invoke('browser_navigation_interception_enable', {
    input: { browserTabId, routes }
  })
}

export async function disableTauriBrowserNavigationInterception(
  browserTabId: string
): Promise<boolean> {
  return invoke('browser_navigation_interception_disable', { input: { browserTabId } })
}

export async function listTauriBrowserNavigationInterceptions(browserTabId: string): Promise<{
  requests: NativeInterceptRequest[]
  pausedRequests?: NativeInterceptRequest[]
  patterns: string[]
  routes: NativeBrowserInterceptRoute[]
  scope: string
}> {
  return invoke('browser_navigation_interception_list', { input: { browserTabId } })
}

export type NativeBrowserRequestDecision =
  | { action: 'continue' }
  | { action: 'fail'; reason?: string }
  | {
      action: 'fulfill'
      body?: string
      status?: number
      headers?: Record<string, string>
    }

export async function resolveTauriBrowserRequest(
  browserTabId: string,
  requestId: string,
  decision: NativeBrowserRequestDecision
): Promise<boolean> {
  return invoke('browser_request_control_resolve', {
    input: { browserTabId, requestId, decision }
  })
}
