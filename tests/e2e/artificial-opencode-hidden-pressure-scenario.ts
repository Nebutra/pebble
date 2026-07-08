import type { Page, TestInfo } from '@nebutra/playwright-test'
import { expect } from '@nebutra/playwright-test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

type HiddenPressurePane = {
  ptyId: string
}

type HiddenPressureDeps<TMeasurement, TDebug, TScheduler, TMainPressure, TAckGate> = {
  annotateTypingMeasurement: (
    testInfo: TestInfo,
    type: string,
    paneCount: number,
    measurement: TMeasurement,
    debug: TDebug | null,
    scheduler: TScheduler | null,
    mainPressure: TMainPressure | null,
    ackGate: TAckGate | null
  ) => void
  ensureActiveWorktreePaneLoad: (page: Page, paneCount: number) => Promise<HiddenPressurePane[]>
  holdTerminalAckGate: (page: Page, ptyIds: string[]) => Promise<void>
  measureTypingDuringLoad: (
    page: Page,
    scriptPath: string,
    ptyId: string,
    runId: string
  ) => Promise<TMeasurement>
  readMainPtyPressureDebug: (page: Page) => Promise<TMainPressure | null>
  readTerminalAckGateDebug: (page: Page) => Promise<TAckGate | null>
  readTerminalOutputSchedulerDebug: (page: Page) => Promise<TScheduler | null>
  readTerminalPtyOutputDebug: (page: Page) => Promise<TDebug | null>
  releaseTerminalAckGate: (page: Page) => Promise<void>
  resetTerminalPtyOutputDebug: (page: Page) => Promise<void>
  waitForMainPtyPressureBacklog: (page: Page) => Promise<TMainPressure>
  writeInteractivePromptScript: (scriptPath: string, runId: string) => void
}

type HiddenPressureDebug = {
  hiddenRendererSkipCount: number
  hiddenRendererSkippedChars: number
}

type HiddenPressureMeasurement = {
  medianLatencyMs: number
  worstLatencyMs: number
  maxTimerDriftMs: number
}

type HiddenPressureMainSnapshot = {
  peakPendingChars: number
  peakRendererInFlightChars: number
  ackGatedFlushSkipCount: number
}

type HiddenPressureAckGate = {
  heldAckChars: number
}

// Why: this is a throughput/drain metric — the time to switch back and replay the
// full 8MB+ held backlog into xterm, measured through repeated (expensive) terminal
// serialization polls. The real responsiveness guards are the typing-latency
// asserts above (median/worst), which hold. Under 8MB of in-flight backpressure on
// a loaded OSS runner the drain-plus-poll overhead was seen at ~3.2s, so keep a
// ceiling with headroom that still catches an order-of-magnitude regression.
const MAX_HIDDEN_RESTORE_LATENCY_MS = 4_000

export function pressureOutputScript(runId: string): string {
  return `
const paneIndex = process.argv[2] ?? '0'
const targetChars = Number(process.argv[3] ?? '0')
const delayMs = Number(process.argv[4] ?? '0')
const header = 'OPENCODE_PRESSURE_START_${runId}_' + paneIndex + '\\n'
const chunkBody = '#'.repeat(8192)
let written = 0
process.stdout.write(header)
function writeMore() {
  let canContinue = true
  while (canContinue && written < targetChars) {
    const frame = String(written).padStart(8, '0')
    const chunk = '\\x1b[?2026h\\x1b[1;1Hpressure pane=' + paneIndex + ' frame=' + frame + ' ' + chunkBody + '\\x1b[?2026l\\n'
    written += chunk.length
    canContinue = process.stdout.write(chunk)
  }
  if (written < targetChars) {
    process.stdout.once('drain', writeMore)
    return
  }
  process.stdout.write('OPENCODE_PRESSURE_DONE_${runId}_' + paneIndex + '\\n')
}
setTimeout(writeMore, Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0)
`
}

export function writePressureOutputScript(scriptPath: string, runId: string): void {
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  writeFileSync(scriptPath, pressureOutputScript(runId))
}

export async function runHiddenRealPtyPressureScenario<
  TMeasurement extends HiddenPressureMeasurement,
  TDebug extends HiddenPressureDebug,
  TMainPressure extends HiddenPressureMainSnapshot,
  TAckGate extends HiddenPressureAckGate,
  TScheduler
