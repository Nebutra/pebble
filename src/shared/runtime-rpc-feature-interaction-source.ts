export const PEBBLE_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY = '__pebbleFeatureInteractionSource'

export const PEBBLE_RUNTIME_RPC_BROWSER_UI_SOURCE = 'browser-pane-ui'

export function withBrowserPaneUiRuntimeRpcSource(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      [PEBBLE_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY]: PEBBLE_RUNTIME_RPC_BROWSER_UI_SOURCE
    }
  }
  return {
    ...value,
    [PEBBLE_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY]: PEBBLE_RUNTIME_RPC_BROWSER_UI_SOURCE
  }
}

export function isBrowserPaneUiRuntimeRpcParams(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)[PEBBLE_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY] ===
      PEBBLE_RUNTIME_RPC_BROWSER_UI_SOURCE
  )
}
