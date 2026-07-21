import { spawnSync } from 'node:child_process'

const DEFAULT_GRACE_MS = 5_000
const POLL_MS = 50

export async function stopFunctionalGateProcess(
  child,
  {
    platform = process.platform,
    kill = process.kill,
    runTaskkill = spawnSync,
    readProcessGroup = systemProcessGroup,
    readProcessTable = systemProcessTable,
    graceMs = DEFAULT_GRACE_MS,
    delay = defaultDelay
  } = {}
) {
  if (!child?.pid) return

  if (platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return
    runTaskkill('taskkill.exe', ['/pid', String(child.pid), '/t'], {
      stdio: 'ignore'
    })
    if (await waitUntilGone(() => kill(child.pid, 0), graceMs, delay)) return
    runTaskkill('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore'
    })
    await waitUntilGone(() => kill(child.pid, 0), graceMs, delay)
    return
  }

  const processGroup = readProcessGroup(child.pid)
  if (processGroup === child.pid || (processGroup === null && processGroupExists(child.pid, kill))) {
    signalProcessGroup(child.pid, 'SIGTERM', kill)
    if (await waitUntilGone(() => kill(-child.pid, 0), graceMs, delay)) return
    signalProcessGroup(child.pid, 'SIGKILL', kill)
    await waitUntilGone(() => kill(-child.pid, 0), graceMs, delay)
    return
  }

  // Why: npm wrappers do not reliably receive their own process group on
  // macOS. Kill the captured descendant tree without signaling our runner.
  const pids = descendantProcessIds(child.pid, readProcessTable())
  signalProcesses(pids, 'SIGTERM', kill)
  if (await waitUntilGone(() => probeProcesses(pids, kill), graceMs, delay)) return
  signalProcesses(pids, 'SIGKILL', kill)
  await waitUntilGone(() => probeProcesses(pids, kill), graceMs, delay)
}

function processGroupExists(pid, kill) {
  try {
    kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

function systemProcessGroup(pid) {
  const result = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' })
  const parsed = Number.parseInt(result.stdout?.trim() ?? '', 10)
  return Number.isInteger(parsed) ? parsed : null
}

function systemProcessTable() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
  return (result.stdout ?? '')
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid]) => Number.isInteger(pid) && Number.isInteger(ppid))
    .map(([pid, ppid]) => ({ pid, ppid }))
}

function descendantProcessIds(rootPid, table) {
  const descendants = []
  const pending = [rootPid]
  while (pending.length > 0) {
    const parent = pending.pop()
    for (const entry of table) {
      if (entry.ppid !== parent || descendants.includes(entry.pid)) continue
      descendants.push(entry.pid)
      pending.push(entry.pid)
    }
  }
  return [...descendants.reverse(), rootPid]
}

function signalProcesses(pids, signal, kill) {
  for (const pid of pids) {
    try {
      kill(pid, signal)
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
}

function probeProcesses(pids, kill) {
  for (const pid of pids) {
    try {
      kill(pid, 0)
      return
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
  throw Object.assign(new Error('process tree exited'), { code: 'ESRCH' })
}

async function waitUntilGone(probe, timeoutMs, delay) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      probe()
    } catch (error) {
      // EPERM after signaling means the original group is gone and its numeric
      // PGID may already belong to an unrelated process we must not touch.
      if (error?.code === 'ESRCH' || error?.code === 'EPERM') return true
      throw error
    }
    await delay(Math.min(POLL_MS, Math.max(1, deadline - Date.now())))
  }
  return false
}

function signalProcessGroup(pid, signal, kill) {
  try {
    kill(-pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

function defaultDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
