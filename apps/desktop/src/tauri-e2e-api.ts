import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { createE2EConfig } from '../../../packages/product-core/shared/e2e-config'

type TauriE2EBuildEnv = {
  MODE?: string
  VITE_EXPOSE_STORE?: boolean | string
}

export function createTauriE2EApi(env: TauriE2EBuildEnv): PreloadApi['e2e'] | undefined {
  const exposeStore = env.MODE === 'e2e' || String(env.VITE_EXPOSE_STORE) === 'true'
  if (!exposeStore) {
    return undefined
  }

  return {
    getConfig: () => createE2EConfig({ exposeStore: true })
  }
}

export function installTauriE2EApi(api: PreloadApi, env: TauriE2EBuildEnv): void {
  const e2eApi = createTauriE2EApi(env)
  if (e2eApi) {
    api.e2e = e2eApi
    return
  }

  // Why: test controls must not remain callable in distributable Tauri builds.
  delete (api as Partial<PreloadApi>).e2e
}
