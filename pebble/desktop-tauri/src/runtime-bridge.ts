import { invoke } from '@tauri-apps/api/core'

import {
  DEFAULT_RUNTIME_URL,
  type BrowserActionPollInput,
  type BrowserActionUpdateInput,
  type EmulatorActionPollInput,
  type EmulatorActionUpdateInput,
  type NativeActionPollInput,
  type NativeActionUpdateInput,
  type NativeProviderRegistrationInput,
  type RuntimeEventStreamCommand,
  type RuntimeEventStreamResult,
  type RuntimeProcessStartCommand,
  type RuntimeProcessStatusResult,
  type RuntimeResourceGetCommand,
  type RuntimeResourceGetResult,
  type RuntimeResourceRequestCommand,
  type RuntimeStatusProbeCommand,
  type RuntimeStatusProbeResult
} from './runtime-command-shapes'

export function createRuntimeStatusProbeCommand(
  input: Partial<RuntimeStatusProbeCommand> = {}
): RuntimeStatusProbeCommand {
  return {
    runtimeUrl: input.runtimeUrl ?? DEFAULT_RUNTIME_URL,
    bearerToken: input.bearerToken ?? null,
    timeoutMs: input.timeoutMs ?? 1500
  }
}

export async function probeRuntimeStatus(
  input: RuntimeStatusProbeCommand
): Promise<RuntimeStatusProbeResult> {
  return invoke<RuntimeStatusProbeResult>('probe_runtime_status', { input })
}

export function createRuntimeProcessStartCommand(
  input: Partial<RuntimeProcessStartCommand> & { listen: string }
): RuntimeProcessStartCommand {
  return {
    executable: input.executable ?? 'pebble-runtime',
    listen: input.listen,
    dataDir: input.dataDir ?? null,
    bearerToken: input.bearerToken ?? null,
    extraArgs: input.extraArgs ?? []
  }
}

export async function startRuntimeProcess(
  input: RuntimeProcessStartCommand
): Promise<RuntimeProcessStatusResult> {
  return invoke<RuntimeProcessStatusResult>('start_runtime_process', { input })
}

export async function stopRuntimeProcess(): Promise<RuntimeProcessStatusResult> {
  return invoke<RuntimeProcessStatusResult>('stop_runtime_process')
}

export async function getRuntimeProcessStatus(): Promise<RuntimeProcessStatusResult> {
  return invoke<RuntimeProcessStatusResult>('runtime_process_status')
}

export function createRuntimeResourceGetCommand(
  input: Partial<RuntimeResourceGetCommand> & { path: string }
): RuntimeResourceGetCommand {
  return {
    runtimeUrl: input.runtimeUrl ?? DEFAULT_RUNTIME_URL,
    path: input.path,
    bearerToken: input.bearerToken ?? null,
    timeoutMs: input.timeoutMs ?? 1500
  }
}

export async function getRuntimeResourceJson(
  input: RuntimeResourceGetCommand
): Promise<RuntimeResourceGetResult> {
  return invoke<RuntimeResourceGetResult>('get_runtime_resource_json', { input })
}

export function createRuntimeResourceRequestCommand(
  input: Partial<RuntimeResourceRequestCommand> & {
    method: RuntimeResourceRequestCommand['method']
    path: string
  }
): RuntimeResourceRequestCommand {
  return {
    runtimeUrl: input.runtimeUrl ?? DEFAULT_RUNTIME_URL,
    method: input.method,
    path: input.path,
    bodyJson: input.bodyJson ?? null,
    bearerToken: input.bearerToken ?? null,
    timeoutMs: input.timeoutMs ?? 1500
  }
}

export async function requestRuntimeResourceJson(
  input: RuntimeResourceRequestCommand
): Promise<RuntimeResourceGetResult> {
  return invoke<RuntimeResourceGetResult>('request_runtime_resource_json', { input })
}

export function createRuntimeEventStreamCommand(
  input: Partial<RuntimeEventStreamCommand> = {}
): RuntimeEventStreamCommand {
  return {
    runtimeUrl: input.runtimeUrl ?? DEFAULT_RUNTIME_URL,
    bearerToken: input.bearerToken ?? null,
    timeoutMs: input.timeoutMs ?? 1500,
    limit: input.limit ?? 5,
    topic: input.topic ?? null
  }
}

export async function readRuntimeEventStream(
  input: RuntimeEventStreamCommand
): Promise<RuntimeEventStreamResult> {
  return invoke<RuntimeEventStreamResult>('read_runtime_event_stream', { input })
}

export function createNativeActionPollInput(
  input: Partial<NativeActionPollInput> = {}
): NativeActionPollInput {
  return {
    runtimeUrl: input.runtimeUrl ?? DEFAULT_RUNTIME_URL,
    bearerToken: input.bearerToken ?? null,
    timeoutMs: input.timeoutMs ?? 1500,
    kindPrefix: input.kindPrefix ?? null,
    limit: input.limit ?? 25
  }
}

