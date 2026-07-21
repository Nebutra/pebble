import {
  ClientUiUpdateSchema,
  FeatureInteractionIdSchema
} from '../../../packages/product-core/shared/client-ui-rpc-schema'
import { getDefaultUIState } from '../../../packages/product-core/shared/constants'
import type { PersistedUIState } from '../../../packages/product-core/shared/types'
import {
  readPersistentSettingsRaw,
  writePersistentSettingsRaw
} from '@/web/persistent-settings-backend'

const UI_STORAGE_KEY = 'pebble.web.ui.v1'

type RuntimeUiRpcResult = { handled: boolean; result?: unknown }

export async function callTauriUiRuntimeRpc(
  method: string,
  params: unknown
): Promise<RuntimeUiRpcResult> {
  if (method === 'ui.get') {
    return handled({ ui: readUiState() })
  }
  if (method === 'ui.set') {
    // Why: the shared strict schema is the runtime trust boundary; its output
    // contains legacy opaque records that Zod cannot infer as domain subtypes.
    const updates = ClientUiUpdateSchema.parse(params) as Partial<PersistedUIState>
    return handled({ ui: writeUiState({ ...readUiState(), ...updates }) })
  }
  if (method === 'ui.recordFeatureInteraction') {
    const id = FeatureInteractionIdSchema.parse(params)
    const current = readUiState()
    const previous = current.featureInteractions?.[id]
    const featureInteractions = {
      ...current.featureInteractions,
      [id]: {
        firstInteractedAt: previous?.firstInteractedAt ?? Date.now(),
        interactionCount: (previous?.interactionCount ?? 0) + 1
      }
    }
    return handled({ ui: writeUiState({ ...current, featureInteractions }) })
  }
  return { handled: false }
}

function readUiState(): PersistedUIState {
  const defaults = getDefaultUIState()
  const raw = readPersistentSettingsRaw(UI_STORAGE_KEY)
  if (!raw) {
    return defaults
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return defaults
    }
    // Why: old app versions can leave retired keys in the persisted document;
    // reads preserve them while every remote mutation is strict-schema parsed.
    return { ...defaults, ...parsed } as PersistedUIState
  } catch {
    return defaults
  }
}

function writeUiState(ui: PersistedUIState): PersistedUIState {
  writePersistentSettingsRaw(UI_STORAGE_KEY, JSON.stringify(ui))
  return ui
}

function handled(result: unknown): RuntimeUiRpcResult {
  return { handled: true, result }
}
