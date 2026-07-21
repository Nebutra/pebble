import { invoke } from '@tauri-apps/api/core'

import type {
  WarpThemeImportPreview,
  WarpThemeImportSource,
  WarpThemeImportPreviewTheme
} from '../../../packages/product-core/shared/terminal-custom-themes'
import type {
  ParseWarpThemeOptions,
  ParsedWarpThemeResult
} from '../../../packages/product-core/shared/warp-themes/parser'

type NativeWarpThemeFile = {
  label: string
  content: string
  sourceLabel: string
  contentHashDiscriminator: boolean
}
type NativeWarpThemeSources = {
  canceled: boolean
  sourceLabel?: string
  files: NativeWarpThemeFile[]
  skippedFiles: WarpThemeImportPreview['skippedFiles']
}

const PARSE_TIMEOUT_MS = 1_000

export async function previewTauriWarpThemeImport(
  source: unknown
): Promise<WarpThemeImportPreview> {
  if (!isWarpThemeSource(source)) {
    return emptyPreview('Invalid Warp theme import source.')
  }
  let selection: NativeWarpThemeSources
  try {
    selection = await invoke<NativeWarpThemeSources>('settings_read_warp_theme_sources', {
      input: source
    })
  } catch (error) {
    return emptyPreview(error instanceof Error ? error.message : String(error))
  }
  if (selection.canceled) {
    return { found: false, canceled: true, themes: [], skippedFiles: [] }
  }

  const importedAt = new Date().toISOString()
  const themes: WarpThemeImportPreviewTheme[] = []
  const skippedFiles = [...selection.skippedFiles]
  const idCounts = new Map<string, number>()
  for (const file of selection.files) {
    const discriminator = file.contentHashDiscriminator
      ? `${file.label}-${await contentDigest(file.content)}`
      : file.label
    const parsed = await parseInWorker(file.content, file.label, {
      idDiscriminator: discriminator,
      importedAt,
      sourceLabel: file.sourceLabel || selection.sourceLabel
    })
    if (!parsed.ok) {
      skippedFiles.push({ label: file.label, reason: parsed.reason })
      continue
    }
    const count = idCounts.get(parsed.theme.id) ?? 0
    idCounts.set(parsed.theme.id, count + 1)
    themes.push(count === 0 ? parsed.theme : duplicateTheme(parsed.theme, count + 1))
  }
  return { found: themes.length > 0, sourceLabel: selection.sourceLabel, themes, skippedFiles }
}

function parseInWorker(
  content: string,
  label: string,
  options: ParseWarpThemeOptions
): Promise<ParsedWarpThemeResult> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./tauri-warp-theme-parser-worker.ts', import.meta.url), {
      type: 'module'
    })
    const timer = window.setTimeout(() => {
      worker.terminate()
      resolve({ ok: false, reason: 'Theme file took too long to parse.' })
    }, PARSE_TIMEOUT_MS)
    worker.onmessage = (event: MessageEvent<ParsedWarpThemeResult>) => {
      window.clearTimeout(timer)
      worker.terminate()
      resolve(event.data)
    }
    worker.onerror = () => {
      window.clearTimeout(timer)
      worker.terminate()
      resolve({ ok: false, reason: 'Invalid YAML' })
    }
    worker.postMessage([content, label, options])
  })
}

async function contentDigest(content: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return [...new Uint8Array(bytes)]
    .slice(0, 6)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

function duplicateTheme(
  theme: WarpThemeImportPreviewTheme,
  count: number
): WarpThemeImportPreviewTheme {
  const id = `${theme.id}-${count}`
  return { ...theme, id, selectionValue: `custom:${id}` }
}

function isWarpThemeSource(value: unknown): value is WarpThemeImportSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const entries = Object.entries(value)
  return (
    entries.length === 1 &&
    entries[0]?.[0] === 'kind' &&
    ['auto', 'chooseFile', 'chooseFolder'].includes(String(entries[0][1]))
  )
}

function emptyPreview(error: string): WarpThemeImportPreview {
  return { found: false, themes: [], skippedFiles: [], error }
}
