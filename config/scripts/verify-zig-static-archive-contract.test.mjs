import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { verifyZigStaticArchiveContract } from './verify-zig-static-archive-contract.mjs'

const buildSource = readFileSync(
  resolve(import.meta.dirname, '../../native/zig-system/build.zig'),
  'utf8'
)

describe('Zig static archive contract', () => {
  it('bundles compiler-rt for Linux Cargo consumers', () => {
    expect(() => verifyZigStaticArchiveContract(buildSource)).not.toThrow()
  })

  it('rejects archives that leave Zig runtime symbols unresolved', () => {
    expect(() => verifyZigStaticArchiveContract('const linux = true;')).toThrow(/compiler-rt/)
  })
})
