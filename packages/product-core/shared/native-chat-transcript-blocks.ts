import type {
  NativeChatBlock,
  NativeChatImageRefBlock,
  NativeChatToolResultBlock
} from './native-chat-types'
import { asRecord, extractString } from './native-chat-transcript-values'

export function toolResultOutput(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    const record = asRecord(value)
    if (record) {
      const text = extractString(record.text) ?? extractString(record.content)
      if (text) {
        return text
      }
    }
    return value === undefined || value === null ? '' : JSON.stringify(value)
  }
  const parts: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    const record = asRecord(item)
    const text = extractString(record?.text) ?? extractString(record?.content)
    if (text) {
      parts.push(text)
    }
  }
  return parts.join('\n')
}

export function claudeContentBlocks(content: unknown): NativeChatBlock[] {
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const item of content) {
    if (typeof item === 'string') {
      if (item.trim()) {
        blocks.push({ type: 'text', text: item })
      }
      continue
    }
    const record = asRecord(item)
    const block = record ? claudeContentBlock(record) : null
    if (block) {
      blocks.push(block)
    }
  }
  return blocks
}

function claudeContentBlock(record: Record<string, unknown>): NativeChatBlock | null {
  switch (record.type) {
    case 'text': {
      const text = extractString(record.text)
      return text ? { type: 'text', text } : null
    }
    case 'thinking': {
      const text = extractString(record.thinking) ?? extractString(record.text)
      return text ? { type: 'text', text } : null
    }
    case 'tool_use':
      return { type: 'tool-call', name: extractString(record.name) ?? 'tool', input: record.input }
    case 'tool_result':
      return toolResultBlock(record)
    case 'image':
      return imageRefBlock(record)
    default:
      return null
  }
}

function toolResultBlock(record: Record<string, unknown>): NativeChatToolResultBlock {
  return {
    type: 'tool-result',
    output: toolResultOutput(record.content),
    ...(record.is_error === true ? { isError: true } : {})
  }
}

function imageRefBlock(record: Record<string, unknown>): NativeChatImageRefBlock | null {
  const source = asRecord(record.source)
  const url = extractString(source?.url) ?? extractString(record.url)
  const path = extractString(record.path)
  const alt = extractString(record.alt) ?? undefined
  if (!url && !path) {
    return null
  }
  return {
    type: 'image-ref',
    ...(path ? { path } : {}),
    ...(url ? { url } : {}),
    ...(alt ? { alt } : {})
  }
}
