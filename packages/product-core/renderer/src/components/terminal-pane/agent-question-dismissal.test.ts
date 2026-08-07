import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AgentInterruptInferenceRequest } from '../../../../shared/agent-interrupt-intent'
import { resolveDismissedQuestionStatus } from './agent-question-dismissal'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const NOW = 1_100

function makeEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'waiting',
    prompt: 'write tests',
    updatedAt: 1_000,
    stateStartedAt: 900,
    agentType: 'claude',
    paneKey: PANE_KEY,
    toolName: 'AskUserQuestion',
    interactivePrompt: '{"questions":[{"question":"Pick one"}]}',
    stateHistory: [],
    ...overrides
  }
}

function makeRequest(
  overrides: Partial<AgentInterruptInferenceRequest> = {}
): AgentInterruptInferenceRequest {
  return {
    paneKey: PANE_KEY,
    baselineUpdatedAt: 1_000,
    baselineStateStartedAt: 900,
    baselinePrompt: 'write tests',
    baselineAgentType: 'claude',
    intent: 'plain-escape',
    ...overrides
  }
}

describe('resolveDismissedQuestionStatus', () => {
  it.each(['AskUserQuestion', 'ask_user_question', 'askUserQuestion'])(
    'clears a %s wait back to working',
    (toolName) => {
      const resolved = resolveDismissedQuestionStatus({
        entry: makeEntry({ toolName }),
        request: makeRequest(),
        now: NOW
      })

      expect(resolved).toEqual({ state: 'working', prompt: 'write tests', agentType: 'claude' })
      expect(resolved?.toolName).toBeUndefined()
      expect(resolved?.interactivePrompt).toBeUndefined()
      expect(resolved?.interrupted).toBeUndefined()
    }
  )

  it.each([
    ['a missing entry', undefined],
    ['a non-question tool', makeEntry({ toolName: 'Bash' })],
    ['another agent', makeEntry({ agentType: 'codex' })],
    ['a working row', makeEntry({ state: 'working' })],
    ['a blocked row', makeEntry({ state: 'blocked' })]
  ] as const)('returns null for %s', (_label, entry) => {
    expect(resolveDismissedQuestionStatus({ entry, request: makeRequest(), now: NOW })).toBeNull()
  })

  it('returns null for Ctrl+C', () => {
    const resolved = resolveDismissedQuestionStatus({
      entry: makeEntry(),
      request: makeRequest({ intent: 'ctrl-c' }),
      now: NOW
    })

    expect(resolved).toBeNull()
  })

  it.each([
    ['updatedAt', { baselineUpdatedAt: 1 }],
    ['stateStartedAt', { baselineStateStartedAt: 1 }],
    ['prompt', { baselinePrompt: 'something else' }]
  ] as const)('returns null when the baseline %s drifted', (_label, overrides) => {
    const resolved = resolveDismissedQuestionStatus({
      entry: makeEntry(),
      request: makeRequest(overrides),
      now: NOW
    })

    expect(resolved).toBeNull()
  })

  it('returns null once the wait is stale', () => {
    const resolved = resolveDismissedQuestionStatus({
      entry: makeEntry(),
      request: makeRequest(),
      now: 1_000 + 30 * 60 * 1000 + 1
    })

    expect(resolved).toBeNull()
  })
})
