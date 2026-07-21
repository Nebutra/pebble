import { describe, expect, it } from 'vitest'
import { parseShellArguments } from './shell-argument-parser'

describe('parseShellArguments', () => {
  it('preserves quoted whitespace, empty values, and escapes', () => {
    expect(parseShellArguments(`fill @e1 "hello world" '' a\\ b`)).toEqual([
      'fill',
      '@e1',
      'hello world',
      '',
      'a b'
    ])
  })

  it('rejects unterminated quotes and escapes', () => {
    expect(() => parseShellArguments(`fill @e1 "broken`)).toThrow('unterminated quote')
    expect(() => parseShellArguments('type trailing\\')).toThrow('unterminated quote')
  })
})
