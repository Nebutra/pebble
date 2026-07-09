import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/menu', () => ({
  Menu: {
    new: vi.fn()
  }
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: vi.fn(() => ({ setZoom: vi.fn() }))
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    isFullscreen: vi.fn(() => Promise.resolve(false)),
    setFullscreen: vi.fn()
  }))
}))

import { Menu } from '@tauri-apps/api/menu'
import type { KeybindingOverrides } from '../../../src/shared/keybindings'
import { buildTauriMenuTemplate, installTauriMenuApi } from './tauri-menu-api'

type TestMenuItem = {
  text?: string
  accelerator?: string
  items?: TestMenuItem[]
}

describe('buildTauriMenuTemplate', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
    })
    vi.stubGlobal('window', {
      api: {
        settings: {
          get: vi.fn(() =>
            Promise.resolve({
              showTasksButton: true,
              showAutomationsButton: true,
              showMobileButton: true,
              showTitlebarAppName: true
            })
          ),
          set: vi.fn()
        },
        ui: {
          get: vi.fn(() => Promise.resolve({ statusBarVisible: true })),
          set: vi.fn()
        },
        updater: {
          check: vi.fn()
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows policy-routed shortcuts as menu hints without native accelerators', async () => {
    const menu = (await buildTauriMenuTemplate()) as TestMenuItem[]
    const appMenu = getSubmenu(menu, 'Pebble')
    const viewMenu = getSubmenu(menu, 'View')
    const appearanceMenu = getSubmenu(viewMenu, 'Appearance')

    expect(findMenuItem(appMenu, 'Settings\t⌘,')?.accelerator).toBeUndefined()
    expect(findMenuItem(viewMenu, 'Reload')?.accelerator).toBeUndefined()
    expect(findMenuItem(viewMenu, 'Force Reload\t⌘⇧R')?.accelerator).toBeUndefined()
    expect(findMenuItem(viewMenu, 'Reset Size\t⌘0')?.accelerator).toBeUndefined()
    expect(findMenuItemStartingWith(viewMenu, 'Zoom In\t')?.accelerator).toBeUndefined()
    expect(findMenuItemStartingWith(viewMenu, 'Zoom Out\t')?.accelerator).toBeUndefined()
    expect(findMenuItem(viewMenu, 'Open Worktree Palette\t⌘J')?.accelerator).toBeUndefined()
    expect(findMenuItem(appearanceMenu, 'Toggle Left Sidebar\t⌘B')?.accelerator).toBeUndefined()
    expect(findMenuItem(appearanceMenu, 'Toggle Right Sidebar\t⌘L')?.accelerator).toBeUndefined()
  })

  it('keeps Edit > Paste as the coordinated paste accelerator', async () => {
    const menu = (await buildTauriMenuTemplate()) as TestMenuItem[]
    const editMenu = getSubmenu(menu, 'Edit')

    expect(findMenuItem(editMenu, 'Paste')?.accelerator).toBe('CmdOrCtrl+V')
  })

  it('uses keybinding overrides in display-only menu hints', async () => {
    const overrides: KeybindingOverrides = {
      'zoom.in': ['Mod+Alt+Z'],
      'zoom.out': []
    }
    const menu = (await buildTauriMenuTemplate(overrides)) as TestMenuItem[]
    const viewMenu = getSubmenu(menu, 'View')

    expect(findMenuItem(viewMenu, 'Zoom In\t⌘⌥Z')?.accelerator).toBeUndefined()
    expect(findMenuItem(viewMenu, 'Zoom Out\tUnassigned')?.accelerator).toBeUndefined()
  })
})

