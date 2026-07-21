import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  collectDispatcherMethods,
  collectRendererRuntimeMethods,
  findMissingRuntimeMethods,
  verifyRuntimeMethodCoverage
} from './verify-tauri-runtime-method-coverage.mjs'

function fixture(name, source) {
  const root = mkdtempSync(join(tmpdir(), 'pebble-runtime-methods-'))
  const file = join(root, name)
  writeFileSync(file, source)
  return file
}

test('collects renderer literals from both supported call shapes', () => {
  const file = fixture(
    'renderer.ts',
    `
      callRuntimeRpc(target, 'repo.list', {})
      window.api.runtime.call({ method: 'terminal.send', params: {} })
      callRuntimeRpc(target, dynamicMethod, {})
    `
  )
  assert.deepEqual([...collectRendererRuntimeMethods([file]).keys()].sort(), [
    'repo.list',
    'terminal.send'
  ])
})

test('collects dispatcher case labels and reports missing renderer methods', () => {
  const file = fixture(
    'dispatcher.ts',
    `switch (method) { case 'repo.list': return []; case 'terminal.send': return true }`
  )
  const dispatcher = collectDispatcherMethods(file)
  assert.deepEqual([...dispatcher].sort(), ['repo.list', 'terminal.send'])
  assert.deepEqual(
    findMissingRuntimeMethods(new Map([['repo.list', []], ['git.status', []]]), dispatcher),
    ['git.status']
  )
})

test('collects explicit method equality dispatch and excludes remote-only adapters', () => {
  const file = fixture(
    'dispatcher.ts',
    `if (method === 'workspacePorts.scan') return { handled: true }`
  )
  const dispatcher = collectDispatcherMethods(file)
  assert.equal(dispatcher.has('workspacePorts.scan'), true)
  assert.deepEqual(
    findMissingRuntimeMethods(
      new Map([
        ['jira.status', []],
        ['nativeChat.readSession', []],
        ['orchestration.dispatchShow', []]
      ]),
      dispatcher
    ),
    ['orchestration.dispatchShow']
  )
})

test('combines decomposed domain dispatchers for coverage', () => {
  const renderer = fixture('renderer.ts', `callRuntimeRpc(target, 'git.status', {})`)
  const rootDispatcher = fixture('root.ts', `switch (method) { case 'repo.list': break }`)
  const gitDispatcher = fixture('git.ts', `switch (method) { case 'git.status': break }`)
  const result = verifyRuntimeMethodCoverage({
    dispatcherFiles: [rootDispatcher, gitDispatcher],
    rendererFiles: [renderer]
  })
  assert.deepEqual(result.missing, [])
})
