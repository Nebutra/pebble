import {
  Menu,
  type CheckMenuItemOptions,
  type MenuItemOptions,
  type PredefinedMenuItemOptions,
  type SubmenuOptions
} from '@tauri-apps/api/menu'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'

import type { PreloadApi } from '../../../src/preload/api-types'
import { buildTauriAppearanceMenuItems } from './tauri-appearance-menu-state'
import { PRODUCT_NAME } from './product-brand'

type EmptyUiEvent =
  | 'openSettings'
  | 'openSetupGuide'
  | 'openFeatureTour'
  | 'openCrashReport'
  | 'toggleLeftSidebar'
  | 'toggleRightSidebar'
  | 'toggleWorktreePalette'
  | 'appMenuPaste'

type ZoomDirection = 'in' | 'out' | 'reset'
type TauriMenuEntry =
  | SubmenuOptions
  | MenuItemOptions
  | PredefinedMenuItemOptions
  | CheckMenuItemOptions

const emptyUiEventListeners = new Map<EmptyUiEvent, Set<() => void>>()
const terminalZoomListeners = new Set<(direction: ZoomDirection) => void>()
let tauriMenu: Menu | null = null
let pendingTauriMenu: Promise<Menu> | null = null
let tauriZoomLevel = 0

export function installTauriMenuApi(): void {
  if (!hasTauriInternals()) {
    return
  }

  const base = window.api.ui
  window.api.ui = {
    ...base,
    getZoomLevel: () => tauriZoomLevel,
    setZoomLevel: (level) => {
      tauriZoomLevel = level
      void getCurrentWebview().setZoom(Math.pow(1.2, level))
    },
    onOpenSettings: subscribeEmptyUiEvent('openSettings'),
    onOpenSetupGuide: subscribeEmptyUiEvent('openSetupGuide'),
    onOpenFeatureTour: subscribeEmptyUiEvent('openFeatureTour'),
    onOpenCrashReport: subscribeEmptyUiEvent('openCrashReport'),
    onToggleLeftSidebar: subscribeEmptyUiEvent('toggleLeftSidebar'),
    onToggleRightSidebar: subscribeEmptyUiEvent('toggleRightSidebar'),
    onToggleWorktreePalette: subscribeEmptyUiEvent('toggleWorktreePalette'),
    onAppMenuPaste: subscribeEmptyUiEvent('appMenuPaste'),
    onTerminalZoom: subscribeTerminalZoom,
    popupMenu: () => {
      void popupTauriMenu()
    }
  } satisfies PreloadApi['ui']

  void installTauriApplicationMenu()
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function subscribeEmptyUiEvent(event: EmptyUiEvent): (callback: () => void) => () => void {
  return (callback) => {
    const listeners = getEmptyUiEventListeners(event)
    listeners.add(callback)
    return () => {
      listeners.delete(callback)
    }
  }
}

function getEmptyUiEventListeners(event: EmptyUiEvent): Set<() => void> {
  const existing = emptyUiEventListeners.get(event)
  if (existing) {
    return existing
  }
  const created = new Set<() => void>()
  emptyUiEventListeners.set(event, created)
  return created
}

function emitEmptyUiEvent(event: EmptyUiEvent): void {
  for (const listener of getEmptyUiEventListeners(event)) {
    listener()
  }
}

function subscribeTerminalZoom(callback: (direction: ZoomDirection) => void): () => void {
  terminalZoomListeners.add(callback)
  return () => {
    terminalZoomListeners.delete(callback)
  }
}

function emitTerminalZoom(direction: ZoomDirection): void {
  for (const listener of terminalZoomListeners) {
    listener(direction)
  }
}

async function installTauriApplicationMenu(): Promise<void> {
  const menu = await getTauriMenu()
  await menu.setAsAppMenu()
}

async function popupTauriMenu(): Promise<void> {
  const menu = await getTauriMenu()
  await menu.popup(undefined, getCurrentWindow())
}

async function getTauriMenu(): Promise<Menu> {
  if (tauriMenu) {
    return tauriMenu
  }
  if (!pendingTauriMenu) {
    pendingTauriMenu = createTauriMenu().then((menu) => {
      tauriMenu = menu
      pendingTauriMenu = null
      return menu
    })
  }
  return pendingTauriMenu
}

async function createTauriMenu(): Promise<Menu> {
  return Menu.new({ items: await buildTauriMenuTemplate() })
}

async function rebuildTauriApplicationMenu(): Promise<void> {
  pendingTauriMenu = null
  tauriMenu = await createTauriMenu()
  await tauriMenu.setAsAppMenu()
}

async function buildTauriMenuTemplate(): Promise<SubmenuOptions[]> {
  const isMac = navigator.userAgent.includes('Mac')
  return [
    ...(isMac ? [buildMacAppMenu()] : []),
    ...(isMac ? [] : [buildFileMenu()]),
    buildEditMenu(),
    await buildViewMenu(),
    buildWindowMenu(),
    buildHelpMenu()
  ]
}

function buildMacAppMenu(): SubmenuOptions {
  return submenu(PRODUCT_NAME, [
    aboutItem(),
    menuItem('Check for Updates...', () => {
      void window.api.updater.check({})
    }),
    separator(),
    menuItem('Settings', () => emitEmptyUiEvent('openSettings'), 'CmdOrCtrl+,'),
    separator(),
    predefined('Services'),
    separator(),
    predefined('Hide'),
    predefined('HideOthers'),
    predefined('ShowAll'),
    separator(),
    predefined('Quit')
  ])
}

function buildFileMenu(): SubmenuOptions {
  return submenu('File', [
    menuItem('Settings', () => emitEmptyUiEvent('openSettings'), 'CmdOrCtrl+,'),
    separator(),
    predefined('Quit', 'Exit')
  ])
}

function buildEditMenu(): SubmenuOptions {
  return submenu('Edit', [
    predefined('Undo'),
    predefined('Redo'),
    separator(),
    predefined('Cut'),
    predefined('Copy'),
    menuItem('Paste', () => emitEmptyUiEvent('appMenuPaste'), 'CmdOrCtrl+V'),
    predefined('SelectAll')
  ])
}

async function buildViewMenu(): Promise<SubmenuOptions> {
  return submenu('View', [
    menuItem('Reload', () => reloadTauriRenderer(false), 'CmdOrCtrl+R'),
    menuItem('Force Reload', () => reloadTauriRenderer(true), 'CmdOrCtrl+Shift+R'),
    separator(),
    menuItem('Reset Size', () => emitTerminalZoom('reset'), 'CmdOrCtrl+0'),
    menuItem('Zoom In', () => emitTerminalZoom('in'), 'CmdOrCtrl+='),
    menuItem('Zoom Out', () => emitTerminalZoom('out'), 'CmdOrCtrl+-'),
    separator(),
    menuItem('Open Worktree Palette', () => emitEmptyUiEvent('toggleWorktreePalette')),
    separator(),
    menuItem('Toggle Full Screen', () => {
      void toggleTauriFullscreen()
    }),
    separator(),
    submenu('Appearance', [
      menuItem('Toggle Left Sidebar', () => emitEmptyUiEvent('toggleLeftSidebar'), 'CmdOrCtrl+B'),
      menuItem(
        'Toggle Right Sidebar',
        () => emitEmptyUiEvent('toggleRightSidebar'),
        'CmdOrCtrl+Shift+B'
      ),
      separator(),
      ...(await buildTauriAppearanceMenuItems(rebuildTauriApplicationMenu))
    ])
  ])
}

function buildWindowMenu(): SubmenuOptions {
  return submenu('Window', [predefined('Minimize'), predefined('Maximize')])
}

function buildHelpMenu(): SubmenuOptions {
  return submenu('Help', [
    menuItem('Report Crash...', () => emitEmptyUiEvent('openCrashReport')),
    separator(),
    menuItem('Explore Pebble', () => emitEmptyUiEvent('openFeatureTour')),
    menuItem('Getting Started with Pebble', () => emitEmptyUiEvent('openSetupGuide')),
    separator(),
    menuItem('Check for Updates...', () => {
      void window.api.updater.check({})
    })
  ])
}

function reloadTauriRenderer(_ignoreCache: boolean): void {
  // Tauri JS does not expose Electron's reloadIgnoringCache; keep the menu wired
  // while the native host grows a force-reload command.
  window.location.reload()
}

async function toggleTauriFullscreen(): Promise<void> {
  const appWindow = getCurrentWindow()
  await appWindow.setFullscreen(!(await appWindow.isFullscreen()))
}

function submenu(text: string, items: TauriMenuEntry[]): SubmenuOptions {
  return { text, items }
}

function menuItem(text: string, action: () => void, accelerator?: string): MenuItemOptions {
  return { text, action, accelerator }
}

function separator(): PredefinedMenuItemOptions {
  return { item: 'Separator' }
}

function predefined(
  item: Exclude<PredefinedMenuItemOptions['item'], { About: unknown }>,
  text?: string
): PredefinedMenuItemOptions {
  return { item, text }
}

function aboutItem(): PredefinedMenuItemOptions {
  return { item: { About: { name: PRODUCT_NAME } } }
}
