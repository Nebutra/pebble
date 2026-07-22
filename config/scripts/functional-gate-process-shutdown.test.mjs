import assert from 'node:assert/strict'
import test from 'node:test'

import { stopFunctionalGateProcess } from './functional-gate-process-shutdown.mjs'

test('waits for the complete Unix process group after graceful termination', async () => {
  const calls = []
  let probes = 0
  const kill = (pid, signal) => {
    calls.push([pid, signal])
    if (signal === 0 && ++probes > 1) {
      throw missingProcess()
    }
  }

  await stopFunctionalGateProcess(runningChild(41), {
    platform: 'darwin',
    kill,
    readProcessGroup: () => 41,
    graceMs: 100,
    delay: async () => {}
  })

  assert.deepEqual(calls, [
    [-41, 'SIGTERM'],
    [-41, 0],
    [-41, 0]
  ])
})

test('cleans a surviving Unix process group after its wrapper exits', async () => {
  const signals = []
  let probes = 0
  const kill = (_pid, signal) => {
    if (signal !== 0) {
      signals.push(signal)
    }
    if (signal === 0 && ++probes > 1) {
      throw missingProcess()
    }
  }

  await stopFunctionalGateProcess(
    { pid: 44, exitCode: 0, signalCode: null },
    {
      platform: 'darwin',
      kill,
      readProcessGroup: () => 44,
      graceMs: 100,
      delay: async () => {}
    }
  )

  assert.deepEqual(signals, ['SIGTERM'])
})

test('cleans an orphaned Unix process group after the wrapper leaves ps', async () => {
  const signals = []
  let probes = 0
  const kill = (_pid, signal) => {
    if (signal !== 0) {
      signals.push(signal)
    }
    if (signal === 0 && ++probes > 2) {
      throw missingProcess()
    }
  }

  await stopFunctionalGateProcess(
    { pid: 45, exitCode: 0, signalCode: null },
    {
      platform: 'darwin',
      kill,
      readProcessGroup: () => null,
      graceMs: 100,
      delay: async () => {}
    }
  )

  assert.deepEqual(signals, ['SIGTERM'])
})

test('escalates a Unix process group that does not finish clean shutdown', async () => {
  const signals = []
  let killed = false
  const kill = (_pid, signal) => {
    if (signal !== 0) {
      signals.push(signal)
    }
    if (signal === 'SIGKILL') {
      killed = true
    }
    if (signal === 0 && killed) {
      throw missingProcess()
    }
  }

  await stopFunctionalGateProcess(runningChild(42), {
    platform: 'linux',
    kill,
    readProcessGroup: () => 42,
    graceMs: 1,
    delay: async () => {}
  })

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
})

test('falls back to the descendant tree when npm shares the runner process group', async () => {
  const signals = []
  const alive = new Set([51, 52, 53])
  const kill = (pid, signal) => {
    if (signal === 0) {
      if (alive.has(pid)) {
        return
      }
      throw missingProcess()
    }
    signals.push([pid, signal])
    alive.delete(pid)
  }

  await stopFunctionalGateProcess(runningChild(51), {
    platform: 'darwin',
    kill,
    readProcessGroup: () => 7,
    readProcessTable: () => [
      { pid: 52, ppid: 51 },
      { pid: 53, ppid: 52 }
    ],
    graceMs: 100,
    delay: async () => {}
  })

  assert.deepEqual(signals, [
    [53, 'SIGTERM'],
    [52, 'SIGTERM'],
    [51, 'SIGTERM']
  ])
})

test('uses graceful taskkill before forced Windows cleanup', async () => {
  const commands = []
  let probes = 0
  await stopFunctionalGateProcess(runningChild(43), {
    platform: 'win32',
    kill: (_pid, signal) => {
      if (signal === 0 && ++probes > 1) {
        throw missingProcess()
      }
    },
    runTaskkill: (...args) => commands.push(args),
    graceMs: 100,
    delay: async () => {}
  })

  assert.deepEqual(commands[0]?.[1], ['/pid', '43', '/t'])
  assert.equal(commands.length, 1)
})

test('treats a reused inaccessible Unix process group as cleaned up', async () => {
  const kill = (_pid, signal) => {
    if (signal === 0) {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
    }
  }

  await stopFunctionalGateProcess(runningChild(54), {
    platform: 'darwin',
    kill,
    readProcessGroup: () => 54,
    graceMs: 100,
    delay: async () => {}
  })
})

function runningChild(pid) {
  return { pid, exitCode: null, signalCode: null }
}

function missingProcess() {
  return Object.assign(new Error('missing process'), { code: 'ESRCH' })
}
