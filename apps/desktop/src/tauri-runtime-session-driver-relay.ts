import type { RuntimeTerminalDriverState } from '../../../packages/product-core/shared/runtime-types'

// Why: runtime session.driver events arrive in the PTY push bridge, but the
// terminal driver map (and its renderer listeners) lives in
// pebble-tauri-runtime-control-api. A registration seam keeps the two modules
// decoupled instead of adding a control-api -> pty-events import cycle.

type RuntimeSessionDriverConsumer = (sessionId: string, driver: RuntimeTerminalDriverState) => void

let consumer: RuntimeSessionDriverConsumer | null = null

export function registerRuntimeSessionDriverConsumer(next: RuntimeSessionDriverConsumer): void {
  consumer = next
}

export function deliverRuntimeSessionDriver(
  sessionId: string,
  driver: RuntimeTerminalDriverState
): void {
  consumer?.(sessionId, driver)
}
