import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  containsLegacyBrandIdentifier,
  scanLegacyBrandIdentifiers
} from './legacy-brand-identifier-scan.mjs'

describe('legacy brand identifier scan', () => {
  const retiredName = ['or', 'ca'].join('')

  it.each([
    retiredName,
    `${retiredName}Status`,
    `${retiredName}Mobile`,
    `.${retiredName}/state.json`,
    `${retiredName.toUpperCase()}_RUNTIME_URL`
  ])('rejects %s', (value) => expect(containsLegacyBrandIdentifier(value)).toBe(true))

  it.each(['ForCandidate', 'ErrorCard', 'cursorCanvas', 'ForCaching', 'ForCanonical'])(
    'does not reject ordinary identifier %s',
    (value) => expect(containsLegacyBrandIdentifier(value)).toBe(false)
  )

  it('scans historical, verifier-owned, and path identity residue without exceptions', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'pebble-brand-scan-'))
    const historicalFile = '.trellis/tasks/migration/prd.md'
    const scannerFile = 'config/scripts/legacy-brand-identifier-scan.mjs'
    const retiredPath = `docs/${retiredName}-migration.md`

    try {
      for (const file of [historicalFile, scannerFile]) {
        await mkdir(join(repoRoot, dirname(file)), { recursive: true })
        await writeFile(join(repoRoot, file), `retired product: ${retiredName}\n`)
      }

      await expect(
        scanLegacyBrandIdentifiers(repoRoot, [historicalFile, scannerFile, retiredPath])
      ).resolves.toEqual([historicalFile, scannerFile, `${retiredPath} (path)`])
    } finally {
      await rm(repoRoot, { force: true, recursive: true })
    }
  })
})
