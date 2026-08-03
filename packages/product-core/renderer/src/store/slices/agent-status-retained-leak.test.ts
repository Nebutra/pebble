/**
 * Memory-leak regression: retainedAgentsByPaneKey must stay bounded (upstream #7528).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import type { RetainedAgentEntry } from './agent-status'
import { createTestStore } from './store-test-helpers'

const MAX_RETAINED_AGENTS = 500

function makeRetained(index: number, worktreeId = 'wt-x'): RetainedAgentEntry {
  const paneKey = `tab-${index}:leaf-${index}`
  const entry: AgentStatusEntry = {
    state: 'done',
    prompt: `prompt ${index}`,
    updatedAt: index,
    stateStartedAt: index,
    paneKey,
    stateHistory: []
  }
  return {
    entry,
    worktreeId,
    tab: { id: `tab-${index}`, title: 'claude' } as unknown as TerminalTab,
    agentType: 'claude',
    startedAt: index
  }
}

describe('retainedAgentsByPaneKey stays bounded (leak regression)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('caps retainedAgentsByPaneKey and keeps the most recently retained keys', () => {
    const store = createTestStore()
    const total = MAX_RETAINED_AGENTS + 200
    for (let i = 0; i < total; i++) {
      store.getState().retainAgents([makeRetained(i)])
    }

    const retained = store.getState().retainedAgentsByPaneKey
    expect(Object.keys(retained)).toHaveLength(MAX_RETAINED_AGENTS)
    expect(retained[`tab-${total - 1}:leaf-${total - 1}`]).toBeDefined()
    expect(retained['tab-0:leaf-0']).toBeUndefined()
  })

  it('caps even when many completions are retained in a single batch', () => {
    const store = createTestStore()
    const total = MAX_RETAINED_AGENTS + 50
    store.getState().retainAgents(Array.from({ length: total }, (_, i) => makeRetained(i)))

    const retained = store.getState().retainedAgentsByPaneKey
    expect(Object.keys(retained)).toHaveLength(MAX_RETAINED_AGENTS)
    expect(retained[`tab-${total - 1}:leaf-${total - 1}`]).toBeDefined()
    expect(retained['tab-0:leaf-0']).toBeUndefined()
  })

  it('does not evict anything while under the cap', () => {
    const store = createTestStore()
    for (let i = 0; i < MAX_RETAINED_AGENTS; i++) {
      store.getState().retainAgents([makeRetained(i)])
    }
    const retained = store.getState().retainedAgentsByPaneKey
    expect(Object.keys(retained)).toHaveLength(MAX_RETAINED_AGENTS)
    expect(retained['tab-0:leaf-0']).toBeDefined()
  })

  it('re-retaining an existing paneKey overwrites in place and never grows the count', () => {
    const store = createTestStore()
    store.getState().retainAgents([makeRetained(0)])
    const updated = makeRetained(0)
    updated.entry.prompt = 'updated'
    store.getState().retainAgents([updated])

    const retained = store.getState().retainedAgentsByPaneKey
    expect(Object.keys(retained)).toHaveLength(1)
    expect(retained['tab-0:leaf-0'].entry.prompt).toBe('updated')
  })
})
