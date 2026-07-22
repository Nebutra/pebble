import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

import {
  allOwnedSpecs,
  browserInteractionSpecs,
  browserPlaywrightProjects,
  browserRendererSpecs,
  browserSystemSpecs,
  browserVisualSpecs,
  nativeBrowserForbiddenPatterns,
  nativeSpecEvidence,
  rendererSpecEvidence,
  retiredLegacySpecReplacements
} from './e2e-ownership.mjs'

const specDirectory = import.meta.dirname
const repositoryRoot = resolve(specDirectory, '../..')

test('every application spec has exactly one non-Electron owner', () => {
  const applicationSpecs = readdirSync(specDirectory)
    .filter((file) => file.endsWith('.spec.ts'))
    .sort()
  const owned = [...allOwnedSpecs].sort()

  assert.deepEqual(owned, applicationSpecs)
  assert.equal(new Set(allOwnedSpecs).size, allOwnedSpecs.length)
})

test('every browser ownership list is consumed by exactly one Playwright project', () => {
  assert.deepEqual(Object.keys(browserPlaywrightProjects), [
    'browser-renderer',
    'browser-system',
    'browser-interaction',
    'browser-visual'
  ])
  assert.equal(browserPlaywrightProjects['browser-renderer'], browserRendererSpecs)
  assert.equal(browserPlaywrightProjects['browser-system'], browserSystemSpecs)
  assert.equal(browserPlaywrightProjects['browser-interaction'], browserInteractionSpecs)
  assert.equal(browserPlaywrightProjects['browser-visual'], browserVisualSpecs)

  const playwrightConfig = readFileSync(
    resolve(repositoryRoot, 'tests/playwright.config.ts'),
    'utf8'
  )
  assert.match(playwrightConfig, /Object\.entries\(browserPlaywrightProjects\)/)

  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'))
  assert.equal(
    packageJson.scripts['test:e2e:browser'],
    'playwright test --config tests/playwright.config.ts'
  )
})

test('non-browser specs have explicit executable evidence and never enter Chrome projects', () => {
  const browserSpecs = new Set(Object.values(browserPlaywrightProjects).flat())
  const evidenceBySpec = { ...rendererSpecEvidence, ...nativeSpecEvidence }

  assert.equal(
    Object.keys(evidenceBySpec).length,
    Object.keys(rendererSpecEvidence).length + Object.keys(nativeSpecEvidence).length,
    'renderer and native replacement ownership must not overlap'
  )

  for (const [spec, replacements] of Object.entries(evidenceBySpec)) {
    assert.equal(browserSpecs.has(spec), false, spec)
    assert.ok(replacements.length >= 1, `${spec} must name native evidence`)
    for (const replacement of replacements) {
      const replacementPath = resolve(repositoryRoot, replacement.path)
      assert.equal(existsSync(replacementPath), true, replacement.path)
      assert.ok(
        readFileSync(replacementPath, 'utf8').includes(replacement.contract),
        `${spec} requires ${replacement.path} contract ${replacement.contract}`
      )
    }
  }
})

test('browser projects reject static native ownership markers', () => {
  const violations = []
  for (const spec of Object.values(browserPlaywrightProjects).flat()) {
    const source = readFileSync(resolve(specDirectory, spec), 'utf8')
    for (const marker of nativeBrowserForbiddenPatterns) {
      if (marker.pattern.test(source)) {
        violations.push(`${spec}: ${marker.label}`)
      }
    }
  }
  assert.deepEqual(violations, [])
})

test('browser web server resolves the desktop root explicitly', () => {
  const config = readFileSync(resolve(repositoryRoot, 'tests/playwright.config.ts'), 'utf8')
  assert.match(config, /cwd: resolve\('apps\/desktop'\)/)
})

test('application specs do not restore Electron test ownership', () => {
  const forbidden =
    /ElectronApplication|electronApp|_electron|electron-head(?:less|ful)|migration\/electron-reference/
  const violations = allOwnedSpecs.filter((spec) =>
    forbidden.test(readFileSync(new URL(spec, import.meta.url), 'utf8'))
  )
  assert.deepEqual(violations, [])
})

test('retired main-process shims stay deleted and point to executable native contracts', () => {
  for (const [retiredSpec, replacements] of Object.entries(retiredLegacySpecReplacements)) {
    assert.equal(existsSync(resolve(specDirectory, retiredSpec)), false, retiredSpec)
    assert.equal(allOwnedSpecs.includes(retiredSpec), false, retiredSpec)
    assert.ok(
      replacements.length >= 1,
      `${retiredSpec} must name at least one exact replacement contract`
    )
    for (const replacement of replacements) {
      const replacementPath = resolve(repositoryRoot, replacement.path)
      assert.equal(existsSync(replacementPath), true, replacement.path)
      assert.ok(statSync(replacementPath).size > 0, replacement.path)
      assert.ok(
        readFileSync(replacementPath, 'utf8').includes(replacement.contract),
        `${replacement.path} must retain contract ${replacement.contract}`
      )
    }
  }
})
