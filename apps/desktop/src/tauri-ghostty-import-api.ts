import { invoke } from '@tauri-apps/api/core'

import { mapGhosttyToPebble } from '../../../packages/product-core/shared/ghostty/mapper'
import { parseGhosttyConfig } from '../../../packages/product-core/shared/ghostty/parser'
import type {
  GhosttyImportPreview,
  GlobalSettings
} from '../../../packages/product-core/shared/types'

type GhosttySource = { path: string; content: string }
type GhosttySourcesResult = { configs: GhosttySource[] }
type ParsedGhosttyConfig = Record<string, string | string[]>

const THEME_COLOR_KEYS = new Set([
  'palette',
  'background',
  'foreground',
  'cursor-color',
  'cursor-text',
  'selection-background',
  'selection-foreground',
  'bold-color',
  'split-divider-color'
])

export async function previewTauriGhosttyImport(
  currentSettings: GlobalSettings
): Promise<GhosttyImportPreview> {
  let sources: GhosttySourcesResult
  try {
    sources = await invoke<GhosttySourcesResult>('settings_read_ghostty_sources')
  } catch (error) {
    return emptyPreview(error instanceof Error ? error.message : String(error))
  }
  if (sources.configs.length === 0) {
    return emptyPreview()
  }

  const parsed: ParsedGhosttyConfig = {}
  for (const source of sources.configs) {
    mergeParsedConfig(parsed, parseGhosttyConfig(source.content))
  }
  const themeUnsupportedKeys = await applyThemeReference(parsed)
  const mapped = mapGhosttyToPebble(parsed, navigator.userAgent.includes('Mac'))
  const diff = omitUnchangedSettings(mapped.diff, currentSettings)
  return {
    found: true,
    configPath: sources.configs[0]?.path,
    configPaths: sources.configs.map((source) => source.path),
    diff,
    unsupportedKeys: [...mapped.unsupportedKeys, ...themeUnsupportedKeys]
  }
}

async function applyThemeReference(parsed: ParsedGhosttyConfig): Promise<string[]> {
  const rawTheme = parsed.theme
  if (rawTheme === undefined) {
    return []
  }
  delete parsed.theme
  const name = (Array.isArray(rawTheme) ? (rawTheme.at(-1) ?? '') : rawTheme).trim()
  if (name.split(',').some((part) => /^(light|dark):/.test(part.trim()))) {
    return ['theme (light:/dark: pairs not supported)']
  }
  const content = await invoke<string | null>('settings_read_ghostty_theme', {
    input: { name }
  })
  if (content === null) {
    return ['theme (theme file not found)']
  }
  const theme = parseGhosttyConfig(content)
  for (const [key, value] of Object.entries(theme)) {
    if (!THEME_COLOR_KEYS.has(key)) {
      continue
    }
    if (key === 'palette') {
      parsed[key] = [...asArray(value), ...asArray(parsed[key])]
    } else if (parsed[key] === undefined) {
      parsed[key] = value
    }
  }
  return []
}

function mergeParsedConfig(target: ParsedGhosttyConfig, source: ParsedGhosttyConfig): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = key === 'palette' ? [...asArray(target[key]), ...asArray(value)] : value
  }
}

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

function omitUnchangedSettings(
  diff: Partial<GlobalSettings>,
  current: GlobalSettings
): Partial<GlobalSettings> {
  const changed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(diff)) {
    if (stableStringify(current[key as keyof GlobalSettings]) !== stableStringify(value)) {
      changed[key] = value
    }
  }
  return changed as Partial<GlobalSettings>
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`
}

function emptyPreview(error?: string): GhosttyImportPreview {
  return { found: false, diff: {}, unsupportedKeys: [], ...(error ? { error } : {}) }
}
