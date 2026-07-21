import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  comparePixels,
  diffLines,
  executeTauriBrowserDiff,
  rememberTauriBrowserSnapshot
} from './tauri-browser-diff'

describe('Tauri browser diff', () => {
  beforeEach(() => {
    rememberTauriBrowserSnapshot('page-a', { snapshot: '' })
    rememberTauriBrowserSnapshot('page-b', { snapshot: '' })
  })

  it('compares the current snapshot with the previous snapshot for that page', async () => {
    rememberTauriBrowserSnapshot('page-a', { snapshot: 'main\n  Before' })
    rememberTauriBrowserSnapshot('page-b', { snapshot: 'other page' })
    const call = vi.fn().mockResolvedValue({ snapshot: 'main\n  After' })

    await expect(executeTauriBrowserDiff('page-a', ['snapshot'], call)).resolves.toMatchObject({
      additions: 1,
      removals: 1,
      unchanged: 1,
      changed: true
    })
    expect(call).toHaveBeenCalledWith('browser.snapshot', {})
  })

  it('reads an explicit text baseline through the bounded native capture path', async () => {
    const baseline = btoa('main\n  Before')
    const call = vi.fn(async (method: string) => {
      if (method === 'browser.captureRead') {
        return { dataBase64: baseline }
      }
      return { snapshot: 'main\n  After' }
    })

    await executeTauriBrowserDiff(
      'page-a',
      ['snapshot', '--baseline', 'captures/before.txt', '--compact'],
      call
    )

    expect(call).toHaveBeenNthCalledWith(1, 'browser.snapshot', { compact: true })
    expect(call).toHaveBeenNthCalledWith(2, 'browser.captureRead', {
      path: 'captures/before.txt',
      kind: 'snapshot'
    })
  })

  it('compares two URLs in the existing native tab and leaves the second URL active', async () => {
    let activeUrl = ''
    const call = vi.fn(async (method: string, payload?: Record<string, unknown>) => {
      if (method === 'browser.goto') {
        activeUrl = String(payload?.url)
        return { url: activeUrl }
      }
      if (method === 'browser.snapshot') {
        return { snapshot: `heading ${activeUrl}` }
      }
      throw new Error(`unexpected ${method}`)
    })

    const result = await executeTauriBrowserDiff(
      'page-a',
      ['url', 'https://one.example', 'https://two.example'],
      call
    )

    expect(result).toMatchObject({ additions: 1, removals: 1, changed: true })
    expect(activeUrl).toBe('https://two.example')
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      'browser.goto',
      'browser.snapshot',
      'browser.goto',
      'browser.snapshot'
    ])
  })

  it('produces stable insert, delete, and unchanged operations', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc\nd')).toEqual([
      { kind: 'same', line: 'a' },
      { kind: 'remove', line: 'b' },
      { kind: 'add', line: 'x' },
      { kind: 'same', line: 'c' },
      { kind: 'add', line: 'd' }
    ])
  })

  it('applies the image threshold per pixel and emits an opaque visual diff', () => {
    const baseline = new Uint8ClampedArray([10, 10, 10, 255, 100, 100, 100, 255])
    const current = new Uint8ClampedArray([20, 10, 10, 255, 200, 100, 100, 255])
    const output = new Uint8ClampedArray(8)

    expect(comparePixels(baseline, current, output, 0.1)).toBe(1)
    expect(Array.from(output.slice(0, 4))).toEqual([5, 3, 3, 255])
    expect(Array.from(output.slice(4, 8))).toEqual([255, 0, 0, 255])
  })
})
