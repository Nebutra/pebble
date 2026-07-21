import { describe, expect, it } from 'vitest'

import { readTauriComputerActionEvent } from './tauri-computer-action-event'

describe('readTauriComputerActionEvent', () => {
  it('decodes the canonical runtime event envelope', () => {
    expect(
      readTauriComputerActionEvent({
        id: 'event-1',
        topic: 'computer.changed',
        data: JSON.stringify({
          version: 'pebble.events.v1',
          id: 'event-1',
          topic: 'computer.changed',
          payload: {
            id: 'action-1',
            kind: 'browser.goto',
            status: 'completed',
            result: { url: 'https://example.com' }
          }
        })
      })
    ).toMatchObject({ id: 'action-1', status: 'completed' })
  })

  it('rejects malformed, unrelated, and incomplete events', () => {
    expect(
      readTauriComputerActionEvent({ id: null, topic: 'browser.changed', data: '{}' })
    ).toBeNull()
    expect(
      readTauriComputerActionEvent({ id: null, topic: 'computer.changed', data: 'not-json' })
    ).toBeNull()
    expect(
      readTauriComputerActionEvent({
        id: null,
        topic: 'computer.changed',
        data: JSON.stringify({ payload: { id: 'missing-kind', status: 'completed' } })
      })
    ).toBeNull()
  })
})
