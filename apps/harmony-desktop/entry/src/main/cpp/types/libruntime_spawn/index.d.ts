/**
 * In-process gateway stub for HarmonyOS HAP Phase 0.
 * Optional staticRoot serves staged product-core web assets.
 */
export const startInProcess: (
  listen: string,
  dataDir: string,
  token: string,
  staticRoot?: string
) => number
export const stopInProcess: () => boolean
export const isInProcessRunning: () => boolean
export const nativeLibDir: () => string
