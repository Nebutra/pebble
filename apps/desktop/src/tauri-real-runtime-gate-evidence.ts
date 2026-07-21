import { invoke } from '@tauri-apps/api/core'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'

export type GateSurface = 'terminal' | 'browser' | 'source-control' | 'checks'
export type GateConfig = {
  repoPath: string
  browserUrl?: string | null
  screenshotPaths?: Partial<Record<GateSurface, string>> | null
  launchEpochMs?: number | null
}
type RuntimeOutputChunk = { content: string }

export const GATE_TIMEOUT_MS = 30_000

export function writeEvidence(value: Record<string, unknown>): Promise<boolean> {
  return invoke<boolean>('functional_gate_write_evidence', {
    input: { bodyJson: JSON.stringify(value) }
  })
}

export function writeProgress(stage: string): Promise<boolean> {
  return writeEvidence({ status: 'running', stage })
}

export async function waitFor<T>(read: () => T | Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + GATE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const value = await read()
    if (value) {
      return value
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50))
  }
  throw new Error('real runtime gate timed out')
}

export function terminalText(ptyId: string): string {
  return (
    document.querySelector(`[data-pty-id="${CSS.escape(ptyId)}"] .xterm-rows`)?.textContent ?? ''
  )
}

export async function runtimeTailContains(ptyId: string, marker: string): Promise<boolean> {
  const tail = await requestRuntimeJson<{ chunks: RuntimeOutputChunk[] }>(
    `/v1/sessions/${encodeURIComponent(ptyId)}/tail?limit=200`,
    { method: 'GET', timeoutMs: 2_000 }
  )
  return tail.chunks.some((chunk) => chunk.content.includes(marker))
}

export async function captureGateSurface(config: GateConfig, surface: GateSurface): Promise<number> {
  const path = config.screenshotPaths?.[surface]
  if (!path) {
    return 0
  }
  await new Promise((resolve) => globalThis.setTimeout(resolve, 50))
  document.querySelectorAll('[data-sonner-toast]').forEach((toast) => toast.remove())
  document
    .querySelectorAll('[data-radix-popper-content-wrapper]')
    .forEach((popover) => popover.remove())
  document.querySelector('[data-contextual-tour-target="setup-guide-entry"]')?.remove()
  const restoreCanvases = surface === 'browser' ? () => undefined : await materializeCanvases()
  try {
    await writeProgress(`${surface}-capture-ready`)
    await waitFor(() => invoke<boolean>('functional_gate_capture_ready', { surface }))
  } finally {
    restoreCanvases()
  }
  return 0
}

async function materializeCanvases(): Promise<() => void> {
  const snapshots: { canvas: HTMLCanvasElement; image: HTMLImageElement; opacity: string }[] = []
  for (const canvas of document.querySelectorAll('canvas')) {
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      continue
    }
    try {
      const image = document.createElement('img')
      image.src = canvas.toDataURL('image/png')
      image.dataset.functionalCanvasSnapshot = 'true'
      Object.assign(image.style, {
        height: `${rect.height}px`,
        left: `${rect.left}px`,
        pointerEvents: 'none',
        position: 'fixed',
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        zIndex: '2147483646'
      })
      const opacity = canvas.style.opacity
      canvas.style.opacity = '0'
      document.body.append(image)
      snapshots.push({ canvas, image, opacity })
    } catch {
      // Cross-origin or protected canvases remain native; functional capture
      // must not mutate their runtime behavior merely to obtain evidence.
    }
  }
  await Promise.all(snapshots.map(({ image }) => image.decode().catch(() => undefined)))
  return () => {
    for (const { canvas, image, opacity } of snapshots) {
      canvas.style.opacity = opacity
      image.remove()
    }
  }
}
