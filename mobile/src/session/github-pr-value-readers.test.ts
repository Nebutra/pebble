import { describe, expect, it } from 'vitest'
import { readRepoIdentity } from './github-pr-value-readers'

describe('readRepoIdentity', () => {
  it('parses a valid owner/repo identity', () => {
    expect(readRepoIdentity({ owner: 'octo', repo: 'pebble' })).toEqual({
      owner: 'octo',
      repo: 'pebble'
    })
  })

  it('drops a non-record value', () => {
    expect(readRepoIdentity(null)).toBeUndefined()
    expect(readRepoIdentity('octo/pebble')).toBeUndefined()
  })

  it('drops a missing owner or repo', () => {
    expect(readRepoIdentity({ repo: 'pebble' })).toBeUndefined()
    expect(readRepoIdentity({ owner: 'octo' })).toBeUndefined()
  })

  it('drops an empty owner or repo as malformed', () => {
    expect(readRepoIdentity({ owner: '', repo: 'pebble' })).toBeUndefined()
    expect(readRepoIdentity({ owner: 'octo', repo: '' })).toBeUndefined()
  })
})
