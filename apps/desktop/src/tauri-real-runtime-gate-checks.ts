import { useAppStore } from '@/store'
import { gitLabPipelineJobsToPRChecks } from '../../../packages/product-core/shared/gitlab-pipeline-checks'
import {
  type GateConfig,
  captureGateSurface,
  runtimeTailContains,
  waitFor,
  writeProgress
} from './tauri-real-runtime-gate-evidence'

export async function verifyNativeChatTranscript(): Promise<Record<string, unknown>> {
  const result = await window.api.nativeChat.readSession('codex', 'functional-native-chat', 40)
  if (
    'error' in result ||
    !result.messages.some((message) =>
      message.blocks.some(
        (block) => block.type === 'text' && block.text === 'PEBBLE_NATIVE_CHAT_TRANSCRIPT'
      )
    )
  ) {
    throw new Error('native chat transcript did not survive the Rust reader and shared decoder')
  }
  return { nativeChatTranscriptRead: true }
}

export async function verifyProviderBackedChecks(
  config: GateConfig,
  repoId: string,
  worktreeId: string,
  repoPath: string,
  ptyId: string
): Promise<Record<string, unknown>> {
  const terminalTab = useAppStore
    .getState()
    .tabsByWorktree[worktreeId]?.find((candidate) => candidate.ptyId === ptyId)
  if (!terminalTab) {
    throw new Error('checks gate lost its terminal context')
  }
  // Why: native-browser verification activates its browser tab; Checks follows
  // the active terminal cwd and must be exercised from that user context.
  useAppStore.getState().setActiveTab(terminalTab.id)
  useAppStore.getState().setActiveTabType('terminal')
  const expectedNames = ['Pebble Linux', 'Pebble Windows', 'Pebble macOS']
  const parsed = await window.api.gh.prChecks({ repoId, repoPath, prNumber: 128 })
  if (
    parsed.length !== expectedNames.length ||
    !expectedNames.every((name) => parsed.some((check) => check.name === name))
  ) {
    throw new Error('provider checks did not survive the native Go parser')
  }
  await writeProgress('checks-github-parsed')

  const state = useAppStore.getState()
  // Why: this gate validates provider rendering, not network ref discovery;
  // pin the fixture's known head so an unrelated fetch cannot mask UI parity.
  setGateHostedReviewMeta(repoId, worktreeId, { linkedPR: 128, linkedGitLabMR: null })
  await waitFor(
    () =>
      useAppStore
        .getState()
        .worktreesByRepo[repoId]?.find((candidate) => candidate.id === worktreeId)?.linkedPR === 128
  )
  await writeProgress('checks-metadata-linked')
  const nativeReview = await window.api.gh.prForBranch({
    repoId,
    repoPath,
    branch: 'main',
    linkedPRNumber: 128
  })
  if (nativeReview?.number !== 128) {
    throw new Error('native provider review did not resolve')
  }
  await writeProgress('checks-native-review-resolved')
  const hostedReview = await window.api.hostedReview.forBranch({
    repoId,
    repoPath,
    branch: 'main',
    linkedGitHubPR: 128
  })
  if (hostedReview?.number !== 128 || hostedReview.provider !== 'github') {
    throw new Error('native hosted-review namespace did not resolve')
  }
  await writeProgress('checks-hosted-review-resolved')
  const review = await useAppStore.getState().fetchPRForBranch(repoPath, 'main', {
    repoId,
    worktreeId,
    linkedPRNumber: 128,
    force: true
  })
  if (review?.number !== 128) {
    throw new Error('provider review context did not resolve')
  }
  await writeProgress('checks-store-review-resolved')
  const storeChecks = await useAppStore
    .getState()
    .fetchPRChecks(repoPath, 128, 'main', review.headSha, review.prRepo, {
      repoId,
      force: true
    })
  if (
    storeChecks.length !== expectedNames.length ||
    !expectedNames.every((name) => storeChecks.some((check) => check.name === name))
  ) {
    throw new Error('provider checks did not survive the product store cache path')
  }
  await writeProgress('checks-store-cache-filled')
  useAppStore.getState().setRightSidebarTab('checks')
  useAppStore.getState().setRightSidebarOpen(true)
  await waitFor(() => document.querySelector('[data-testid="checks-panel"]') !== null)
  await waitFor(() => document.body.textContent?.includes('Pebble Linux'))
  await writeProgress('checks-github-panel-mounted')
  const checksCaptureBytes = await captureGateSurface(config, 'checks')

  const gitLabMarker = `PEBBLE_GITLAB_CHECKS_${crypto.randomUUID()}`
  const gitLabMarkerAccepted = await window.api.pty.writeAccepted(ptyId, `echo ${gitLabMarker}\r`)
  if (!gitLabMarkerAccepted) {
    throw new Error('native PTY input queue rejected GitLab marker')
  }
  await waitFor(() => runtimeTailContains(ptyId, gitLabMarker))
  await writeProgress('checks-gitlab-marker-ready')
  setGateHostedReviewMeta(repoId, worktreeId, { linkedPR: null, linkedGitLabMR: 9 })
  useAppStore.setState({ hostedReviewCache: {}, prCache: {} })
  await waitFor(
    () =>
      useAppStore
        .getState()
        .worktreesByRepo[repoId]?.find((candidate) => candidate.id === worktreeId)
        ?.linkedGitLabMR === 9
  )
  const gitLabReview = await state.fetchHostedReviewForBranch(repoPath, 'main', {
    repoId,
    force: true,
    linkedGitHubPR: null,
    linkedGitLabMR: 9
  })
  if (gitLabReview?.provider !== 'gitlab' || gitLabReview.number !== 9) {
    throw new Error('native GitLab hosted review did not resolve')
  }
  await writeProgress('checks-gitlab-review-resolved')
  const gitLabNames = [
    'verify: Pebble GitLab Linux',
    'verify: Pebble GitLab Windows',
    'verify: Pebble GitLab macOS'
  ]
  const gitLabDetails = await window.api.gl.workItemDetails({
    repoPath,
    repoId,
    iid: gitLabReview.number,
    type: 'mr'
  })
  const gitLabChecks = gitLabPipelineJobsToPRChecks(gitLabDetails?.pipelineJobs ?? [])
  if (
    gitLabChecks.length !== gitLabNames.length ||
    !gitLabNames.every((name) => gitLabChecks.some((check) => check.name === name))
  ) {
    throw new Error('GitLab checks did not survive the product store cache path')
  }
  await waitFor(() => document.querySelector('[data-testid="checks-panel"]') !== null)
  await writeProgress('checks-gitlab-panel-mounted')
  return {
    checksProviderParsed: true,
    checksPanelMounted: true,
    hostedReviewNative: true,
    checksCount: parsed.length,
    gitLabChecksPanelMounted: true,
    gitLabChecksCount: gitLabNames.length,
    checksCaptureBytes
  }
}

function setGateHostedReviewMeta(
  repoId: string,
  worktreeId: string,
  links: { linkedPR: number | null; linkedGitLabMR: number | null }
): void {
  // Why: this gate validates provider rendering; fixture setup must not wait
  // for metadata persistence or remote push-target discovery.
  useAppStore.setState((current) => ({
    worktreesByRepo: {
      ...current.worktreesByRepo,
      [repoId]: (current.worktreesByRepo[repoId] ?? []).map((worktree) =>
        worktree.id === worktreeId
          ? {
              ...worktree,
              ...links,
              pushTarget: { remoteName: 'origin', branchName: 'main' }
            }
          : worktree
      )
    }
  }))
}
