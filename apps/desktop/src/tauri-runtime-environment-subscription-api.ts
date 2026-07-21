import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { RuntimeRpcResponse } from '../../../packages/product-core/shared/runtime-rpc-envelope'

type RuntimeEnvironmentSubscribeArgs = Parameters<PreloadApi['runtimeEnvironments']['subscribe']>[0]
type RuntimeEnvironmentSubscriptionCallbacks = Parameters<
  PreloadApi['runtimeEnvironments']['subscribe']
>[1]
type RuntimeEnvironmentSubscriptionHandle = Awaited<
  ReturnType<PreloadApi['runtimeEnvironments']['subscribe']>
>

type TauriRuntimeEnvironmentSubscriptionEvent =
  | { subscriptionId: string; type: 'response'; response: RuntimeRpcResponse<unknown> }
  | { subscriptionId: string; type: 'binary'; bytesBase64: string }
  | { subscriptionId: string; type: 'error'; code: string; message: string }
  | { subscriptionId: string; type: 'close' }

type TauriRuntimeEnvironmentSubscribeResult = {
  subscriptionId: string
  requestId: string
}

const RUNTIME_ENVIRONMENT_SUBSCRIPTION_EVENT = 'pebble:runtime-environment-subscription'
const callbacksBySubscriptionId = new Map<string, RuntimeEnvironmentSubscriptionCallbacks>()
let subscriptionUnlistenPromise: Promise<() => void> | null = null

export async function subscribeTauriRuntimeEnvironment(
  args: RuntimeEnvironmentSubscribeArgs,
  callbacks: RuntimeEnvironmentSubscriptionCallbacks
): Promise<RuntimeEnvironmentSubscriptionHandle> {
  const subscriptionId = createRuntimeEnvironmentSubscriptionId()
  callbacksBySubscriptionId.set(subscriptionId, callbacks)
  await ensureSubscriptionListener()
  try {
    const result = await invoke<TauriRuntimeEnvironmentSubscribeResult>(
      'runtime_environments_subscribe',
      {
        input: {
          ...args,
          subscriptionId
        }
      }
    )
    if (result.subscriptionId !== subscriptionId) {
      releaseSubscription(subscriptionId)
      throw new Error('Runtime environment subscription id mismatch')
    }
  } catch (error) {
    releaseSubscription(subscriptionId)
    throw error
  }

  return {
    unsubscribe: () => {
      releaseSubscription(subscriptionId)
      void invoke('runtime_environments_unsubscribe', { input: { subscriptionId } })
    },
    sendBinary: (bytes) => {
      void invoke('runtime_environments_send_subscription_binary', {
        input: {
          subscriptionId,
          bytesBase64: bytesToBase64(bytes)
        }
      }).catch((error) => {
        callbacks.onError?.({
          code: 'remote_runtime_unavailable',
          message: error instanceof Error ? error.message : String(error)
        })
      })
    }
  }
}

async function ensureSubscriptionListener(): Promise<void> {
  if (subscriptionUnlistenPromise) {
    await subscriptionUnlistenPromise
    return
  }
  subscriptionUnlistenPromise = listen<TauriRuntimeEnvironmentSubscriptionEvent>(
    RUNTIME_ENVIRONMENT_SUBSCRIPTION_EVENT,
    (event) => dispatchSubscriptionEvent(event.payload)
  )
  await subscriptionUnlistenPromise
}

function dispatchSubscriptionEvent(event: TauriRuntimeEnvironmentSubscriptionEvent): void {
  const callbacks = callbacksBySubscriptionId.get(event.subscriptionId)
  if (!callbacks) {
    return
  }
  if (event.type === 'response') {
    callbacks.onResponse(event.response)
  } else if (event.type === 'binary') {
    callbacks.onBinary?.(base64ToBytes(event.bytesBase64))
  } else if (event.type === 'error') {
    callbacks.onError?.({ code: event.code, message: event.message })
  } else {
    releaseSubscription(event.subscriptionId)
    callbacks.onClose?.()
  }
}

function releaseSubscription(subscriptionId: string): void {
  callbacksBySubscriptionId.delete(subscriptionId)
  if (callbacksBySubscriptionId.size > 0 || !subscriptionUnlistenPromise) {
    return
  }
  void subscriptionUnlistenPromise.then((unlisten) => unlisten())
  subscriptionUnlistenPromise = null
}

function createRuntimeEnvironmentSubscriptionId(): string {
  const randomUuid = globalThis.crypto?.randomUUID
  if (typeof randomUuid === 'function') {
    return randomUuid.call(globalThis.crypto)
  }
  return `tauri-sub-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function bytesToBase64(bytes: Uint8Array<ArrayBufferLike>): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return globalThis.btoa(binary)
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = globalThis.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}