>({
  deps,
  annotationSuffix,
  hiddenPaneCount,
  pressureOutputChars,
  pressureStartDelayMs,
  testInfo,
  testRepoPath,
  pebblePage
}: {
  deps: HiddenPressureDeps<TMeasurement, TDebug, TScheduler, TMainPressure, TAckGate>
  annotationSuffix?: string
  hiddenPaneCount: number
  pressureOutputChars: number
  pressureStartDelayMs: number
  testInfo: TestInfo
  testRepoPath: string
  pebblePage: Page
}): Promise<void> {
  await waitForSessionReady(pebblePage)
  const firstWorktreeId = await waitForActiveWorktree(pebblePage)
  const allWorktreeIds = await getAllWorktreeIds(pebblePage)
  const secondWorktreeId = allWorktreeIds.find((id) => id !== firstWorktreeId)
  expect(Boolean(secondWorktreeId), 'OpenCode hidden PTY pressure needs a second worktree').toBe(
    true
  )
  if (!secondWorktreeId) {
    return
  }

  await switchToWorktree(pebblePage, secondWorktreeId)
  const hiddenPanes = await deps.ensureActiveWorktreePaneLoad(pebblePage, hiddenPaneCount)

  const runId = randomUUID()
  const typingScriptPath = path.join(
    testRepoPath,
    `.pebble-opencode-hidden-pressure-typing-${runId}.mjs`
  )
  const pressureScriptPath = path.join(
    testRepoPath,
    `.pebble-opencode-hidden-pressure-load-${runId}.mjs`
  )
  deps.writeInteractivePromptScript(typingScriptPath, runId)
  writePressureOutputScript(pressureScriptPath, runId)

  await deps.resetTerminalPtyOutputDebug(pebblePage)
  await deps.holdTerminalAckGate(
    pebblePage,
    hiddenPanes.map((pane) => pane.ptyId)
  )
  try {
    await startHiddenPressureCommands({
      hiddenPanes,
      pebblePage,
      pressureOutputChars,
      pressureScriptPath,
      pressureStartDelayMs
    })
    await switchToTypingWorkspace(pebblePage, firstWorktreeId)
    const typingPtyId = await waitForActivePanePtyId(pebblePage)

    const pressureBeforeTyping = await deps.waitForMainPtyPressureBacklog(pebblePage)
    const measurement = await deps.measureTypingDuringLoad(
      pebblePage,
      typingScriptPath,
      typingPtyId,
      runId
    )
    const debug = await deps.readTerminalPtyOutputDebug(pebblePage)
    const mainPressure = await deps.readMainPtyPressureDebug(pebblePage)
    const ackGate = await deps.readTerminalAckGateDebug(pebblePage)
    deps.annotateTypingMeasurement(
      testInfo,
      `opencode-hidden-real-pty-pressure-typing${annotationSuffix ?? ''}`,
      hiddenPanes.length + 1,
      measurement,
      debug,
      await deps.readTerminalOutputSchedulerDebug(pebblePage),
      mainPressure,
      ackGate
    )

    expect(debug?.hiddenRendererSkipCount ?? 0).toBe(0)
    expect(debug?.hiddenRendererSkippedChars ?? 0).toBe(0)
    expect(pressureBeforeTyping.peakPendingChars).toBeGreaterThan(0)
    expect(pressureBeforeTyping.ackGatedFlushSkipCount).toBeGreaterThan(0)
    expect(mainPressure?.peakRendererInFlightChars ?? 0).toBeGreaterThanOrEqual(8 * 1024 * 1024)
    expect(ackGate?.heldAckChars ?? 0).toBeGreaterThan(0)
    // Why: median is the robust responsiveness guard — it proves typing stays
    // instant even while hidden PTYs replay 8MB+ of ACK-backpressured output.
    expect(measurement.medianLatencyMs).toBeLessThan(75)
    // Why: worst *single-key echo* under 8MB synthetic backpressure lands behind
    // whichever flush it collides with, so on a contended OSS shard it is
    // environment-dominated (seen at ~2s). Keep it only as a catastrophic-hang
    // detector — the original regression (input freezing for seconds) shows up in
    // the median too. Aligns with ssh-docker-relay-perf's 2s worst-key tolerance.
    expect(measurement.worstLatencyMs).toBeLessThan(3_000)
    // Why: maxTimerDriftMs is a single-worst-tick metric that spikes on a loaded
    // OSS runner (seen at 155ms under 8MB of in-flight backpressure). Median above
    // is the real responsiveness guard; align the spike tolerance with the sibling
    // terminal-load suite's MAX_TIMER_DRIFT_MS.
    expect(measurement.maxTimerDriftMs).toBeLessThan(250)

    await deps.releaseTerminalAckGate(pebblePage)
    const restoreLatencyMs = await measureHiddenOutputRestoreLatency(
      pebblePage,
      secondWorktreeId,
      runId
    )
    testInfo.annotations.push({
      type: `opencode-hidden-real-pty-restore${annotationSuffix ?? ''}`,
      description: `panes=${hiddenPanes.length + 1} restore=${restoreLatencyMs.toFixed(
        1
      )}ms hiddenSkippedChars=${debug?.hiddenRendererSkippedChars ?? 0} mainPeakInFlightChars=${
        mainPressure?.peakRendererInFlightChars ?? 0
      } heldAckChars=${ackGate?.heldAckChars ?? 0}`
    })
    expect(restoreLatencyMs).toBeLessThan(MAX_HIDDEN_RESTORE_LATENCY_MS)
  } finally {
    await cleanupHiddenPressureScenario({
      deps,
      firstWorktreeId,
      hiddenPanes,
      pebblePage,
      pressureScriptPath,
      secondWorktreeId,
      typingScriptPath
    })
  }
}

