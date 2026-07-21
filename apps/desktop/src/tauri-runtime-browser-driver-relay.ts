import type { RuntimeBrowserDriverState } from '../../../packages/product-core/shared/runtime-types'

type RuntimeBrowserDriverConsumer = (
  browserPageId: string,
  driver: RuntimeBrowserDriverState
) => void

let consumer: RuntimeBrowserDriverConsumer | null = null

export function registerRuntimeBrowserDriverConsumer(next: RuntimeBrowserDriverConsumer): void {
  consumer = next
}

export function deliverRuntimeBrowserDriver(
  browserPageId: string,
  driver: RuntimeBrowserDriverState
): void {
  consumer?.(browserPageId, driver)
}
