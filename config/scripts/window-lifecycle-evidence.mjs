export const DEFAULT_FIRST_FRAME_BUDGET_MS = 5_000
export const DEFAULT_RESUME_BUDGET_MS = 1_500

export function evaluateWindowLifecycleEvidence(evidence, platform, budgets = {}) {
  if (platform !== 'darwin') {
    return {
      passed: true,
      validated: false,
      reason: `${platform} lifecycle evidence requires its native release runner`
    }
  }
  const firstFrameBudgetMs = budgets.firstFrameMs ?? DEFAULT_FIRST_FRAME_BUDGET_MS
  const resumeBudgetMs = budgets.resumeMs ?? DEFAULT_RESUME_BUDGET_MS
  const failures = []
  if (!isDuration(evidence?.firstFrameMs) || evidence.firstFrameMs > firstFrameBudgetMs) {
    failures.push(`first frame must complete within ${firstFrameBudgetMs}ms`)
  }
  if (evidence?.minimizeObserved !== true || !isDuration(evidence?.minimizeMs)) {
    failures.push('native minimize transition was not observed')
  }
  if (
    evidence?.resumeObserved !== true ||
    evidence?.resumeFocused !== true ||
    !isDuration(evidence?.resumeMs) ||
    evidence.resumeMs > resumeBudgetMs
  ) {
    failures.push(`native resume and focus must complete within ${resumeBudgetMs}ms`)
  }
  const monitorCount = Number(evidence?.monitorCount)
  if (!Number.isInteger(monitorCount) || monitorCount < 1) {
    failures.push('monitor topology was not captured')
  } else if (monitorCount === 1 && evidence?.multiDisplayRestore !== 'unavailable') {
    failures.push('single-display evidence must report multi-display restore as unavailable')
  } else if (monitorCount > 1 && evidence?.multiDisplayRestore !== 'passed') {
    failures.push('multi-display runners must prove persisted restore after relaunch')
  }
  return {
    passed: failures.length === 0,
    validated: true,
    budgets: { firstFrameMs: firstFrameBudgetMs, resumeMs: resumeBudgetMs },
    evidence,
    failures
  }
}

function isDuration(value) {
  return Number.isFinite(value) && value >= 0
}
