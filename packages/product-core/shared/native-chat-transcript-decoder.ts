import type { NativeChatBlock, NativeChatMessage } from './native-chat-types'
import { claudeContentBlocks, toolResultOutput } from './native-chat-transcript-blocks'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from './native-chat-transcript-values'

export function decodeClaudeTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (!record || (record.type !== 'user' && record.type !== 'assistant')) {
    return null
  }
  const message = asRecord(record.message)
  const blocks = claudeContentBlocks(message?.content)
  if (blocks.length === 0) {
    return null
  }
  return {
    id: extractString(record.uuid) ?? extractString(message?.id) ?? fallbackId,
    role: claudeMessageRole(record.type, blocks),
    blocks,
    timestamp: parseTimestamp(record.timestamp),
    source: 'transcript'
  }
}

function claudeMessageRole(
  role: 'user' | 'assistant',
  blocks: NativeChatBlock[]
): NativeChatMessage['role'] {
  if (
    role === 'user' &&
    blocks.length > 0 &&
    blocks.every((block) => block.type === 'tool-result')
  ) {
    return 'tool'
  }
  return role
}

export function decodeCodexTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  const payload = asRecord(record?.payload)
  if (!record || !payload) {
    return null
  }
  const timestamp = parseTimestamp(record.timestamp)
  const id = extractString(payload.id) ?? fallbackId
  if (record.type === 'response_item') {
    return codexResponseItem(payload, id, timestamp)
  }
  if (record.type === 'event_msg') {
    return codexEventMessage(payload, id, timestamp)
  }
  return null
}

function codexResponseItem(
  payload: Record<string, unknown>,
  id: string,
  timestamp: number | null
): NativeChatMessage | null {
  if (payload.type === 'message') {
    const blocks = claudeContentBlocks(payload.content)
    if (blocks.length === 0) {
      return null
    }
    const role =
      payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : 'system'
    return { id, role, blocks, timestamp, source: 'transcript' }
  }
  if (payload.type === 'reasoning') {
    const text = extractString(payload.text) ?? codexSummaryText(payload.summary)
    return text
      ? { id, role: 'reasoning', blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
      : null
  }
  if (payload.type === 'function_call' || payload.type === 'local_shell_call') {
    return {
      id,
      role: 'assistant',
      blocks: [
        {
          type: 'tool-call',
          name: extractString(payload.name) ?? 'tool',
          input: codexCallInput(payload)
        }
      ],
      timestamp,
      source: 'transcript'
    }
  }
  if (payload.type === 'function_call_output') {
    return {
      id,
      role: 'tool',
      blocks: [codexToolResult(payload.output)],
      timestamp,
      source: 'transcript'
    }
  }
  return null
}

function codexEventMessage(
  payload: Record<string, unknown>,
  id: string,
  timestamp: number | null
): NativeChatMessage | null {
  const text = extractString(payload.message)
  if (!text) {
    return null
  }
  if (payload.type === 'user_message') {
    return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
  }
  if (payload.type === 'agent_message') {
    return {
      id,
      role: 'assistant',
      blocks: [{ type: 'text', text }],
      timestamp,
      source: 'transcript'
    }
  }
  return null
}

function codexCallInput(payload: Record<string, unknown>): unknown {
  return payload.arguments !== undefined
    ? payload.arguments
    : (payload.input ?? payload.action ?? null)
}

function codexToolResult(output: unknown): NativeChatBlock {
  const record = asRecord(output)
  const isError = record?.success === false || record?.is_error === true
  return {
    type: 'tool-result',
    output: toolResultOutput(record?.content ?? record?.output ?? output),
    ...(isError ? { isError: true } : {})
  }
}

function codexSummaryText(summary: unknown): string | null {
  if (!Array.isArray(summary)) {
    return null
  }
  const parts = summary
    .map((item) => extractString(asRecord(item)?.text) ?? extractString(item))
    .filter((text): text is string => Boolean(text))
  return parts.length > 0 ? parts.join('\n') : null
}

function parseTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}
