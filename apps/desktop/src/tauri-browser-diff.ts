import { buildTextDiff } from './tauri-browser-text-diff'

export { diffLines } from './tauri-browser-text-diff'

type BrowserCall = (method: string, payload?: Record<string, unknown>) => Promise<unknown>

const previousSnapshots = new Map<string, string>()

export async function executeTauriBrowserDiff(
  page: string,
  args: string[],
  call: BrowserCall
): Promise<unknown> {
  const kind = requiredAt(args, 0, 'diff kind')
  if (kind === 'snapshot') {
    return diffSnapshot(page, args.slice(1), call)
  }
  if (kind === 'screenshot') {
    return diffScreenshot(args.slice(1), call)
  }
  if (kind === 'url') {
    return diffUrls(page, args.slice(1), call)
  }
  throw new Error(`Unsupported browser diff kind: ${kind}`)
}

export function rememberTauriBrowserSnapshot(page: string, value: unknown): void {
  previousSnapshots.set(page, readSnapshot(value))
}

async function diffSnapshot(page: string, args: string[], call: BrowserCall): Promise<unknown> {
  const options = parseOptions(args)
  const current = readSnapshot(await call('browser.snapshot', snapshotPayload(args)))
  const baseline = options.baseline
    ? decodeTextCapture(
        await call('browser.captureRead', { path: options.baseline, kind: 'snapshot' })
      )
    : (previousSnapshots.get(page) ?? '')
  previousSnapshots.set(page, current)
  return buildTextDiff(baseline, current)
}

async function diffScreenshot(args: string[], call: BrowserCall): Promise<unknown> {
  const options = parseOptions(args)
  const baselinePath = options.baseline
  if (!baselinePath) {
    throw new Error('Browser screenshot diff requires --baseline <path>.')
  }
  const baseline = readCapture(
    await call('browser.captureRead', { path: baselinePath, kind: imageKind(baselinePath) })
  )
  const current = readCapture(await call('browser.screenshot'))
  const compared = await compareBrowserImages(
    baseline.dataBase64,
    current.dataBase64,
    options.threshold
  )
  if (options.output && compared.diffDataBase64) {
    const saved = await call('browser.captureSave', {
      path: options.output,
      capture: { data: compared.diffDataBase64, format: 'png' }
    })
    return { ...compared.result, diffPath: readPath(saved) }
  }
  return compared.result
}

async function diffUrls(page: string, args: string[], call: BrowserCall): Promise<unknown> {
  const firstUrl = requiredAt(args, 0, 'first diff URL')
  const secondUrl = requiredAt(args, 1, 'second diff URL')
  const options = parseOptions(args.slice(2))
  await call('browser.goto', { url: firstUrl })
  const firstSnapshot = readSnapshot(await call('browser.snapshot', snapshotPayload(args.slice(2))))
  const firstCapture = options.screenshot ? readCapture(await call('browser.screenshot')) : null
  await call('browser.goto', { url: secondUrl })
  const secondSnapshot = readSnapshot(
    await call('browser.snapshot', snapshotPayload(args.slice(2)))
  )
  previousSnapshots.set(page, secondSnapshot)
  const snapshotDiff = buildTextDiff(firstSnapshot, secondSnapshot)
  if (!firstCapture) {
    return snapshotDiff
  }
  const secondCapture = readCapture(await call('browser.screenshot'))
  const screenshotDiff = await compareBrowserImages(
    firstCapture.dataBase64,
    secondCapture.dataBase64,
    options.threshold
  )
  return { ...snapshotDiff, screenshot: screenshotDiff.result }
}

