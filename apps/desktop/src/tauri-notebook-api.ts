import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-tauri-runtime-transport'

export function createPebbleNotebookApi(): PreloadApi['notebook'] {
  return {
    runPythonCell: async (args) => {
      const connectionId = args.connectionId?.trim()
      if (connectionId) {
        const response = await window.api.runtimeEnvironments.call({
          selector: connectionId,
          method: 'notebook.runPythonCell',
          params: {
            filePath: args.filePath,
            code: args.code,
            ...(args.preamble === undefined ? {} : { preamble: args.preamble })
          },
          timeoutMs: 65_000
        })
        if (!response.ok) {
          throw new Error(response.error.message || response.error.code)
        }
        return response.result as Awaited<ReturnType<PreloadApi['notebook']['runPythonCell']>>
      }
      await ensurePebbleRuntimeProcess()
      return requestRuntimeJson('/v1/notebook/run-python-cell', { method: 'POST', body: args })
    }
  }
}
