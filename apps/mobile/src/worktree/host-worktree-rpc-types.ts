import type { RepoIcon } from '../../../../packages/product-core/shared/repo-icon'
import type { ExecutionHostId } from '../../../../packages/product-core/shared/execution-host'

// Locally-typed subset of the desktop status payload read from status.get.
export type DesktopStatus = {
  protocolVersion?: number
  minCompatibleMobileVersion?: number
}

export type RepoSummary = {
  id: string
  displayName: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  badgeColor?: string
  repoIcon?: RepoIcon | null
}
