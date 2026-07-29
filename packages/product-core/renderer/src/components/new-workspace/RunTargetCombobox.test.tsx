// @vitest-environment happy-dom

import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RunTargetCombobox from './RunTargetCombobox'
import type {
  NeedsSetupProjectHostOption,
  ProjectHostSetupOption,
  ReadyProjectHostSetupOption
} from '@/lib/project-host-setup-options'

const localReadyHost: ReadyProjectHostSetupOption = {
  id: 'setup-local',
  kind: 'ready',
  projectId: 'project-1',
  hostId: 'local',
  repoId: 'repo-1',
  label: 'This computer',
  detail: '/repo',
  path: '/repo'
}

function needsSetupHost(
  overrides: Partial<NeedsSetupProjectHostOption> = {}
): NeedsSetupProjectHostOption {
  return {
    id: 'needs-setup:ssh:devbox',
    kind: 'needs-setup',
    projectId: 'project-1',
    hostId: 'ssh:devbox',
    label: 'Devbox',
    detail: 'Project not set up on this host',
    isAvailable: true,
    attention: false,
    ...overrides
  }
}

let current: { container: HTMLElement; root: Root } | null = null

function render(props: Partial<React.ComponentProps<typeof RunTargetCombobox>> = {}): HTMLElement {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <RunTargetCombobox
        hostOptions={[localReadyHost, needsSetupHost()]}
        hostValue="setup-local"
        recipes={[]}
        recipeValue={null}
        {...props}
      />
    )
  })
  current = { container, root }
  return container
}

function openPicker(container: HTMLElement): void {
  const shell = container.querySelector<HTMLElement>('div[data-run-target-combobox-root="true"]')
  expect(shell).toBeTruthy()
  act(() => shell?.click())
}

function findRow(label: string): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((row) =>
    row.textContent?.includes(label)
  )
}

function findConnectButton(label: string): HTMLButtonElement | undefined {
  return [...(findRow(label)?.querySelectorAll('button') ?? [])].find((button) =>
    button.textContent?.includes('Connect')
  ) as HTMLButtonElement | undefined
}

afterEach(() => {
  if (current) {
    const { root, container } = current
    act(() => root.unmount())
    container.remove()
    current = null
  }
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('RunTargetCombobox', () => {
  it('lists hosts that still need setup alongside ready ones', () => {
    const container = render()

    openPicker(container)

    expect(findRow('This computer')).toBeTruthy()
    expect(findRow('Devbox')).toBeTruthy()
  })

  it('does not select a host that still needs setup', () => {
    const onHostChange = vi.fn()
    const container = render({ onHostChange })

    openPicker(container)
    act(() => findRow('Devbox')?.click())

    // Why: the workspace can't run there yet, so committing the row would put the
    // composer into a state the create action cannot satisfy.
    expect(onHostChange).not.toHaveBeenCalled()
  })

  it('connects a disconnected host without selecting it', async () => {
    const onConnectHost = vi.fn().mockResolvedValue(undefined)
    const onHostChange = vi.fn()
    const container = render({
      hostOptions: [
        localReadyHost,
        needsSetupHost({ connectAction: { kind: 'ssh', targetId: 'devbox' } })
      ] as ProjectHostSetupOption[],
      onConnectHost,
      onHostChange
    })

    openPicker(container)
    const connectButton = findConnectButton('Devbox')
    expect(connectButton).toBeTruthy()
    await act(async () => {
      connectButton?.click()
    })

    expect(onConnectHost).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: 'ssh:devbox', kind: 'needs-setup' })
    )
    expect(onHostChange).not.toHaveBeenCalled()
    // Why: the picker stays open so the connecting state stays visible.
    expect(findRow('Devbox')).toBeTruthy()
  })

  it('keeps other hosts connectable while one connect is still in flight', async () => {
    // Why: a stalled connect must not lock out connecting to a different host.
    const onConnectHost = vi
      .fn()
      .mockImplementation((option: NeedsSetupProjectHostOption) =>
        option.hostId === 'ssh:devbox' ? new Promise(() => {}) : Promise.resolve(undefined)
      )
    const container = render({
      hostOptions: [
        localReadyHost,
        needsSetupHost({ connectAction: { kind: 'ssh', targetId: 'devbox' } }),
        needsSetupHost({
          id: 'needs-setup:ssh:bastion',
          hostId: 'ssh:bastion',
          label: 'Bastion',
          connectAction: { kind: 'ssh', targetId: 'bastion' }
        })
      ] as ProjectHostSetupOption[],
      onConnectHost
    })

    openPicker(container)
    await act(async () => {
      findConnectButton('Devbox')?.click()
    })

    expect(findConnectButton('Devbox')?.disabled).toBe(true)
    expect(findConnectButton('Bastion')?.disabled).toBe(false)
  })

  it('re-enables the Connect action after a failed connect', async () => {
    const onConnectHost = vi.fn().mockRejectedValue(new Error('connection refused'))
    const container = render({
      hostOptions: [
        localReadyHost,
        needsSetupHost({ connectAction: { kind: 'ssh', targetId: 'devbox' } })
      ] as ProjectHostSetupOption[],
      onConnectHost
    })

    openPicker(container)
    await act(async () => {
      findConnectButton('Devbox')?.click()
    })

    const button = findConnectButton('Devbox')
    expect(button?.disabled).toBe(false)
    expect(button?.textContent).toContain('Connect')
    expect(button?.textContent).not.toContain('Connecting')
  })

  it('offers the add-host choices from a pinned row', () => {
    const onAddSshHost = vi.fn()
    const onAddRemoteServer = vi.fn()
    const container = render({ onAddSshHost, onAddRemoteServer })

    openPicker(container)
    const addHost = findRow('Add host')
    expect(addHost).toBeTruthy()
    // Hovering a row opens its submenu, so it behaves like a menu rather than
    // needing a click first.
    act(() => {
      addHost?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    })

    expect(findRow('Add SSH host')).toBeTruthy()
    expect(findRow('Add remote server')).toBeTruthy()

    act(() => findRow('Add SSH host')?.click())
    expect(onAddSshHost).toHaveBeenCalled()
  })
})
