import { describe, expect, it } from 'vitest'
import {
  containsLegacyBrandIdentifier,
  isHistoricalEvidencePath
} from './legacy-brand-identifier-scan.mjs'

describe('legacy brand identifier scan', () => {
  it.each(['Orca', 'orcaStatus', 'OrcaMobile', '.orca/state.json', 'ORCA_RUNTIME_URL'])(
    'rejects %s',
    (value) => expect(containsLegacyBrandIdentifier(value)).toBe(true)
  )

  it.each(['ForCandidate', 'ErrorCard', 'cursorCanvas', 'ForCaching', 'ForCanonical'])(
    'does not reject ordinary identifier %s',
    (value) => expect(containsLegacyBrandIdentifier(value)).toBe(false)
  )

  it('allows legacy names only in non-shipping Trellis task history', () => {
    expect(isHistoricalEvidencePath('.trellis/tasks/07-20-migration/prd.md')).toBe(true)
    expect(isHistoricalEvidencePath('apps/desktop/src/product-brand.ts')).toBe(false)
  })
})
