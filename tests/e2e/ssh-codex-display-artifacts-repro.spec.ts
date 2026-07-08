import type { TestInfo } from '@nebutra/playwright-test'
import { test, expect } from './helpers/pebble-app'
import {
  ensureTerminalVisible,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  REMOTE_CODEX_FIXTURE_CLEAN_FINAL_TEXT,
  REMOTE_TUI_DONE,
  installRemoteCodexArtifactTui,
  installRemoteCodexFixture,
  shellQuote
} from './ssh-codex-repro-remote-fixtures'
import {
  connectDockerRemote,
  dropDockerSshClientSessions,
  enableRiskyTerminalRendererPath,
  installPtyReplayProbe,
  readDuplicateStatusRows,
  readReplayProbeSnapshot,
  switchToNonRemoteWorktree,
  waitForDockerRemoteReconnected
} from './ssh-codex-reconnect-replay-driver'
import { installRemoteRealCodex, realRemoteCodexCommand } from './ssh-codex-real-remote'
import {
  clearRemoteTerminalAfterCodex,
  scrollActiveTerminalToArtifactHistory,
  stressRestoreRemoteTerminalDuringCodex,
  waitForRealRemoteCodexCompletion,
  waitForRemoteFixtureCleanFinalInHiddenPane
} from './ssh-codex-terminal-observers'
import { MAX_FINAL_GRAY_SLABS, captureGraySlabAnalysis } from './terminal-raster-artifact-analysis'
import { persistReproEvidence } from './terminal-repro-evidence'
import { resetWebglAndCaptureGraySlabAnalysis } from './terminal-webgl-reset-capture'

const RUN_DOCKER_SSH = process.env.PEBBLE_E2E_SSH_DOCKER === '1'
const RUN_REAL_REMOTE_CODEX = process.env.PEBBLE_E2E_REAL_REMOTE_CODEX === '1'
const EXPECT_NO_ARTIFACTS = process.env.PEBBLE_E2E_EXPECT_NO_CODEX_ARTIFACTS === '1'
const CAPTURE_WHILE_REMOTE_TUI_RUNNING =
  process.env.PEBBLE_E2E_CAPTURE_WHILE_REMOTE_TUI_RUNNING === '1'
const HIDE_UNTIL_REMOTE_TUI_DONE = process.env.PEBBLE_E2E_HIDE_UNTIL_REMOTE_TUI_DONE === '1'
const CAPTURE_SCROLLBACK_ARTIFACT_REGION =
  process.env.PEBBLE_E2E_CAPTURE_SCROLLBACK_ARTIFACT_REGION === '1'
const FORCE_SSH_RECONNECT_DURING_TUI = process.env.PEBBLE_E2E_FORCE_SSH_RECONNECT_DURING_TUI === '1'
const KEEP_SSH_REPRO_TARGET = process.env.PEBBLE_E2E_KEEP_SSH_REPRO_TARGET === '1'