async function measureHiddenOutputRestoreLatency(
  pebblePage: Page,
  worktreeId: string,
  runId: string
): Promise<number> {
  const restoreStart = performance.now()
  await switchToWorktree(pebblePage, worktreeId)
  await expect
    .poll(() => getTerminalContent(pebblePage, 20_000), {
      timeout: 20_000,
      message: 'Hidden PTY output was not restored from main buffer on return'
    })
    .toContain(`OPENCODE_PRESSURE_DONE_${runId}_`)
  return performance.now() - restoreStart
}

async function startHiddenPressureCommands({
  hiddenPanes,
  pebblePage,
  pressureOutputChars,
  pressureScriptPath,
  pressureStartDelayMs
}: {
  hiddenPanes: HiddenPressurePane[]
  pebblePage: Page
  pressureOutputChars: number
  pressureScriptPath: string
  pressureStartDelayMs: number
}): Promise<void> {
  await Promise.all(
    hiddenPanes.map((pane, paneIndex) =>
      sendToTerminal(
        pebblePage,
        pane.ptyId,
        `node ${JSON.stringify(pressureScriptPath)} ${paneIndex} ${pressureOutputChars} ${pressureStartDelayMs}\r`
      )
    )
  )
}

async function switchToTypingWorkspace(pebblePage: Page, worktreeId: string): Promise<void> {
  await switchToWorktree(pebblePage, worktreeId)
  await expect.poll(() => getActiveWorktreeId(pebblePage), { timeout: 10_000 }).toBe(worktreeId)
  await ensureTerminalVisible(pebblePage)
  await waitForActiveTerminalManager(pebblePage, 30_000)
}

async function cleanupHiddenPressureScenario<
  TMeasurement,
  TDebug,
  TScheduler,
  TMainPressure,
  TAckGate
>({
  deps,
  firstWorktreeId,
  hiddenPanes,
  pebblePage,
  pressureScriptPath,
  secondWorktreeId,
  typingScriptPath
}: {
  deps: HiddenPressureDeps<TMeasurement, TDebug, TScheduler, TMainPressure, TAckGate>
  firstWorktreeId: string
  hiddenPanes: HiddenPressurePane[]
  pebblePage: Page
  pressureScriptPath: string
  secondWorktreeId: string
  typingScriptPath: string
}): Promise<void> {
  await deps.releaseTerminalAckGate(pebblePage)
  await switchToWorktree(pebblePage, firstWorktreeId).catch(() => undefined)
  await waitForActivePanePtyId(pebblePage)
    .then((ptyId) => sendToTerminal(pebblePage, ptyId, '\x03'))
    .catch(() => undefined)
  await switchToWorktree(pebblePage, secondWorktreeId).catch(() => undefined)
  await Promise.all(
    hiddenPanes.map((pane) => sendToTerminal(pebblePage, pane.ptyId, '\x03').catch(() => undefined))
  )
  rmSync(typingScriptPath, { force: true })
  rmSync(pressureScriptPath, { force: true })
}
