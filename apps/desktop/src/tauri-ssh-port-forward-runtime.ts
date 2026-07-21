import type {
  PortForwardEntry,
  EnrichedDetectedPort
} from '../../../packages/product-core/shared/ssh-types'
import { requestRuntimeJson } from './pebble-runtime-http-bridge'
import {
  portForwardListeners,
  detectedPortListeners,
  detectedPortPollers
} from './tauri-ssh-runtime-registry'
import { listTargets } from './tauri-ssh-targets-api'

export async function restorePortForwards(targetId: string): Promise<void> {
  await requestRuntimeJson<PortForwardEntry[]>(
    `/v1/ssh-targets/${encodeURIComponent(targetId)}/port-forwards/restore`,
    { method: 'POST', timeoutMs: 20_000 }
  )
  await emitPortForwards(targetId)
}

export async function terminatePortForwards(targetId: string): Promise<void> {
  await requestRuntimeJson(
    `/v1/ssh-targets/${encodeURIComponent(targetId)}/port-forwards/terminate`,
    { method: 'POST', timeoutMs: 15_000 }
  )
  stopDetectedPortPolling(targetId)
  await emitPortForwards(targetId)
}

export async function addPortForward(args: {
  targetId: string
  localPort: number
  remoteHost: string
  remotePort: number
  label?: string
}): Promise<PortForwardEntry> {
  const entry = await requestRuntimeJson<PortForwardEntry>(
    `/v1/ssh-targets/${encodeURIComponent(args.targetId)}/port-forwards`,
    { method: 'POST', body: args, timeoutMs: 20_000 }
  )
  await emitPortForwards(args.targetId)
  return entry
}

export async function updatePortForward(args: {
  id: string
  targetId: string
  localPort: number
  remoteHost: string
  remotePort: number
  label?: string
}): Promise<PortForwardEntry> {
  const entry = await requestRuntimeJson<PortForwardEntry>(
    `/v1/ssh-targets/${encodeURIComponent(args.targetId)}/port-forwards/${encodeURIComponent(args.id)}`,
    { method: 'PATCH', body: args, timeoutMs: 20_000 }
  )
  await emitPortForwards(args.targetId)
  return entry
}

export async function removePortForward(args: { id: string }): Promise<PortForwardEntry | null> {
  const targets = await listTargets()
  for (const target of targets) {
    const forwards = await listPortForwards({ targetId: target.id })
    if (!forwards.some((forward) => forward.id === args.id)) {
      continue
    }
    const removed = await requestRuntimeJson<PortForwardEntry | null>(
      `/v1/ssh-targets/${encodeURIComponent(target.id)}/port-forwards/${encodeURIComponent(args.id)}`,
      { method: 'DELETE' }
    )
    await emitPortForwards(target.id)
    return removed
  }
  return null
}

export async function listPortForwards(args?: {
  targetId?: string
}): Promise<PortForwardEntry[]> {
  if (args?.targetId) {
    return requestRuntimeJson<PortForwardEntry[]>(
      `/v1/ssh-targets/${encodeURIComponent(args.targetId)}/port-forwards`,
      { method: 'GET' }
    )
  }
  const targets = await listTargets()
  return (
    await Promise.all(targets.map((target) => listPortForwards({ targetId: target.id })))
  ).flat()
}

export async function emitPortForwards(targetId: string): Promise<void> {
  const forwards = await listPortForwards({ targetId })
  for (const listener of portForwardListeners) {
    listener({ targetId, forwards })
  }
}

export async function listDetectedPorts(args: {
  targetId: string
}): Promise<EnrichedDetectedPort[]> {
  return requestRuntimeJson<EnrichedDetectedPort[]>(
    `/v1/ssh-targets/${encodeURIComponent(args.targetId)}/ports/detected`,
    { method: 'GET', timeoutMs: 20_000 }
  )
}

export function startDetectedPortPolling(targetId: string): void {
  if (detectedPortPollers.has(targetId) || detectedPortListeners.size === 0) {
    return
  }
  const poll = async (): Promise<void> => {
    const ports = await listDetectedPorts({ targetId }).catch(() => null)
    if (!ports) {
      return
    }
    for (const listener of detectedPortListeners) {
      listener({ targetId, ports })
    }
  }
  void poll()
  detectedPortPollers.set(
    targetId,
    setInterval(() => void poll(), 3_000)
  )
}

export function stopDetectedPortPolling(targetId: string): void {
  const poller = detectedPortPollers.get(targetId)
  if (poller) {
    clearInterval(poller)
  }
  detectedPortPollers.delete(targetId)
}
