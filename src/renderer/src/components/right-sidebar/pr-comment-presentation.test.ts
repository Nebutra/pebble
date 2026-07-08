// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PR_COMMENT_PRESENTATION_VARIANT,
  getPRCommentPresentationClasses,
  resolvePRCommentPresentationVariant
} from './pr-comment-presentation'

describe('pr-comment-presentation', () => {
  beforeEach(() => {
    const storage = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => {
          storage.delete(key)
        },
        setItem: (key: string, value: string) => {
          storage.set(key, value)
        }
      }
    })
  })

  it('defaults to cards layout', () => {
    expect(DEFAULT_PR_COMMENT_PRESENTATION_VARIANT).toBe('cards')
  })

  it('returns card layout tokens for cards and focus variants', () => {
    const cards = getPRCommentPresentationClasses('cards')
    expect(cards.useCardLayout).toBe(true)
    expect(cards.commentBody).toContain('text-xs')
    expect(cards.commentBody).toContain('leading-5')
    expect(cards.commentBody).toContain('text-foreground')
    expect(cards.group).toContain('bg-secondary')
    expect(cards.group).toContain('shadow-xs')
    expect(cards.avatar).toContain('border-border')
    expect(cards.avatar).toContain('bg-background')

    const focus = getPRCommentPresentationClasses('focus')
    expect(focus.useCardLayout).toBe(true)
    expect(focus.commentBody).toContain('text-xs')
    expect(focus.commentBody).toContain('leading-5')
    expect(focus.commentBodyReply).toContain('text-xs')
    expect(focus.commentBodyReply).toContain('leading-5')
    expect(focus.author).toContain('text-[13px]')
    expect(focus.list).toContain('gap-2')
    expect(focus.commentBody).toContain('px-4 py-2.5')
    expect(focus.commentBodyReply).toContain('px-4 py-2.5')
    expect(focus.commentHeader).toContain('px-3 py-2')
    expect(focus.commentHeaderReply).toContain('px-3 py-2')
    expect(focus.commentHeaderMeta).toContain('pl-7')
    expect(focus.commentHeaderMetaWithSelection).toContain('pl-[3.25rem]')
  })

  it('preserves the legacy flat layout tokens', () => {
    const flat = getPRCommentPresentationClasses('flat')
    expect(flat.useCardLayout).toBe(false)
    expect(flat.commentBody).toContain('text-muted-foreground')
    expect(flat.commentBody).toContain('text-[11px]')
  })

  it('falls back to the default variant when localStorage is unset', () => {
    window.localStorage.removeItem('pebble:pr-comment-presentation')
    expect(resolvePRCommentPresentationVariant()).toBe(DEFAULT_PR_COMMENT_PRESENTATION_VARIANT)
  })

})
