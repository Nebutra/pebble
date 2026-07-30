import type { RuntimeRpcResponse } from '../../../packages/product-core/shared/runtime-rpc-envelope'

export const PEBBLE_RUNTIME_ID = 'pebble-local'

export function okRuntimeRpc<TResult>(result: TResult): RuntimeRpcResponse<TResult> {
  return {
    id: crypto.randomUUID(),
    ok: true,
    result,
    _meta: { runtimeId: PEBBLE_RUNTIME_ID }
  }
}

export function failRuntimeRpc(code: string, message: string): RuntimeRpcResponse<unknown> {
  return {
    id: crypto.randomUUID(),
    ok: false,
    error: { code, message },
    _meta: { runtimeId: PEBBLE_RUNTIME_ID }
  }
}