describe('installTauriMenuApi window shortcuts', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('routes Tauri keydown events through Electron-compatible UI callbacks', async () => {
    const reload = vi.fn()
    const keydownListeners: Array<(event: TestKeyboardEvent) => void> = []
    vi.mocked(Menu.new).mockResolvedValue({
      setAsAppMenu: vi.fn(() => Promise.resolve()),
      popup: vi.fn(() => Promise.resolve())
    } as never)
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
    })
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: {},
      location: { reload },
      addEventListener: vi.fn((type: string, listener: (event: TestKeyboardEvent) => void) => {
        if (type === 'keydown') {
          keydownListeners.push(listener)
        }
      }),
      removeEventListener: vi.fn(),
      api: {
        settings: {
          get: vi.fn(() =>
            Promise.resolve({
              terminalShortcutPolicy: 'pebble-first',
              voice: { enabled: true, sttModel: 'whisper-1', dictationMode: 'toggle' },
              showTasksButton: true,
              showAutomationsButton: true,
              showMobileButton: true,
              showTitlebarAppName: true
            })
          ),
          set: vi.fn(),
          onChanged: vi.fn(() => () => {})
        },
        keybindings: {
          get: vi.fn(() => Promise.resolve({ overrides: {} })),
          onChanged: vi.fn(() => () => {})
        },
        ui: {
          get: vi.fn(() => Promise.resolve({ statusBarVisible: true })),
          set: vi.fn()
        },
        updater: {
          check: vi.fn()
        }
      }
    })

    installTauriMenuApi()
    await flushAsync()

    const openSettings = vi.fn()
    const openQuickOpen = vi.fn()
    const terminalZoom = vi.fn()
    const worktreePalette = vi.fn()
    const terminalShortcutCaptured = vi.fn()
    window.api.ui.onOpenSettings(openSettings)
    window.api.ui.onOpenQuickOpen(openQuickOpen)
    window.api.ui.onTerminalZoom(terminalZoom)
    window.api.ui.onToggleWorktreePalette(worktreePalette)
    window.api.ui.onTerminalShortcutCaptured(terminalShortcutCaptured)

    emitKeydown(keydownListeners, { key: ',', code: 'Comma', metaKey: true })
    emitKeydown(keydownListeners, { key: 'p', code: 'KeyP', metaKey: true })
    emitKeydown(keydownListeners, { key: '=', code: 'Equal', metaKey: true })
    emitKeydown(keydownListeners, { key: 'R', code: 'KeyR', metaKey: true, shiftKey: true })
    emitKeydown(keydownListeners, {
      key: 'j',
      code: 'KeyJ',
      metaKey: true,
      target: terminalTarget()
    })

    expect(openSettings).toHaveBeenCalledTimes(1)
    expect(openQuickOpen).toHaveBeenCalledTimes(1)
    expect(terminalZoom).toHaveBeenCalledWith('in')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(worktreePalette).toHaveBeenCalledTimes(1)
    expect(terminalShortcutCaptured).toHaveBeenCalledWith({ actionId: 'worktree.palette' })
  })
})

function getSubmenu(items: TestMenuItem[], text: string): TestMenuItem[] {
  const item = findMenuItem(items, text)
  if (!item?.items) {
    throw new Error(`Missing submenu: ${text}`)
  }
  return item.items
}

function findMenuItem(items: TestMenuItem[], text: string): TestMenuItem | undefined {
  return items.find((item) => item.text === text)
}

function findMenuItemStartingWith(items: TestMenuItem[], text: string): TestMenuItem | undefined {
  return items.find((item) => item.text?.startsWith(text) === true)
}

type TestKeyboardEvent = {
  key: string
  code: string
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  repeat: boolean
  target: EventTarget | null
  readonly defaultPrevented: boolean
  preventDefault: () => void
}

function emitKeydown(
  listeners: Array<(event: TestKeyboardEvent) => void>,
  input: Partial<TestKeyboardEvent> & Pick<TestKeyboardEvent, 'key' | 'code'>
): TestKeyboardEvent {
  let defaultPrevented = false
  const event = {
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    repeat: false,
    target: null,
    ...input,
    get defaultPrevented() {
      return defaultPrevented
    },
    preventDefault: vi.fn(() => {
      defaultPrevented = true
    })
  }
  for (const listener of listeners) {
    listener(event)
  }
  expect(event.preventDefault).toHaveBeenCalled()
  return event
}

function terminalTarget(): EventTarget {
  return {
    classList: { contains: (className: string) => className === 'xterm-helper-textarea' },
    closest: () => null
  } as never
}

async function flushAsync(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
