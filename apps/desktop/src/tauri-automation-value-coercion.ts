// Param coercion shared by the automation RPC surface and the external
// automation bridge; split out of tauri-automations-api.ts.
export function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
