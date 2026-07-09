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

type RuntimeComputerAction = {
  id: string
  kind: string
  target?: string
  payload?: Record<string, unknown>
}

type BrowserActionExecutor = (
  action: RuntimeComputerAction
) => Promise<Record<string, unknown> | void>

const browserActionExecutors = new Map<string, BrowserActionExecutor>()
let browserActionConsumerStarted = false

export function ensureTauriBrowserActionConsumer(): void {
  if (browserActionConsumerStarted) {
    return
  }
  browserActionConsumerStarted = true
  void consumeBrowserActionsLoop()
}

export function registerTauriBrowserActionExecutor(
  browserPageId: string,
  executor: BrowserActionExecutor
): () => void {
  browserActionExecutors.set(browserPageId, executor)
  return () => {
    if (browserActionExecutors.get(browserPageId) === executor) {
      browserActionExecutors.delete(browserPageId)
    }
  }
}

export async function consumeTauriBrowserActionsOnce(limit = 10): Promise<number> {
  const result = await pollBrowserActions(createBrowserActionPollInput({ limit }))
  const actions = parseRuntimeResourceResult<RuntimeComputerAction[]>(result)

  for (const action of actions) {
    await consumeBrowserAction(action)
  }

  return actions.length
}

async function consumeBrowserActionsLoop(): Promise<void> {
  for (;;) {
    try {
      const actionCount = await consumeTauriBrowserActionsOnce()
      await delay(actionCount > 0 ? 50 : 750)
    } catch {
      await delay(1000)
    }
  }
}

async function consumeBrowserAction(action: RuntimeComputerAction): Promise<void> {
  const executor = browserActionExecutors.get(resolveBrowserActionTabId(action))
  if (!executor) {
    await failBrowserAction(action, browserAdapterUnavailableMessage(action))
    return
  }

  try {
    const result = (await executor(action)) ?? {}
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
  await markRuntimeBrowserTabErrored(action, message).catch(() => undefined)
  await updateBrowserAction(
    createBrowserActionUpdateInput({
      actionId: action.id,
      status: 'failed',
      errorMessage: message
    })
  )
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
  const command = action.kind.startsWith('browser.')
    ? action.kind.slice('browser.'.length)
    : action.kind
  return `${TAURI_BROWSER_GUEST_UNAVAILABLE} Cannot run browser command: ${command}.`
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