export async function pollNativeActions(
  input: NativeActionPollInput
): Promise<RuntimeResourceGetResult> {
  return invoke<RuntimeResourceGetResult>('poll_native_actions', { input })
}

export function createNativeActionUpdateInput(
  input: Partial<NativeActionUpdateInput> & { actionId: string }
): NativeActionUpdateInput {
  return {
    runtimeUrl: input.runtimeUrl ?? DEFAULT_RUNTIME_URL,
    bearerToken: input.bearerToken ?? null,
    timeoutMs: input.timeoutMs ?? 1500,
    actionId: input.actionId,
    status: input.status ?? 'completed',
    resultJson: input.resultJson ?? null,
    errorMessage: input.errorMessage ?? null
  }
}

export async function updateNativeAction(
  input: NativeActionUpdateInput
): Promise<RuntimeResourceGetResult> {
  return invoke<RuntimeResourceGetResult>('update_native_action', { input })
}

export function createBrowserActionPollInput(
  input: Partial<BrowserActionPollInput> = {}
): BrowserActionPollInput {
  return {
    runtimeUrl: input.runtimeUrl ?? DEFAULT_RUNTIME_URL,
    bearerToken: input.bearerToken ?? null,
    timeoutMs: input.timeoutMs ?? 1500,
    limit: input.limit ?? 25
  }
}

export async function pollBrowserActions(
  input: BrowserActionPollInput
): Promise<RuntimeResourceGetResult> {
  return invoke<RuntimeResourceGetResult>('poll_browser_actions', { input })
}

export function createBrowserActionUpdateInput(
  input: Partial<BrowserActionUpdateInput> & { actionId: string }
): BrowserActionUpdateInput {
  return {
    runtimeUrl: input.runtimeUrl ?? DEFAULT_RUNTIME_URL,
    bearerToken: input.bearerToken ?? null,
    timeoutMs: input.timeoutMs ?? 1500,
    actionId: input.actionId,
    status: input.status ?? 'completed',
    resultJson: input.resultJson ?? null,
    errorMessage: input.errorMessage ?? null
  }
}

export async function updateBrowserAction(
  input: BrowserActionUpdateInput
): Promise<RuntimeResourceGetResult> {
  return invoke<RuntimeResourceGetResult>('update_browser_action', { input })
}

export function createEmulatorActionPollInput(
  input: Partial<EmulatorActionPollInput> = {}
): EmulatorActionPollInput {
  return {
    runtimeUrl: input.runtimeUrl ?? DEFAULT_RUNTIME_URL,
    bearerToken: input.bearerToken ?? null,
    timeoutMs: input.timeoutMs ?? 1500,
    limit: input.limit ?? 25
  }
}

export async function pollEmulatorActions(
  input: EmulatorActionPollInput
): Promise<RuntimeResourceGetResult> {
  return invoke<RuntimeResourceGetResult>('poll_emulator_actions', { input })
}

export function createEmulatorActionUpdateInput(
  input: Partial<EmulatorActionUpdateInput> & { actionId: string }
): EmulatorActionUpdateInput {
  return {
    runtimeUrl: input.runtimeUrl ?? DEFAULT_RUNTIME_URL,
    bearerToken: input.bearerToken ?? null,
    timeoutMs: input.timeoutMs ?? 1500,
    actionId: input.actionId,
    status: input.status ?? 'completed',
    resultJson: input.resultJson ?? null,
    errorMessage: input.errorMessage ?? null
  }
}

export async function updateEmulatorAction(
  input: EmulatorActionUpdateInput
): Promise<RuntimeResourceGetResult> {
  return invoke<RuntimeResourceGetResult>('update_emulator_action', { input })
}

export function createNativeProviderRegistrationInput(
  input: Partial<NativeProviderRegistrationInput> & {
    subsystem: NativeProviderRegistrationInput['subsystem']
    name: string
  }
): NativeProviderRegistrationInput {
  return {
    runtimeUrl: input.runtimeUrl ?? DEFAULT_RUNTIME_URL,
    bearerToken: input.bearerToken ?? null,
    timeoutMs: input.timeoutMs ?? 1500,
    id: input.id ?? null,
    subsystem: input.subsystem,
    name: input.name,
    status: input.status ?? 'ready',
    capabilities: input.capabilities ?? [],
    message: input.message ?? null
  }
}

export async function registerNativeProvider(
  input: NativeProviderRegistrationInput
): Promise<RuntimeResourceGetResult> {
  return invoke<RuntimeResourceGetResult>('register_native_provider', { input })
}
