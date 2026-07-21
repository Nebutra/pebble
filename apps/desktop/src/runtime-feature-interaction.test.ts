import { describe, expect, it } from 'vitest'

import { runtimeFeatureInteractionId } from './runtime-feature-interaction'

describe('runtime feature interactions', () => {
  it.each([
    ['browser.goto', undefined, 'agent-browser-use'],
    ['computer.permissions', undefined, 'computer-use-setup'],
    ['computer.click', undefined, 'computer-use'],
    ['orchestration.taskCreate', undefined, 'agent-orchestration']
  ])('maps successful agent method %s', (method, params, expected) => {
    expect(runtimeFeatureInteractionId(method, params)).toBe(expected)
  })

  it.each([
    ['browser.profileCreate', undefined],
    ['browser.screencast.unsubscribe', undefined],
    ['browser.goto', { __pebbleFeatureInteractionSource: 'browser-pane-ui' }],
    ['computer.capabilities', undefined],
    ['computer.permissionsStatus', undefined],
    ['repo.list', undefined]
  ])('does not record excluded method %s', (method, params) => {
    expect(runtimeFeatureInteractionId(method, params)).toBeNull()
  })
})
