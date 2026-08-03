import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/types'
import {
  resolveRepairedActiveTerminalTabId,
  shouldRepairActiveTerminalTab
} from './active-terminal-repair'

function tab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'wt-1',
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('shouldRepairActiveTerminalTab', () => {
  it('does not repair while editor or browser content is active', () => {
    expect(
      shouldRepairActiveTerminalTab({
        activeTabType: 'editor',
        activeTabId: 'missing',
        tabs: [tab('cli-terminal')]
      })
    ).toBe(false)
    expect(
      shouldRepairActiveTerminalTab({
        activeTabType: 'browser',
        activeTabId: null,
        tabs: [tab('cli-terminal')]
      })
    ).toBe(false)
  })

  it('repairs stale terminal active ids only while terminal content is active', () => {
    expect(
      shouldRepairActiveTerminalTab({
        activeTabType: 'terminal',
        activeTabId: 'missing',
        tabs: [tab('terminal-1')]
      })
    ).toBe(true)
    expect(
      shouldRepairActiveTerminalTab({
        activeTabType: 'terminal',
        activeTabId: 'terminal-1',
        tabs: [tab('terminal-1')]
      })
    ).toBe(false)
  })
})

describe('resolveRepairedActiveTerminalTabId', () => {
  it('prefers the remembered per-worktree tab over the first tab', () => {
    expect(
      resolveRepairedActiveTerminalTabId({
        activeTabType: 'terminal',
        activeTabId: 'missing',
        rememberedTabId: 'terminal-2',
        tabs: [tab('terminal-1'), tab('terminal-2')]
      })
    ).toBe('terminal-2')
  })

  it('falls back to the first tab when memory is missing or foreign', () => {
    expect(
      resolveRepairedActiveTerminalTabId({
        activeTabType: 'terminal',
        activeTabId: 'missing',
        rememberedTabId: 'gone',
        tabs: [tab('terminal-1'), tab('terminal-2')]
      })
    ).toBe('terminal-1')
  })

  it('returns null when no repair is needed', () => {
    expect(
      resolveRepairedActiveTerminalTabId({
        activeTabType: 'terminal',
        activeTabId: 'terminal-1',
        rememberedTabId: null,
        tabs: [tab('terminal-1')]
      })
    ).toBeNull()
  })
})
