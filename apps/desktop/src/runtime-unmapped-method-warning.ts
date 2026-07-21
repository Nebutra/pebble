import { PRODUCT_NAME } from './product-brand'

// Why: the local dispatcher only maps the subset of runtime methods with a
// native Tauri backing; warn once per unmapped method so renderer drift surfaces
// in devtools instead of silently dead-ending at the catch-all.
const warnedUnmappedRuntimeMethods = new Set<string>()

export function warnUnmappedRuntimeMethod(method: string): void {
  if (warnedUnmappedRuntimeMethods.has(method)) {
    return
  }
  warnedUnmappedRuntimeMethods.add(method)
  console.warn(`${PRODUCT_NAME} runtime method is not mapped: ${method}`)
}
