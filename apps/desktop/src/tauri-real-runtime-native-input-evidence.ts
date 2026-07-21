import { evaluateTauriBrowserPageExpression } from '@/components/browser-pane/tauri-browser-page-webview'
import { queueTauriBrowserInteraction } from './tauri-browser-interaction-rpc'

type InputEventRecord = { label: string; type: string; trusted: boolean; key: string | null }
type FrameEvidence = { clicks: number; inputValue: string; events: InputEventRecord[] }
type FixtureEvidence = {
  events: InputEventRecord[]
  mouseClicks: number
  textValue: string
  keyValue: string
  wheelTop: number
  dropped: boolean
  checked: boolean
  selected: string
  frameState: FrameEvidence | null
}

export async function verifyMacosTrustedBrowserInput(
  browserPageId: string,
  reportStage: (stage: string) => Promise<unknown> = async () => undefined
): Promise<Record<string, unknown>> {
  await reportStage('browser-native-input-permission-check')
  const permissions = await window.api.computerUsePermissions.getStatus()
  const accessibilityStatus = permissions.permissions.find(
    (permission) => permission.id === 'accessibility'
  )?.status
  // Why: a granted helper identity cannot prove this input path is independent
  // from global Accessibility; release evidence must run with a clean TCC state.
  if (accessibilityStatus !== 'not-granted') {
    throw new Error(
      `trusted WKWebView input evidence requires Accessibility not-granted, received ${accessibilityStatus ?? 'missing'}`
    )
  }
  await waitForExpression(
    browserPageId,
    'globalThis.__pebbleNativeInputReady===true&&document.querySelector("#same-origin-frame")?.contentWindow?.__pebbleFrameInputReady===true'
  )
  await reportStage('browser-native-input-fixture-ready')

  const backend = await interact(browserPageId, 'click', { element: '#mouse-target' })
  if (backend.backend !== 'appkit-async-responder' || backend.accepted !== true) {
    throw new Error('trusted WKWebView evidence did not use the AppKit responder backend')
  }
  await waitForFixture(browserPageId, (evidence) => evidence.mouseClicks === 1)
  await reportStage('browser-native-input-mouse-verified')

  await interact(browserPageId, 'fill', { element: '#text-target', value: 'Pebble native' })
  await waitForFixture(browserPageId, (evidence) => evidence.textValue === 'Pebble native')
  await reportStage('browser-native-input-text-verified')

  await interact(browserPageId, 'click', { element: '#key-target' })
  await waitForExpression(browserPageId, 'document.activeElement?.id==="key-target"')
  await interact(browserPageId, 'keypress', { key: 'K' })
  await waitForFixture(browserPageId, (evidence) => evidence.keyValue === 'K')
  await reportStage('browser-native-input-key-verified')

  const wheelPoint = await interact(browserPageId, 'resolvePoint', { element: '#wheel-target' })
  const x = readCoordinate(wheelPoint.x, 'wheel x')
  const y = readCoordinate(wheelPoint.y, 'wheel y')
  await interact(browserPageId, 'mouseWheel', { x, y, dx: 0, dy: 120 })
  await waitForFixture(browserPageId, (evidence) => evidence.wheelTop > 0)
  await reportStage('browser-native-input-wheel-verified')

  await interact(browserPageId, 'check', { element: '#check-target', checked: true })
  await waitForFixture(browserPageId, (evidence) => evidence.checked)
  await reportStage('browser-native-input-check-verified')

  await interact(browserPageId, 'select', { element: '#select-target', value: 'beta' })
  await waitForFixture(browserPageId, (evidence) => evidence.selected === 'beta')
  await reportStage('browser-native-input-select-verified')

  const frameButton = '#same-origin-frame >>> #shadow-host >>> #frame-button'
  const frameInput = '#same-origin-frame >>> #shadow-host >>> #frame-input'
  await interact(browserPageId, 'click', { element: frameButton })
  await waitForFixture(browserPageId, (evidence) => evidence.frameState?.clicks === 1)
  await interact(browserPageId, 'fill', { element: frameInput, value: 'Frame native' })
  const evidence = await waitForFixture(
    browserPageId,
    (candidate) => candidate.frameState?.inputValue === 'Frame native'
  )
  await reportStage('browser-native-input-frame-shadow-verified')

  requireTrusted(evidence, '#mouse-target', ['mousedown', 'mouseup', 'click'])
  requireTrusted(evidence, '#text-target', ['input'])
  requireTrusted(evidence, '#key-target', ['keydown', 'keyup'])
  requireTrusted(evidence, '#wheel-target', ['wheel'])
  requireTrusted(evidence, '#check-target', ['click', 'change'])
  requireTrusted(evidence, '#select-target', ['keydown', 'keyup', 'change'])
  requireTrusted(evidence, 'frame-button', ['mousedown', 'mouseup', 'click'])
  requireTrusted(evidence, 'frame-input', ['input'])

  return {
    browserNativeMouseInput: true,
    browserTrustedMouseInput: true,
    browserTrustedKeyInput: true,
    browserTrustedTextInput: true,
    browserTrustedWheelInput: true,
    browserTrustedDragInput: false,
    browserTrustedCheckInput: true,
    browserTrustedSelectInput: true,
    browserTrustedFrameShadowInput: true,
    browserAccessibilityStatus: accessibilityStatus,
    browserTrustedInputEventCount: evidence.events.filter((event) => event.trusted).length
  }
}

