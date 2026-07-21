// Legacy imports converge on the single readiness coordinator. Keeping this
// file as a re-export avoids a second process/readiness state machine.
export {
  ensurePebbleRuntimeProcess,
  hasTauriInternals,
  requestRuntimeJson
} from './pebble-tauri-runtime-transport'
export type { RuntimeHttpMethod } from './pebble-tauri-runtime-transport'
