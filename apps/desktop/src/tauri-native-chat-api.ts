import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type {
  NativeChatApi,
  NativeChatSubscribeArgs
} from '../../../packages/product-core/shared/native-chat-api-types'
import type {
  AgentType,
  NativeChatMessage
} from '../../../packages/product-core/shared/native-chat-types'
import {
  decodeClaudeTranscriptLine,
  decodeCodexTranscriptLine
} from '../../../packages/product-core/shared/native-chat-transcript-decoder'

type RawTranscriptEntry = { line: string; fallbackId: string }
type NativeReadResult = { entries: RawTranscriptEntry[] } | { error: string }
type NativeAppendEvent = { subscriptionId: string; entries: RawTranscriptEntry[] }

const DEFAULT_LIMIT = 40
const MAX_LIMIT = 2_000

export function createTauriNativeChatApi(): NativeChatApi {
  return {
    readSession: async (agent, sessionId, limit, transcriptPath) => {
      try {
        const result = await invoke<NativeReadResult>('native_chat_read_session', {
          input: { agent, sessionId, transcriptPath: transcriptPath ?? null }
        })
        if ('error' in result) {
          return result
        }
        const messages = decodeEntries(agent, result.entries)
        return { messages: messages.slice(-normalizeLimit(limit)) }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    subscribe: (args, onAppended) => subscribeNativeChat(args, onAppended)
  }
}

function subscribeNativeChat(
  args: NativeChatSubscribeArgs,
  onAppended: (messages: NativeChatMessage[]) => void
): () => void {
  let closed = false
  let unlisten: UnlistenFn | null = null
  const start = listen<NativeAppendEvent>('native-chat-appended', (event) => {
    if (closed || event.payload.subscriptionId !== args.subscriptionId) {
      return
    }
    const messages = decodeEntries(args.agent, event.payload.entries)
    if (messages.length > 0) {
      onAppended(messages)
    }
  })
    .then(async (stopListening) => {
      unlisten = stopListening
      if (closed) {
        stopListening()
        return
      }
      await invoke('native_chat_subscribe', {
        input: {
          subscriptionId: args.subscriptionId,
          agent: args.agent,
          sessionId: args.sessionId,
          transcriptPath: args.transcriptPath ?? null
        }
      })
    })
    .catch((error) => {
      if (!closed) {
        console.warn('[tauri-native-chat] transcript subscription failed', error)
      }
    })

  return () => {
    if (closed) {
      return
    }
    closed = true
    unlisten?.()
    unlisten = null
    // Why: teardown can race listener registration; wait for setup to settle so
    // no native watcher survives a pane that closed during subscription.
    void start.finally(() =>
      invoke('native_chat_unsubscribe', {
        input: { subscriptionId: args.subscriptionId }
      }).catch(() => undefined)
    )
  }
}

function decodeEntries(agent: AgentType, entries: RawTranscriptEntry[]): NativeChatMessage[] {
  const decode =
    agent === 'claude'
      ? decodeClaudeTranscriptLine
      : agent === 'codex'
        ? decodeCodexTranscriptLine
        : null
  if (!decode) {
    return []
  }
  const messages: NativeChatMessage[] = []
  for (const entry of entries) {
    const message = decode(entry.line, entry.fallbackId)
    if (message) {
      messages.push(message)
    }
  }
  return messages
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || (limit ?? 0) <= 0) {
    return DEFAULT_LIMIT
  }
  return Math.min(limit as number, MAX_LIMIT)
}

export type { NativeAppendEvent, NativeReadResult, RawTranscriptEntry }
