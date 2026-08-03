import type { TerminalTab } from '../../../../shared/types'
import { recordRendererCrashBreadcrumb } from '../../lib/crash-diagnostics'

const reportedDuplicateTabVerdicts = new Set<string>()
// Why capped: this set is never pruned and each tab id adds up to two verdict
// keys. 256 keys cover 128–256 duplicated ids, enough evidence for a bundle.
const MAX_REPORTED_DUPLICATE_TAB_VERDICTS = 256

/** Test seam: the duplicate breadcrumb is once-per-tab-id-per-verdict per session. */
export function _resetDuplicateTabOwnerBreadcrumbsForTests(): void {
  reportedDuplicateTabVerdicts.clear()
}

/**
 * Resolve which worktree owns a terminal tab, preferring the active worktree.
 *
 * Why the preference: a stale map can leave one tab id under two worktrees, and
 * attributing it to an arbitrary first match leaves `activeTabId` permanently
 * unconvergeable — which strands Terminal's active-terminal repair effect in a
 * self-retriggering loop (React #185 / Orca #11950 / Pebble #66).
 */
export function resolveActiveTabOwnerWorktreeId(
  tabsByWorktree: Record<string, TerminalTab[]>,
  activeWorktreeId: string | null,
  tabId: string
): string | null {
  let firstOwnerId: string | null = null
  let ownerCount = 0
  // Why tracked in-loop rather than re-read by key: `tabsByWorktree[activeWorktreeId]`
  // resolves inherited members for ids like `toString`, and `?.some` would then throw.
  // Why the id and not a boolean: a falsy-but-valid active id ('') would fail a
  // truthiness guard below and silently fall back to the first match — the very
  // misattribution this function exists to remove.
  let activeOwnerId: string | null = null
  // Why keys and not entries: entries allocates a pair array per worktree on a path
  // that runs per tab activation. Own keys stay safe to index by.
  for (const worktreeId of Object.keys(tabsByWorktree)) {
    const tabs = tabsByWorktree[worktreeId]
    if (!tabs?.some((tab) => tab.id === tabId)) {
      continue
    }
    ownerCount += 1
    if (firstOwnerId === null) {
      firstOwnerId = worktreeId
    }
    if (worktreeId === activeWorktreeId) {
      activeOwnerId = worktreeId
    }
  }

  const resolvedToActiveWorktree = activeOwnerId !== null
  const verdictKey = `${tabId}:${resolvedToActiveWorktree}`
  if (
    ownerCount > 1 &&
    !reportedDuplicateTabVerdicts.has(verdictKey) &&
    reportedDuplicateTabVerdicts.size < MAX_REPORTED_DUPLICATE_TAB_VERDICTS
  ) {
    reportedDuplicateTabVerdicts.add(verdictKey)
    recordRendererCrashBreadcrumb('terminal_tab_id_owned_by_multiple_worktrees', {
      ownerCount,
      resolvedToActiveWorktree
    })
  }

  if (ownerCount > 1 && activeOwnerId !== null) {
    return activeOwnerId
  }
  return firstOwnerId
}
