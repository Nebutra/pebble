import type { FeatureInteractionId } from '../../../packages/product-core/shared/feature-interactions'
import { isBrowserPaneUiRuntimeRpcParams } from '../../../packages/product-core/shared/runtime-rpc-feature-interaction-source'

export function runtimeFeatureInteractionId(
  method: string,
  params?: unknown
): FeatureInteractionId | null {
  if (method === 'browser.screencast.unsubscribe') {
    return null
  }
  if (method.startsWith('browser.') && isBrowserPaneUiRuntimeRpcParams(params)) {
    return null
  }
  if (method.startsWith('browser.') && !method.startsWith('browser.profile')) {
    return 'agent-browser-use'
  }
  if (method === 'computer.permissions') {
    return 'computer-use-setup'
  }
  if (
    method.startsWith('computer.') &&
    method !== 'computer.capabilities' &&
    method !== 'computer.permissionsStatus'
  ) {
    return 'computer-use'
  }
  if (method.startsWith('orchestration.')) {
    return 'agent-orchestration'
  }
  return null
}