async function compareBrowserImages(
  baselineBase64: string,
  currentBase64: string,
  threshold = 0.1
): Promise<{ result: Record<string, unknown>; diffDataBase64: string | null }> {
  const [baseline, current] = await Promise.all([
    decodeImage(baselineBase64),
    decodeImage(currentBase64)
  ])
  if (baseline.width !== current.width || baseline.height !== current.height) {
    baseline.close()
    current.close()
    return {
      result: {
        match: false,
        differentPixels: null,
        totalPixels: current.width * current.height,
        mismatchPercentage: null,
        dimensionMismatch: {
          baseline: { width: baseline.width, height: baseline.height },
          current: { width: current.width, height: current.height }
        },
        diffPath: null
      },
      diffDataBase64: null
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = current.width
  canvas.height = current.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    throw new Error('Browser image diff canvas is unavailable.')
  }
  context.drawImage(baseline, 0, 0)
  const left = context.getImageData(0, 0, canvas.width, canvas.height)
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(current, 0, 0)
  const right = context.getImageData(0, 0, canvas.width, canvas.height)
  baseline.close()
  current.close()
  const output = context.createImageData(canvas.width, canvas.height)
  const differentPixels = comparePixels(left.data, right.data, output.data, threshold)
  context.putImageData(output, 0, 0)
  const totalPixels = canvas.width * canvas.height
  return {
    result: {
      match: differentPixels === 0,
      differentPixels,
      totalPixels,
      mismatchPercentage: totalPixels === 0 ? 0 : (differentPixels / totalPixels) * 100,
      dimensionMismatch: null,
      diffPath: null
    },
    diffDataBase64: canvas.toDataURL('image/png').split(',', 2)[1] ?? null
  }
}

export function comparePixels(
  baseline: Uint8ClampedArray,
  current: Uint8ClampedArray,
  output: Uint8ClampedArray,
  threshold: number
): number {
  const limit = Math.max(0, Math.min(1, threshold)) * 255
  let changed = 0
  for (let offset = 0; offset < baseline.length; offset += 4) {
    const different = [0, 1, 2, 3].some(
      (channel) =>
        Math.abs((baseline[offset + channel] ?? 0) - (current[offset + channel] ?? 0)) > limit
    )
    if (different) {
      changed += 1
    }
    output[offset] = different ? 255 : Math.round((current[offset] ?? 0) * 0.25)
    output[offset + 1] = different ? 0 : Math.round((current[offset + 1] ?? 0) * 0.25)
    output[offset + 2] = different ? 0 : Math.round((current[offset + 2] ?? 0) * 0.25)
    output[offset + 3] = 255
  }
  return changed
}

async function decodeImage(dataBase64: string): Promise<ImageBitmap> {
  const bytes = Uint8Array.from(atob(dataBase64), (character) => character.charCodeAt(0))
  return createImageBitmap(new Blob([bytes], { type: 'image/png' }))
}

function snapshotPayload(args: string[]): Record<string, unknown> {
  const options = parseOptions(args)
  return {
    ...(args.includes('-i') || args.includes('--interactive') ? { interactive: true } : {}),
    ...(args.includes('-c') || args.includes('--compact') ? { compact: true } : {}),
    ...(options.selector ? { selector: options.selector } : {})
  }
}

function parseOptions(args: string[]): {
  baseline?: string
  output?: string
  selector?: string
  threshold: number
  screenshot: boolean
} {
  const read = (...flags: string[]): string | undefined => {
    const index = args.findIndex((entry) => flags.includes(entry))
    return index < 0 ? undefined : args[index + 1]
  }
  const threshold = Number(read('-t', '--threshold') ?? 0.1)
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('Browser screenshot diff threshold must be between 0 and 1.')
  }
  return {
    baseline: read('--baseline'),
    output: read('-o', '--output'),
    selector: read('-s', '--selector'),
    threshold,
    screenshot: args.includes('--screenshot')
  }
}

function readSnapshot(value: unknown): string {
  const snapshot = readObject(value).snapshot
  if (typeof snapshot !== 'string') {
    throw new Error('Browser snapshot result is invalid.')
  }
  return snapshot
}

function readCapture(value: unknown): { dataBase64: string } {
  const input = readObject(value)
  const data = typeof input.dataBase64 === 'string' ? input.dataBase64 : input.data
  if (typeof data !== 'string' || !data) {
    throw new Error('Browser capture result is invalid.')
  }
  return { dataBase64: data }
}

function decodeTextCapture(value: unknown): string {
  const bytes = Uint8Array.from(atob(readCapture(value).dataBase64), (character) =>
    character.charCodeAt(0)
  )
  return new TextDecoder().decode(bytes)
}

function imageKind(path: string): 'png' | 'jpeg' {
  return /\.jpe?g$/i.test(path) ? 'jpeg' : 'png'
}

function readPath(value: unknown): string | null {
  return typeof readObject(value).path === 'string' ? (readObject(value).path as string) : null
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function requiredAt(values: string[], index: number, label: string): string {
  const value = values[index]
  if (!value) {
    throw new Error(`Missing browser exec ${label}.`)
  }
  return value
}
