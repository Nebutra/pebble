export function readRuntimeObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export function readRuntimeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function readRuntimeRawString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function readRuntimeRequiredString(value: unknown, label: string): string {
  const result = readRuntimeString(value)
  if (!result) {
    throw new Error(`${label} is required`)
  }
  return result
}

export function readRuntimeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
