import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  latestSessionConversationTurn,
  recentSessionConversationTurns,
  sessionDetailConversationTurns,
  sessionFirstPrompt,
  sessionFirstPromptBeyondTitle,
  sessionPreviewSearchText
} from './ai-vault-session-display'

const baseSession: AiVaultSession = {
  id: 'codex:1',
  executionHostId: 'local',
  agent: 'codex',
  sessionId: 'session-1',
  title: 'Fix the flaky golden tests',
  cwd: '/Users/ada/repo/app',
  branch: 'fix/golden',
  model: 'gpt-5.5',
  filePath: '/Users/ada/.codex/sessions/session-1.jsonl',
  codexHome: null,
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-01T10:10:00.000Z',
  modifiedAt: '2026-05-01T10:10:00.000Z',
  messageCount: 4,
  totalTokens: 1200,
  previewMessages: [
    { role: 'user', text: 'Please fix the flaky golden tests', timestamp: null },
    { role: 'tool', text: 'pnpm test failed', timestamp: null },
    { role: 'assistant', text: 'I updated the fixture ordering', timestamp: null },
    { role: 'system', text: 'hidden runtime bookkeeping', timestamp: null }
  ],
  resumeCommand: "cd '/Users/ada/repo/app' && codex resume 'session-1'"
}

describe('ai vault session display', () => {
  it('uses the latest user or assistant turn for the collapsed row preview', () => {
    expect(latestSessionConversationTurn(baseSession)).toEqual({
      role: 'assistant',
      text: 'I updated the fixture ordering',
      timestamp: null
    })
  })

  it('keeps recent turns conversation-first and falls back when no conversation turns exist', () => {
    expect(recentSessionConversationTurns(baseSession, 2).map((turn) => turn.text)).toEqual([
      'Please fix the flaky golden tests',
      'I updated the fixture ordering'
    ])

    expect(
      recentSessionConversationTurns(
        {
          ...baseSession,
          previewMessages: [{ role: 'tool', text: 'tool-only transcript', timestamp: null }]
        },
        1
      )
    ).toEqual([{ role: 'tool', text: 'tool-only transcript', timestamp: null }])
  })

  it('builds search text from displayed preview messages', () => {
    expect(sessionPreviewSearchText(baseSession)).toContain('fixture ordering')
    expect(sessionPreviewSearchText(baseSession)).not.toContain('pnpm test failed')
    expect(sessionPreviewSearchText(baseSession)).not.toContain('hidden runtime bookkeeping')
  })

  it('searches fallback tool text when no conversation turns exist', () => {
    expect(
      sessionPreviewSearchText({
        ...baseSession,
        previewMessages: [{ role: 'tool', text: 'tool-only transcript', timestamp: null }]
      })
    ).toBe('tool-only transcript')
  })

  it('drops title-matching turns and adjacent duplicates from detail turns', () => {
    const session: AiVaultSession = {
      ...baseSession,
      title: 'Fix the flaky golden tests',
      previewMessages: [
        { role: 'user', text: 'Fix the flaky golden tests', timestamp: null },
        { role: 'assistant', text: 'I updated the fixture ordering', timestamp: null },
        { role: 'assistant', text: 'I updated the fixture ordering', timestamp: null },
        { role: 'assistant', text: 'Added a regression test', timestamp: null }
      ]
    }

    expect(sessionDetailConversationTurns(session, 3).map((turn) => turn.text)).toEqual([
      'I updated the fixture ordering',
      'Added a regression test'
    ])
  })

  it('prefers the scanned first prompt over a preview window that already slid past it', () => {
    expect(
      sessionFirstPrompt({
        ...baseSession,
        firstUserPrompt: 'Port the updater readiness probe',
        previewMessages: [
          { role: 'user', text: 'And now rename the pane', timestamp: null },
          { role: 'assistant', text: 'Renamed', timestamp: null }
        ]
      })
    ).toBe('Port the updater readiness probe')
  })

  it('falls back to the earliest user preview turn for a host that sent no first prompt', () => {
    expect(sessionFirstPrompt(baseSession)).toBe('Please fix the flaky golden tests')
  })

  it('reports no first prompt when nothing the user wrote survives', () => {
    expect(sessionFirstPrompt({ ...baseSession, previewMessages: [] })).toBeNull()
    expect(
      sessionFirstPrompt({
        ...baseSession,
        firstUserPrompt: '   ',
        previewMessages: [{ role: 'assistant', text: 'Only agent text', timestamp: null }]
      })
    ).toBeNull()
  })

  it('carries a single-line ask through unchanged and keeps a long one whole', () => {
    const longAsk = `Rewrite ${'the pane reuse path '.repeat(10)}without dropping status`
    expect(sessionFirstPrompt({ ...baseSession, firstUserPrompt: 'Rename the pane' })).toBe(
      'Rename the pane'
    )
    expect(sessionFirstPrompt({ ...baseSession, firstUserPrompt: longAsk })).toBe(longAsk)
  })

  it('hides the row line when the title already says what the first ask says', () => {
    expect(
      sessionFirstPromptBeyondTitle({
        ...baseSession,
        title: 'Fix the flaky golden tests',
        firstUserPrompt: 'Fix the flaky golden tests'
      })
    ).toBeNull()
    expect(
      sessionFirstPromptBeyondTitle({
        ...baseSession,
        title: 'Fix the flaky golden tests in the renderer suite',
        firstUserPrompt: 'Fix the flaky golden tests in the renderer suite before release'
      })
    ).toBeNull()
  })

  it('shows the row line when the title came from the transcript instead of the ask', () => {
    expect(
      sessionFirstPromptBeyondTitle({
        ...baseSession,
        title: 'Golden test triage',
        firstUserPrompt: 'Fix the flaky golden tests'
      })
    ).toBe('Fix the flaky golden tests')
  })
})
