import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { waitForCleanExit } from './functional-gate-process-exit.mjs'

test('resolves immediately when the functional shell already exited', async () => {
  const child = new EventEmitter()
  child.exitCode = 0
  child.signalCode = null
  assert.equal(await waitForCleanExit(child, 100), true)
})

test('waits for the functional shell clean exit', async () => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  setTimeout(() => child.emit('exit', 0, null), 5)
  assert.equal(await waitForCleanExit(child, 100), true)
})

test('allows the harness to fall back when clean exit stalls', async () => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  assert.equal(await waitForCleanExit(child, 5), false)
  assert.equal(child.listenerCount('exit'), 0)
})
