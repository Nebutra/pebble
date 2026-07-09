// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Landing from './Landing'

const mocks = vi.hoisted(() => ({
  popoverContentProps: [] as Array<Record<string, unknown>>,
  openModal: vi.fn(),
  checkPebbleStarred: vi.fn(),
  starPebble: vi.fn(),
  starNagComplete: vi.fn(),
  shellOpenUrl: vi.fn(),
  preflightCheck: vi.fn()
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
    mocks.popoverContentProps.push(props)
    return <div>{props.children}</div>
  }
}))

vi.mock('../store', () => ({
  useAppStore: (selector: (state: { repos: unknown[]; openModal: typeof mocks.openModal }) => unknown) =>
    selector({ repos: [], openModal: mocks.openModal })
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutKeyDetails: () => ({ keys: ['⌘', 'N'], doubleTap: false })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./landing-preflight-issues', () => ({
  getLandingPreflightIssues: () => [],
  hasGitHubBackedProject: () => false
}))

function setApi(): void {
  ;(window as unknown as { api: unknown }).api = {
    gh: {
      checkPebbleStarred: mocks.checkPebbleStarred,
      starPebble: mocks.starPebble
    },
    preflight: {
      check: mocks.preflightCheck
    },
    shell: {
      openUrl: mocks.shellOpenUrl
    },
    starNag: {
      complete: mocks.starNagComplete
    }
  }
}

describe('Landing star menu', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mocks.popoverContentProps.length = 0
    mocks.openModal.mockReset()
    mocks.checkPebbleStarred.mockResolvedValue(true)
    mocks.starPebble.mockResolvedValue(true)
    mocks.starNagComplete.mockResolvedValue(undefined)
    mocks.shellOpenUrl.mockResolvedValue(undefined)
    mocks.preflightCheck.mockResolvedValue({})
    setApi()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  it('opens the footer star menu upward and away from bottom chrome', () => {
    act(() => {
      root?.render(<Landing />)
    })

    const props = mocks.popoverContentProps[0]
    expect(props?.side).toBe('top')
    expect(props?.sideOffset).toBe(8)
    expect(props?.collisionPadding).toMatchObject({ bottom: 72 })
  })
})
