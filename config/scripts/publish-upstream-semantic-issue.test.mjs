import { describe, expect, it } from 'vitest'

import { findMarkedIssue, issueMarker } from './publish-upstream-semantic-issue.mjs'

const report = { schemaVersion: 1, range: { from: 'a'.repeat(40), to: 'b'.repeat(40) } }

describe('semantic issue publication', () => {
  it('keeps issue markers stable for the same audited range', () => {
    expect(issueMarker(report)).toBe(issueMarker(structuredClone(report)))
    expect(issueMarker(report)).not.toBe(
      issueMarker({ ...report, range: { ...report.range, to: 'c'.repeat(40) } })
    )
  })

  it('finds the canonical issue without depending on its title', () => {
    const marker = issueMarker(report)
    expect(findMarkedIssue([{ number: 12, body: `${marker}\nbody` }], marker)?.number).toBe(12)
    expect(findMarkedIssue([{ number: 13, body: 'other' }], marker)).toBeNull()
  })
})
