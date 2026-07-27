import { describe, expect, it } from 'vitest'

import { classifyPath, renderMarkdown } from './upstream-semantic-sync.mjs'

const policy = {
  rules: [
    { prefixes: ['skills/'], area: 'skills', risk: 'low' },
    { prefixes: ['src/main/'], area: 'desktop-host', risk: 'high' }
  ],
  fallback: { area: 'unclassified', risk: 'high' }
}

describe('upstream semantic sync', () => {
  it('classifies architecture-specific paths as high risk', () => {
    expect(classifyPath('skills/example/SKILL.md', policy)).toEqual({
      area: 'skills',
      risk: 'low'
    })
    expect(classifyPath('src/main/window.ts', policy)).toEqual({
      area: 'desktop-host',
      risk: 'high'
    })
    expect(classifyPath('unknown/file.ts', policy)).toEqual({
      area: 'unclassified',
      risk: 'high'
    })
  })

  it('renders an empty idempotent range clearly', () => {
    const markdown = renderMarkdown({
      range: { from: 'a', to: 'b' },
      summary: { commitCount: 0, changedPathCount: 0, risks: { low: 0, medium: 0, high: 0 } },
      commits: []
    })
    expect(markdown).toMatch(/No new upstream commits/)
    expect(markdown).toMatch(/merging is always manual/)
  })
})