export async function verifyMacosTrustedBrowserDrag(
  browserPageId: string,
  reportStage: (stage: string) => Promise<unknown> = async () => undefined
): Promise<Record<string, unknown>> {
  await reportStage('browser-native-drag-permission-check')
  const permissions = await window.api.computerUsePermissions.getStatus()
  const accessibilityStatus = permissions.permissions.find(
    (permission) => permission.id === 'accessibility'
  )?.status
  // Why: trusted HTML5 drop uses the signed helper's global input path;
  // accepting an ungranted identity would turn this into false release evidence.
  if (accessibilityStatus !== 'granted') {
    throw new Error(
      `trusted WKWebView drag evidence requires helper Accessibility granted, received ${accessibilityStatus ?? 'missing'}`
    )
  }
  await waitForExpression(browserPageId, 'globalThis.__pebbleNativeInputReady===true')
  await interact(browserPageId, 'drag', { from: '#drag-source', to: '#drop-target' })
  const evidence = await waitForFixture(browserPageId, (candidate) => candidate.dropped)
  requireTrusted(evidence, '#drag-source', ['dragstart'])
  requireTrusted(evidence, '#drop-target', ['dragenter', 'drop'])
  await reportStage('browser-native-drag-verified')
  return {
    browserNativeMouseInput: true,
    browserTrustedDragInput: true,
    browserAccessibilityStatus: accessibilityStatus,
    browserTrustedInputEventCount: evidence.events.filter((event) => event.trusted).length
  }
}

async function interact(
  page: string,
  command: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return queueTauriBrowserInteraction(command, { page, ...payload })
}

async function waitForFixture(
  browserPageId: string,
  predicate: (evidence: FixtureEvidence) => boolean
): Promise<FixtureEvidence> {
  let latest: FixtureEvidence | null = null
  // Why: a full-size child WKWebView can throttle timers in its occluded
  // parent; each native evaluation yields without depending on parent timers.
  for (let attempt = 0; attempt < 300; attempt += 1) {
    latest = await readFixture(browserPageId)
    if (predicate(latest)) {
      return latest
    }
  }
  throw new Error(`trusted WKWebView input evidence timed out: ${JSON.stringify(latest)}`)
}

async function waitForExpression(browserPageId: string, expression: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if ((await evaluateTauriBrowserPageExpression(browserPageId, expression)).result === 'true') {
      return
    }
  }
  throw new Error(`trusted WKWebView fixture expression timed out: ${expression}`)
}

async function readFixture(browserPageId: string): Promise<FixtureEvidence> {
  const response = await evaluateTauriBrowserPageExpression(
    browserPageId,
    'JSON.stringify(globalThis.__pebbleNativeInputEvidence?.()??null)'
  )
  const parsed = JSON.parse(response.result) as FixtureEvidence | null
  if (!parsed || !Array.isArray(parsed.events)) {
    throw new Error('trusted WKWebView fixture returned invalid evidence')
  }
  return parsed
}

function requireTrusted(evidence: FixtureEvidence, label: string, eventTypes: string[]): void {
  for (const type of eventTypes) {
    if (
      !evidence.events.some(
        (event) => event.label === label && event.type === type && event.trusted
      )
    ) {
      throw new Error(`trusted WKWebView evidence missing ${label} ${type}`)
    }
  }
}

function readCoordinate(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`trusted WKWebView fixture returned invalid ${label}`)
  }
  return value
}
