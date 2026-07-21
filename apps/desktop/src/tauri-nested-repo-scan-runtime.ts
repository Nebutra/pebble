import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type {
  NestedRepoScanResult,
  ProjectGroupImportResult
} from '../../../packages/product-core/shared/types'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import type { RuntimeEventStreamEntry } from './runtime-command-shapes'
import { subscribeRuntimeEventPush } from './tauri-runtime-event-push'
import {
  type ProjectGroupScanNestedArgs,
  type ProjectGroupImportNestedArgs,
  readObject,
  readObjectOrUndefined,
  readOptionalString
} from './tauri-project-group-rpc-arg-readers'

type NestedScanProgressListener = Parameters<PreloadApi['projectGroups']['onNestedScanProgress']>[0]

type ActiveNestedScan = {
  canceled: boolean
}

// Emitted by the Go runtime while a scan with a scanId walks directories:
// per-repo snapshots (Electron's cadence) plus throttled directory-visit
// liveness updates carrying `directoriesVisited`.
const SCAN_PROGRESS_TOPIC = 'project-group.scan-progress'

const nestedScanProgressListeners = new Set<NestedScanProgressListener>()
const activeNestedScans = new Map<string, ActiveNestedScan>()
let scanProgressPumpStarted = false

async function readRuntimeNestedRepos(
  args: ProjectGroupScanNestedArgs
): Promise<NestedRepoScanResult> {
  const params = {
    path: args.path,
    scanId: readOptionalString(args.scanId),
    options: readObjectOrUndefined(args.options)
  }
  if (args.connectionId) {
    try {
      return await callRemoteRuntimeResult<NestedRepoScanResult>(
        args.connectionId,
        'projectGroup.scanNested',
        params
      )
    } catch (rpcError) {
      if (!isRelayOnlyRuntimeGap(rpcError)) {
        throw rpcError
      }
      // Relay-only SSH connections have no paired runtime environment; fall
      // back to the scan the relay worker posted into the Go runtime's cache.
      return readRelayNestedScan(args.connectionId, args.path, rpcError)
    }
  }
  return requestRuntimeJson<NestedRepoScanResult>('/v1/project-groups/scan-nested', {
    method: 'POST',
    body: params,
    timeoutMs: 20_000
  })
}

async function readRelayNestedScan(
  connectionId: string,
  path: string,
  rpcError: unknown
): Promise<NestedRepoScanResult> {
  try {
    const cached = await requestRuntimeJson<{ scan: NestedRepoScanResult }>(
      `/v1/project-groups/remote-nested-scans?hostId=${encodeURIComponent(connectionId)}&path=${encodeURIComponent(path)}`,
      { method: 'GET', timeoutMs: 5000 }
    )
    return cached.scan
  } catch {
    // No relay scan was posted either: surface an actionable, typed gap
    // instead of the opaque runtime-environment RPC failure.
    throw new Error(
      'relay_nested_scan_unavailable: no runtime environment answered projectGroup.scanNested ' +
        `(${rpcError instanceof Error ? rpcError.message : String(rpcError)}) and no relay scan snapshot exists. ` +
        `Run \`pebble-relay-worker scan-nested --host ${connectionId} --path ${path}\` on the SSH host first.`
    )
  }
}

export async function scanRuntimeNestedRepos(
  args: ProjectGroupScanNestedArgs
): Promise<NestedRepoScanResult> {
  const scanId = readOptionalString(args.scanId)
  const activeScan = scanId ? startNestedScan(scanId) : null
  try {
    const scan = await readRuntimeNestedRepos(args)
    const result = activeScan?.canceled ? toStoppedNestedScan(scan) : scan
    if (scanId) {
      emitNestedScanProgress(scanId, result)
    }
    return result
  } finally {
    if (scanId && activeNestedScans.get(scanId) === activeScan) {
      activeNestedScans.delete(scanId)
    }
  }
}

function startNestedScan(scanId: string): ActiveNestedScan {
  const previous = activeNestedScans.get(scanId)
  if (previous) {
    previous.canceled = true
  }
  const activeScan: ActiveNestedScan = { canceled: false }
  activeNestedScans.set(scanId, activeScan)
  return activeScan
}

export async function cancelRuntimeNestedScan(scanId: string): Promise<boolean> {
  const activeScan = activeNestedScans.get(scanId)
  if (!activeScan) {
    return false
  }
  activeScan.canceled = true
  const runtime = await requestRuntimeJson<{ canceled: boolean }>(
    '/v1/project-groups/scan-nested/cancel',
    {
      method: 'POST',
      body: { scanId },
      timeoutMs: 5000
    }
  ).catch(() => ({ canceled: false }))
  // Why: preserve immediate UI cancellation even if the runtime request races
  // scan completion; the local result is still converted to stopped.
  return runtime.canceled || activeScan.canceled
}

