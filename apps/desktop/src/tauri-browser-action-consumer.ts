import {
  createBrowserActionPollInput,
  createBrowserActionUpdateInput,
  createRuntimeResourceRequestCommand,
  pollBrowserActions,
  requestRuntimeResourceJson,
  updateBrowserAction
} from './runtime-bridge'
import type { RuntimeResourceGetResult } from './runtime-command-shapes'
import { TAURI_BROWSER_GUEST_UNAVAILABLE } from './tauri-browser-runtime-profiles'
import { subscribeRuntimeEventPush } from './tauri-runtime-event-push'
import { readTauriComputerActionEvent } from './tauri-computer-action-event'
import {
  BrowserActionExecutorRegistry,
  type BrowserActionExecutor
} from './tauri-browser-action-executor-registry'

type RuntimeComputerAction = {
  id: string
  kind: string
  target?: string
  payload?: Record<string, unknown>
}

type BrowserActionExecutorBridge = {
  register: typeof registerTauriBrowserActionExecutor
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __pebbleTauriBrowserActionExecutors?: BrowserActionExecutorBridge
  }
}

const browserActionExecutors = new BrowserActionExecutorRegistry<RuntimeComputerAction>()
let browserActionConsumerStarted = false
let wakeBrowserActionConsumer: (() => void) | null = null
let browserActionWakePending = false
let browserActionPushActive = false

export function ensureTauriBrowserActionConsumer(): void {
  installTauriBrowserActionExecutorBridge()
  if (browserActionConsumerStarted) {
    return
  }
  browserActionConsumerStarted = true
  void subscribeRuntimeEventPush(handleComputerActionPush, (active) => {
    browserActionPushActive = active
    signalBrowserActionConsumer()
  })
  void consumeBrowserActionsLoop()
}

export function installTauriBrowserActionExecutorBridge(): void {
  if (typeof window === 'undefined') {
    return
  }
  window.__pebbleTauriBrowserActionExecutors = {
    register: registerTauriBrowserActionExecutor
  }
}

export function registerTauriBrowserActionExecutor(
  browserPageId: string,
  executor: BrowserActionExecutor<RuntimeComputerAction>
): () => void {
  const unregister = browserActionExecutors.register(browserPageId, executor)
  signalBrowserActionConsumer()
  return unregister
}

export async function executeTauriBrowserActionLocally(
  pageId: string,
  command: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const registration = browserActionExecutors.get(pageId)
  if (!registration) {
    return null
  }
  const result = await registration.executor({
    id: `local-${crypto.randomUUID()}`,
    kind: `browser.${command}`,
    target: pageId,
    payload: { command, tabId: pageId, ...payload }
  })
  if (!browserActionExecutors.isCurrent(registration)) {
    throw new Error('Browser WebView ownership changed while the command was running.')
  }
  if (!result || Object.keys(result).length === 0) {
    throw new Error('Browser WebView returned no verifiable command result.')
  }
  return result
}

export async function consumeTauriBrowserActionsOnce(limit = 10): Promise<number> {
  const targets = browserActionExecutors.targets()
  if (targets.length === 0) {
    return 0
  }
  const result = await pollBrowserActions(createBrowserActionPollInput({ limit, targets }))
  const actions = parseRuntimeResourceResult<RuntimeComputerAction[]>(result)

  for (const action of actions) {
    await consumeBrowserAction(action)
  }

  return actions.length
}

async function consumeBrowserActionsLoop(): Promise<void> {
  for (;;) {
    if (browserActionExecutors.targets().length === 0) {
      await waitForBrowserActionExecutor()
      continue
    }
    try {
      const actionCount = await consumeTauriBrowserActionsOnce()
      if (actionCount > 0) {
        continue
      }
      await waitForBrowserActionSignal(browserActionPushActive ? 30_000 : 750)
    } catch {
      await delay(1000)
    }
  }
}

function waitForBrowserActionExecutor(): Promise<void> {
  return waitForBrowserActionSignal(30_000)
}

function waitForBrowserActionSignal(timeoutMs: number): Promise<void> {
  if (browserActionWakePending) {
    browserActionWakePending = false
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const timeout = window.setTimeout(done, timeoutMs)
    function done(): void {
      window.clearTimeout(timeout)
      browserActionWakePending = false
      wakeBrowserActionConsumer = null
      resolve()
    }
    // Why: browser actions cannot execute without a page WebView. Sleeping
    // here removes permanent Tauri invokes from non-browser workspaces.
    wakeBrowserActionConsumer = done
  })
}

