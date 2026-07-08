import { describe, expect, it } from 'vitest'
import { summarizeSkillMarkdown } from './skill-metadata'

describe('summarizeSkillMarkdown', () => {
  it('reads name and folded description from YAML frontmatter', () => {
    const summary = summarizeSkillMarkdown(`---
name: pebble-cli
description: >-
  Use the pebble CLI to drive a running editor;
  keep worktree comments current.
---

# Pebble CLI
`)

    expect(summary).toEqual({
      name: 'pebble-cli',
      description: 'Use the pebble CLI to drive a running editor; keep worktree comments current.'
    })
  })

  it('falls back to heading and first paragraph when frontmatter is absent', () => {
    const summary = summarizeSkillMarkdown(`# Design Review

Use when reviewing UI implementation quality.
`)

    expect(summary).toEqual({
      name: 'Design Review',
      description: 'Use when reviewing UI implementation quality.'
    })
  })
})