export function subscribeNestedScanProgress(callback: NestedScanProgressListener): () => void {
  nestedScanProgressListeners.add(callback)
  ensureScanProgressPump()
  return () => {
    nestedScanProgressListeners.delete(callback)
  }
}

// Streams the runtime's mid-walk snapshots to progress listeners. Push-only by
// design: progress is a liveness enhancement and the completion snapshot is
// still emitted directly by scanRuntimeNestedRepos, so no polling fallback.
function ensureScanProgressPump(): void {
  if (scanProgressPumpStarted) {
    return
  }
  scanProgressPumpStarted = true
  void subscribeRuntimeEventPush((entry) => {
    const progress = parseScanProgressEvent(entry)
    // Only scans this window started stay in activeNestedScans; skip snapshots
    // for other windows' scan ids (and drop late events after completion).
    if (progress && activeNestedScans.has(progress.scanId)) {
      emitNestedScanProgress(progress.scanId, progress.scan)
    }
  }).catch(() => {
    scanProgressPumpStarted = false
  })
}

function parseScanProgressEvent(
  entry: RuntimeEventStreamEntry
): { scanId: string; scan: NestedRepoScanResult } | null {
  if (entry.topic && entry.topic !== SCAN_PROGRESS_TOPIC) {
    return null
  }
  try {
    const event = JSON.parse(entry.data) as { topic?: string; payload?: unknown }
    if (event.topic !== SCAN_PROGRESS_TOPIC) {
      return null
    }
    const payload = readObject(event.payload)
    const scanId = typeof payload.scanId === 'string' ? payload.scanId : ''
    const scan = payload.scan
    if (
      !scanId ||
      typeof scan !== 'object' ||
      scan === null ||
      !Array.isArray((scan as NestedRepoScanResult).repos)
    ) {
      return null
    }
    return { scanId, scan: scan as NestedRepoScanResult }
  } catch {
    return null
  }
}

function emitNestedScanProgress(scanId: string, scan: NestedRepoScanResult): void {
  for (const listener of nestedScanProgressListeners) {
    listener({ scanId, scan })
  }
}

function toStoppedNestedScan(scan: NestedRepoScanResult): NestedRepoScanResult {
  return {
    ...scan,
    repos: [],
    stopped: true
  }
}

export async function importRuntimeNestedRepos(
  args: ProjectGroupImportNestedArgs
): Promise<ProjectGroupImportResult> {
  const body = {
    parentPath: args.parentPath,
    groupName: args.groupName,
    projectPaths: args.projectPaths,
    scanId: readOptionalString(args.scanId),
    mode: args.mode
  }
  if (args.connectionId) {
    try {
      return await callRemoteRuntimeResult<ProjectGroupImportResult>(
        args.connectionId,
        'projectGroup.importNested',
        body
      )
    } catch (rpcError) {
      if (!isRelayOnlyRuntimeGap(rpcError)) {
        throw rpcError
      }
      // Relay-only fallback: import from the relay-posted scan snapshot the
      // Go runtime caches, creating SSH project records against the host id.
      return requestRuntimeJson<ProjectGroupImportResult>(
        '/v1/project-groups/import-remote-nested',
        {
          method: 'POST',
          body: { ...body, hostId: args.connectionId },
          timeoutMs: 30_000
        }
      )
    }
  }
  return requestRuntimeJson<ProjectGroupImportResult>('/v1/project-groups/import-nested', {
    method: 'POST',
    body,
    timeoutMs: 30_000
  })
}

async function callRemoteRuntimeResult<TResult>(
  selector: string,
  method: string,
  params: unknown
): Promise<TResult> {
  const response = await window.api.runtimeEnvironments.call({
    selector,
    method,
    params,
    timeoutMs: 30_000
  })
  if (!response.ok) {
    throw new RuntimeEnvironmentRpcError(response.error.code, response.error.message)
  }
  return response.result as TResult
}

class RuntimeEnvironmentRpcError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message || code)
    this.name = 'RuntimeEnvironmentRpcError'
  }
}

function isRelayOnlyRuntimeGap(error: unknown): boolean {
  return (
    error instanceof RuntimeEnvironmentRpcError &&
    ['not_found', 'method_not_found', 'remote_runtime_unavailable'].includes(error.code)
  )
}