function signalBrowserActionConsumer(): void {
  browserActionWakePending = true
  wakeBrowserActionConsumer?.()
}

function handleComputerActionPush(entry: Parameters<typeof readTauriComputerActionEvent>[0]): void {
  if (!isQueuedBrowserAction(readTauriComputerActionEvent(entry))) {
    return
  }
  signalBrowserActionConsumer()
}

function isQueuedBrowserAction(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false
  }
  const action = value as { kind?: unknown; status?: unknown }
  return (
    action.status === 'queued' &&
    typeof action.kind === 'string' &&
    action.kind.startsWith('browser.')
  )
}

async function consumeBrowserAction(action: RuntimeComputerAction): Promise<void> {
  const registration = browserActionExecutors.get(resolveBrowserActionTabId(action))
  if (!registration) {
    await failBrowserAction(action, browserAdapterUnavailableMessage(action))
    return
  }

  try {
    const result = await registration.executor(action)
    if (!browserActionExecutors.isCurrent(registration)) {
      throw new Error('Browser WebView ownership changed while the command was running.')
    }
    if (!result || Object.keys(result).length === 0) {
      throw new Error('Browser WebView returned no verifiable command result.')
    }
    await updateBrowserAction(
      createBrowserActionUpdateInput({
        actionId: action.id,
        status: 'completed',
        resultJson: JSON.stringify(result)
      })
    )
  } catch (error) {
    await failBrowserAction(action, getErrorMessage(error))
  }
}

async function failBrowserAction(action: RuntimeComputerAction, message: string): Promise<void> {
  if (shouldMarkRuntimeBrowserTabErrored(action)) {
    await markRuntimeBrowserTabErrored(action, message).catch(() => undefined)
  }
  await updateBrowserAction(
    createBrowserActionUpdateInput({
      actionId: action.id,
      status: 'failed',
      errorMessage: message
    })
  )
}

function shouldMarkRuntimeBrowserTabErrored(action: RuntimeComputerAction): boolean {
  switch (resolveBrowserActionCommand(action)) {
    case 'goto':
    case 'reload':
      return true
    case 'back':
    case 'forward':
    case 'goBack':
    case 'goForward':
    case 'stop':
    case 'screenshot':
      return false
    default:
      return true
  }
}

async function markRuntimeBrowserTabErrored(
  action: RuntimeComputerAction,
  message: string
): Promise<void> {
  const tabId = resolveBrowserActionTabId(action)
  if (!tabId) {
    return
  }
  await requestRuntimeResourceJson(
    createRuntimeResourceRequestCommand({
      method: 'PATCH',
      path: `/v1/browser/tabs/${encodeURIComponent(tabId)}`,
      bodyJson: JSON.stringify({
        status: 'error',
        error: message
      }),
      timeoutMs: 1500
    })
  )
}

function resolveBrowserActionTabId(action: RuntimeComputerAction): string {
  const payloadTabId = action.payload?.tabId
  if (typeof payloadTabId === 'string' && payloadTabId.trim().length > 0) {
    return payloadTabId.trim()
  }
  return action.target?.trim() ?? ''
}

function browserAdapterUnavailableMessage(action: RuntimeComputerAction): string {
  const command = resolveBrowserActionCommand(action)
  return `${TAURI_BROWSER_GUEST_UNAVAILABLE} Cannot run browser command: ${command}.`
}

function resolveBrowserActionCommand(action: RuntimeComputerAction): string {
  const payloadCommand = action.payload?.command
  if (typeof payloadCommand === 'string' && payloadCommand.trim().length > 0) {
    return payloadCommand.trim()
  }
  return action.kind.startsWith('browser.') ? action.kind.slice('browser.'.length) : action.kind
}

function parseRuntimeResourceResult<T>(result: RuntimeResourceGetResult): T {
  if (result.transport !== 'connected') {
    throw new Error(result.error ?? `Runtime transport failed: ${result.transport}`)
  }
  if (result.httpStatus !== null && (result.httpStatus < 200 || result.httpStatus > 299)) {
    throw new Error(result.body ?? `Runtime request failed with HTTP ${result.httpStatus}`)
  }
  return result.body ? (JSON.parse(result.body) as T) : ([] as T)
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
