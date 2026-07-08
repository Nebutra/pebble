export const RUNTIME_API_VERSION = 'pebble.runtime.v1' as const
export const RUNTIME_STATUS_PATH = '/v1/status' as const
export const DEFAULT_RUNTIME_URL = 'http://127.0.0.1:17777' as const
export const RUNTIME_RESOURCE_PATHS = [
  '/v1/projects',
  '/v1/worktrees',
  '/v1/sessions',
  '/v1/agents',
  '/v1/agents/profiles',
  '/v1/agents/runs',
  '/v1/orchestration/tasks',
  '/v1/orchestration/messages',
  '/v1/orchestration/dispatches',
  '/v1/automations',
  '/v1/automations/runs',
  '/v1/external-tasks',
  '/v1/source-control',
  '/v1/source-control/status',
  '/v1/files/tree',
  '/v1/files/read',
  '/v1/releases',
  '/v1/settings',
  '/v1/settings/keybindings',
  '/v1/browser/tabs',
  '/v1/browser/profiles',
  '/v1/browser/permissions',
  '/v1/browser/downloads',
  '/v1/computer/actions',
  '/v1/emulator/devices',
  '/v1/emulator/sessions',
  '/v1/providers',
  '/v1/mobile-relay/status',
  '/v1/mobile-relay/pairings',
  '/v1/mobile-relay/projection'
] as const

export type RuntimeTransportState =
  | 'connected'
  | 'http-error'
  | 'invalid-endpoint'
  | 'invalid-response'
  | 'unreachable'

export interface RuntimeStatusProbeCommand {
  runtimeUrl: string
  bearerToken?: string | null
  timeoutMs: number
}

export interface RuntimeStatusProbeResult {
  runtimeUrl: string
  requestPath: string
  transport: RuntimeTransportState
  httpStatus: number | null
  contractVersion: string | null
  contractVersionMatches: boolean | null
  serviceState: string | null
  body: string | null
  error: string | null
}

export interface RuntimeProcessStartCommand {
  executable: string
  listen: string
  dataDir?: string | null
  bearerToken?: string | null
  extraArgs: string[]
}

export interface RuntimeProcessStatusResult {
  running: boolean
  pid: number | null
  executable: string | null
  listen: string | null
  exitCode: number | null
  error: string | null
}

export interface RuntimeResourceGetCommand {
  runtimeUrl: string
  path: string
  bearerToken?: string | null
  timeoutMs: number
}

export interface RuntimeResourceRequestCommand {
  runtimeUrl: string
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  bodyJson?: string | null
  bearerToken?: string | null
  timeoutMs: number
}

export interface RuntimeResourceGetResult {
  runtimeUrl: string
  requestPath: string
  transport: RuntimeTransportState
  httpStatus: number | null
  body: string | null
  error: string | null
}

export interface RuntimeEventStreamCommand {
  runtimeUrl: string
  bearerToken?: string | null
  timeoutMs: number
  limit: number
  topic?: string | null
}

export interface RuntimeEventStreamEntry {
  id: string | null
  topic: string | null
  data: string
}

export interface RuntimeEventStreamResult {
  runtimeUrl: string
  requestPath: string
  transport: RuntimeTransportState
  httpStatus: number | null
  events: RuntimeEventStreamEntry[]
  error: string | null
}

export interface NativeActionPollInput {
  runtimeUrl: string
  bearerToken?: string | null
  timeoutMs: number
  kindPrefix?: string | null
  limit: number
}

export interface NativeActionUpdateInput {
  runtimeUrl: string
  bearerToken?: string | null
  timeoutMs: number
  actionId: string
  status: 'completed' | 'failed'
  resultJson?: string | null
  errorMessage?: string | null
}

export interface BrowserActionPollInput {
  runtimeUrl: string
  bearerToken?: string | null
  timeoutMs: number
  limit: number
}

export interface BrowserActionUpdateInput {
  runtimeUrl: string
  bearerToken?: string | null
  timeoutMs: number
  actionId: string
  status: 'completed' | 'failed'
  resultJson?: string | null
  errorMessage?: string | null
}

export interface EmulatorActionPollInput {
  runtimeUrl: string
  bearerToken?: string | null
  timeoutMs: number
  limit: number
}

export interface EmulatorActionUpdateInput {
  runtimeUrl: string
  bearerToken?: string | null
  timeoutMs: number
  actionId: string
  status: 'completed' | 'failed'
  resultJson?: string | null
  errorMessage?: string | null
}

export interface NativeProviderRegistrationInput {
  runtimeUrl: string
  bearerToken?: string | null
  timeoutMs: number
  id?: string | null
  subsystem: 'browser' | 'computer' | 'emulator'
  name: string
  status?: 'ready' | 'running' | 'degraded' | 'error' | null
  capabilities: string[]
  message?: string | null
}

export interface DesktopCommandMap {
  start_runtime_process: {
    input: RuntimeProcessStartCommand
    output: RuntimeProcessStatusResult
  }
  stop_runtime_process: {
    input: undefined
    output: RuntimeProcessStatusResult
  }
  runtime_process_status: {
    input: undefined
    output: RuntimeProcessStatusResult
  }
  probe_runtime_status: {
    input: RuntimeStatusProbeCommand
    output: RuntimeStatusProbeResult
  }
  get_runtime_resource_json: {
    input: RuntimeResourceGetCommand
    output: RuntimeResourceGetResult
  }
  read_runtime_event_stream: {
    input: RuntimeEventStreamCommand
    output: RuntimeEventStreamResult
  }
  poll_native_actions: {
    input: NativeActionPollInput
    output: RuntimeResourceGetResult
  }
  update_native_action: {
    input: NativeActionUpdateInput
    output: RuntimeResourceGetResult
  }
  poll_browser_actions: {
    input: BrowserActionPollInput
    output: RuntimeResourceGetResult
  }
  update_browser_action: {
    input: BrowserActionUpdateInput
    output: RuntimeResourceGetResult
  }
  poll_emulator_actions: {
    input: EmulatorActionPollInput
    output: RuntimeResourceGetResult
  }
  update_emulator_action: {
    input: EmulatorActionUpdateInput
    output: RuntimeResourceGetResult
  }
  register_native_provider: {
    input: NativeProviderRegistrationInput
    output: RuntimeResourceGetResult
  }
}
