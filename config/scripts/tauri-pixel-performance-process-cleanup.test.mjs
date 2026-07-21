import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('./run-tauri-pixel-performance-gate.mjs', import.meta.url),
  'utf8'
)

describe('Tauri pixel performance process cleanup', () => {
  it('owns and terminates the optimized renderer preview process tree', () => {
    const previewStart = source.indexOf("const preview = spawn(command('npm')")
    const captureStart = source.indexOf('async function captureTauriSurface')
    const previewLifecycle = source.slice(previewStart, captureStart)

    expect(previewLifecycle).toContain("detached: process.platform !== 'win32'")
    expect(previewLifecycle).toContain('await stopProcessTree(preview)')
    expect(previewLifecycle).not.toContain("preview.kill('SIGTERM')")
  })
})