test.describe('Remote SSH Codex display artifacts repro', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set PEBBLE_E2E_SSH_DOCKER=1 to run Docker-backed SSH repro.')
  test.skip(process.platform === 'win32', 'Docker SSH repro uses POSIX ssh tooling.')

  test('does not leave duplicated Codex status output after SSH replay', async ({
    pebblePage
  }, testInfo: TestInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      installRemoteCodexArtifactTui(target)
      if (RUN_REAL_REMOTE_CODEX) {
        installRemoteRealCodex(target)
      } else {
        installRemoteCodexFixture(target)
      }
      await waitForSessionReady(pebblePage)
      await waitForActiveWorktree(pebblePage)
      const remote = await connectDockerRemote(pebblePage, target)
      expect(remote.targetId).toBeTruthy()
      expect(remote.worktreeId).toBeTruthy()
      await ensureTerminalVisible(pebblePage, 45_000)
      await waitForActiveTerminalManager(pebblePage, 60_000)
      await enableRiskyTerminalRendererPath(pebblePage)
      await installPtyReplayProbe(pebblePage)

      const ptyId = await waitForActivePanePtyId(pebblePage, 60_000)
      const doneMarker = RUN_REAL_REMOTE_CODEX
        ? `PEBBLE_REAL_REMOTE_CODEX_DONE_${Date.now()}`
        : REMOTE_TUI_DONE
      const cleanMarker = RUN_REAL_REMOTE_CODEX
        ? `PEBBLE_REAL_REMOTE_CODEX_CLEAN_${Date.now()}`
        : doneMarker
      await execInTerminal(
        pebblePage,
        ptyId,
        RUN_REAL_REMOTE_CODEX
          ? realRemoteCodexCommand(doneMarker)
          : `codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox ${shellQuote(
              doneMarker
            )}`
      )
      await pebblePage.waitForTimeout(1_200)
      if (FORCE_SSH_RECONNECT_DURING_TUI) {
        dropDockerSshClientSessions(target)
        await waitForDockerRemoteReconnected(pebblePage, remote.targetId)
        await pebblePage.waitForTimeout(2_000)
      }
      await (RUN_REAL_REMOTE_CODEX
        ? (async () => {
            await stressRestoreRemoteTerminalDuringCodex(pebblePage, remote.worktreeId)
            await waitForRealRemoteCodexCompletion(pebblePage, doneMarker)
          })()
        : (async () => {
            if (CAPTURE_WHILE_REMOTE_TUI_RUNNING) {
              await pebblePage.waitForTimeout(10_000)
            } else {
              await switchToNonRemoteWorktree(pebblePage, remote.worktreeId)
              await (HIDE_UNTIL_REMOTE_TUI_DONE
                ? waitForRemoteFixtureCleanFinalInHiddenPane(pebblePage, remote.worktreeId)
                : pebblePage.waitForTimeout(10_000))
            }
            if (CAPTURE_WHILE_REMOTE_TUI_RUNNING) {
              await pebblePage.waitForTimeout(900)
              return
            }
            await switchToWorktree(pebblePage, remote.worktreeId)
            await ensureTerminalVisible(pebblePage, 45_000)
            await waitForActiveTerminalManager(pebblePage, 60_000)
            await waitForTerminalOutput(
              pebblePage,
              REMOTE_CODEX_FIXTURE_CLEAN_FINAL_TEXT,
              60_000,
              120_000
            )
          })())
      await pebblePage.waitForTimeout(600)
      if (CAPTURE_SCROLLBACK_ARTIFACT_REGION) {
        await scrollActiveTerminalToArtifactHistory(pebblePage)
      }

      const { analysis, screenshot } = await captureGraySlabAnalysis(pebblePage)
      analysis.replayDebug = await readReplayProbeSnapshot(pebblePage)
      analysis.duplicateStatusRows = await readDuplicateStatusRows(pebblePage)
      const evidenceLabel = RUN_REAL_REMOTE_CODEX
        ? 'real-remote-codex-reconnect-replay'
        : 'fixture-codex-reconnect-replay'
      persistReproEvidence(evidenceLabel, analysis, screenshot)
      const resetEvidence = await resetWebglAndCaptureGraySlabAnalysis(pebblePage)
      resetEvidence.analysis.replayDebug = await readReplayProbeSnapshot(pebblePage)
      resetEvidence.analysis.duplicateStatusRows = await readDuplicateStatusRows(pebblePage)
      persistReproEvidence(
        `${evidenceLabel}-after-webgl-reset`,
        resetEvidence.analysis,
        resetEvidence.screenshot
      )
      await testInfo.attach('remote-codex-artifact-final-screen', {
        body: screenshot,
        contentType: 'image/png'
      })
      await testInfo.attach('remote-codex-artifact-after-webgl-reset', {
        body: resetEvidence.screenshot,
        contentType: 'image/png'
      })
      testInfo.annotations.push({
        type: 'remote-codex-artifact-analysis',
        description: JSON.stringify(analysis)
      })
      testInfo.annotations.push({
        type: 'remote-codex-artifact-after-webgl-reset-analysis',
        description: JSON.stringify(resetEvidence.analysis)
      })

      // Why: this spec supports both repro mode and strict regression mode so
      // the same harness can prove a failure and lock the fixed behavior.
      if (EXPECT_NO_ARTIFACTS) {
        expect(analysis.slabCount).toBeLessThanOrEqual(MAX_FINAL_GRAY_SLABS)
        expect(analysis.staleStatusGlyphRowCount).toBe(0)
        expect(analysis.duplicateStatusRows ?? []).toEqual([])
      } else {
        expect(analysis.rawSlabCount + analysis.staleStatusGlyphRowCount).toBeGreaterThan(0)
      }
      if (FORCE_SSH_RECONNECT_DURING_TUI) {
        expect(Number(analysis.replayDebug?.replayCount ?? 0)).toBeGreaterThan(0)
      }
      if (RUN_REAL_REMOTE_CODEX) {
        await clearRemoteTerminalAfterCodex(pebblePage, ptyId, cleanMarker)
      }
    } finally {
      if (KEEP_SSH_REPRO_TARGET && target) {
        console.log(
          `[ssh-codex-repro] keeping Docker SSH target ${target.containerName} on port ${target.port}`
        )
      } else {
        cleanupDockerSshRelayTarget(target)
      }
    }
  })
})
