import { describe, expect, it } from 'vitest'

import {
  findMarkedIssue,
  issueMarker,
  neutralizeMentions
} from './publish-upstream-semantic-issue.mjs'

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

  it('never notifies upstream handles carried in commit subjects', () => {
    expect(neutralizeMentions('- `abc` [high] fix: thanks to @someone (#42)')).toBe(
      '- `abc` [high] fix: thanks to someone (#42)'
    )
  })

  it('keeps scoped package names intact while defusing the mention', () => {
    expect(neutralizeMentions('- `abc` [low] perf: stop parsing @linear/sdk at launch')).toBe(
      '- `abc` [low] perf: stop parsing `@linear/sdk` at launch'
    )
  })

  it('leaves tokens that are already code spans or e-mail addresses alone', () => {
    const markdown = 'see `@types/node`, mail a@b.com, bump @parcel/watcher'
    expect(neutralizeMentions(markdown)).toBe(
      'see `@types/node`, mail a@b.com, bump `@parcel/watcher`'
    )
  })

  it('is idempotent so republishing an unchanged report is a no-op', () => {
    const once = neutralizeMentions('thanks @someone for @linear/sdk')
    expect(neutralizeMentions(once)).toBe(once)
  })
})
