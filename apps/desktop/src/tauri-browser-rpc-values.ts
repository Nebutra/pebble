export function readBrowserPageId(params: unknown): string {
  const input = readObject(params)
  return readRequiredString(input.page ?? input.browserPageId ?? input.tabId, 'browser page id')
}

export function normalizeRuntimeWorktreeId(value: string | null): string | undefined {
  if (!value) {
    return undefined
  }
  return value.startsWith('id:') ? value.slice(3) : value
}

export function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function readRequiredString(value: unknown, label: string): string {
  const result = readString(value)
  if (!result) {
    throw new Error(`${label} is required`)
  }
  return result
}
