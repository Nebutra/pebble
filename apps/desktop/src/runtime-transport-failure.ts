import type { RuntimeResourceGetResult } from './runtime-command-shapes'

// Why: an http-error carries the runtime's own explanation in its body. Four
// call sites used to drop it and report only the transport name, so a runtime
// answering `{"error":"missing or invalid bearer token"}` surfaced as
// "Runtime transport failed: http-error" — the one message that says nothing.

export function readRuntimeHttpErrorMessage(body: string | null, status: number | null): string {
  if (body) {
    try {
      const payload = JSON.parse(body) as { error?: unknown }
      if (typeof payload.error === 'string' && payload.error.trim()) {
        return payload.error
      }
    } catch {
      return body
    }
    return body
  }
  return status === null ? 'Runtime request failed.' : `Runtime request failed with HTTP ${status}`
}

/** Builds the most specific error a non-connected transport result can justify. */
export function runtimeTransportFailure(result: RuntimeResourceGetResult): Error {
  if (result.transport === 'http-error') {
    return new Error(readRuntimeHttpErrorMessage(result.body, result.httpStatus))
  }
  return new Error(result.error ?? `Runtime transport failed: ${result.transport}`)
}
