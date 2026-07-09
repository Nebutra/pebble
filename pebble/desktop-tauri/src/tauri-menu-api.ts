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
import {
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  type KeybindingActionId,
  type KeybindingOverrides
} from '../../../src/shared/keybindings'
import { buildTauriAppearanceMenuItems } from './tauri-appearance-menu-state'
import { PRODUCT_NAME } from './product-brand'
import {
  emitTauriEmptyUiEvent as emitEmptyUiEvent,
  emitTauriTerminalZoom as emitTerminalZoom,
  subscribeTauriEmptyUiEvent as subscribeEmptyUiEvent,
  subscribeTauriIndexedUiEvent as subscribeIndexedUiEvent,
  subscribeTauriTerminalShortcutCaptured as subscribeTerminalShortcutCaptured,
  subscribeTauriTerminalZoom as subscribeTerminalZoom,
  subscribeTauriWorktreeHistoryNavigate as subscribeWorktreeHistoryNavigate
} from './tauri-ui-events'
import { installTauriWindowShortcutBridge } from './tauri-window-shortcut-bridge'

type TauriMenuEntry =
  | SubmenuOptions
  | MenuItemOptions
  | PredefinedMenuItemOptions
  | CheckMenuItemOptions
type TauriMenuPlatform = Extract<NodeJS.Platform, 'darwin' | 'linux' | 'win32'>
type ShortcutLabelResolver = (actionId: KeybindingActionId) => string

let tauriMenu: Menu | null = null
let pendingTauriMenu: Promise<Menu> | null = null
let tauriZoomLevel = 0
let tauriMenuKeybindingSubscriptionInstalled = false

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
    onToggleFloatingTerminal: subscribeEmptyUiEvent('toggleFloatingTerminal'),
    onTerminalShortcutCaptured: subscribeTerminalShortcutCaptured,
    onOpenQuickOpen: subscribeEmptyUiEvent('openQuickOpen'),
    onToggleQuickCommandsMenu: subscribeEmptyUiEvent('toggleQuickCommandsMenu'),
    onOpenNewWorkspace: subscribeEmptyUiEvent('openNewWorkspace'),
    onDeleteCurrentWorkspace: subscribeEmptyUiEvent('deleteCurrentWorkspace'),
    onOpenWorkspaceBoard: subscribeEmptyUiEvent('openWorkspaceBoard'),
    onOpenTasks: subscribeEmptyUiEvent('openTasks'),
    onJumpToWorktreeIndex: subscribeIndexedUiEvent('jumpToWorktreeIndex'),
    onJumpToTabIndex: subscribeIndexedUiEvent('jumpToTabIndex'),
    onWorktreeHistoryNavigate: subscribeWorktreeHistoryNavigate,
    onSwitchRecentTab: subscribeEmptyUiEvent('switchRecentTab'),
    onDictationKeyDown: subscribeEmptyUiEvent('dictationKeyDown'),
    onAppMenuPaste: subscribeEmptyUiEvent('appMenuPaste'),
    onTerminalZoom: subscribeTerminalZoom,
    popupMenu: () => {
      void popupTauriMenu()
    }
  } satisfies PreloadApi['ui']

  void installTauriApplicationMenu()
  installTauriMenuKeybindingSubscription()
  installTauriWindowShortcutBridge()
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
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
  return Menu.new({ items: await buildTauriMenuTemplate(await readTauriKeybindingOverrides()) })
}

async function rebuildTauriApplicationMenu(): Promise<void> {
  pendingTauriMenu = null
  tauriMenu = await createTauriMenu()
  await tauriMenu.setAsAppMenu()
}

export async function buildTauriMenuTemplate(
  keybindings?: KeybindingOverrides
): Promise<SubmenuOptions[]> {
  const platform = getTauriMenuPlatform()
  const isMac = platform === 'darwin'
  const shortcutLabel = createShortcutLabelResolver(platform, keybindings)
  return [
    ...(isMac ? [buildMacAppMenu(shortcutLabel)] : []),
    ...(isMac ? [] : [buildFileMenu(shortcutLabel)]),
    buildEditMenu(),
    await buildViewMenu(shortcutLabel),
    buildWindowMenu(),
    buildHelpMenu()
  ]
}

function buildMacAppMenu(shortcutLabel: ShortcutLabelResolver): SubmenuOptions {
  return submenu(PRODUCT_NAME, [
    aboutItem(),
    menuItem('Check for Updates...', () => {
      void window.api.updater.check({})
    }),
    separator(),
    menuItem(menuLabelWithShortcut('Settings', 'app.settings', shortcutLabel), () =>
      emitEmptyUiEvent('openSettings')
    ),
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

function buildFileMenu(shortcutLabel: ShortcutLabelResolver): SubmenuOptions {
  return submenu('File', [
    menuItem(menuLabelWithShortcut('Settings', 'app.settings', shortcutLabel), () =>
      emitEmptyUiEvent('openSettings')
    ),
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

async function buildViewMenu(shortcutLabel: ShortcutLabelResolver): Promise<SubmenuOptions> {
  return submenu('View', [
    menuItem('Reload', () => reloadTauriRenderer(false)),
    menuItem(menuLabelWithShortcut('Force Reload', 'app.forceReload', shortcutLabel), () =>
      reloadTauriRenderer(true)
    ),
    separator(),
    menuItem(menuLabelWithShortcut('Reset Size', 'zoom.reset', shortcutLabel), () =>
      emitTerminalZoom('reset')
    ),
    menuItem(menuLabelWithShortcut('Zoom In', 'zoom.in', shortcutLabel), () =>
      emitTerminalZoom('in')
    ),
    menuItem(menuLabelWithShortcut('Zoom Out', 'zoom.out', shortcutLabel), () =>
      emitTerminalZoom('out')
    ),
    separator(),
    menuItem(menuLabelWithShortcut('Open Worktree Palette', 'worktree.palette', shortcutLabel), () =>
      emitEmptyUiEvent('toggleWorktreePalette')
    ),
    separator(),
    menuItem('Toggle Full Screen', () => {
      void toggleTauriFullscreen()
    }),
    separator(),
    submenu('Appearance', [
      menuItem(
        menuLabelWithShortcut('Toggle Left Sidebar', 'sidebar.left.toggle', shortcutLabel),
        () => emitEmptyUiEvent('toggleLeftSidebar')
      ),
      menuItem(
        menuLabelWithShortcut('Toggle Right Sidebar', 'sidebar.right.toggle', shortcutLabel),
        () => emitEmptyUiEvent('toggleRightSidebar')
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

function installTauriMenuKeybindingSubscription(): void {
  if (tauriMenuKeybindingSubscriptionInstalled) {
    return
  }
  tauriMenuKeybindingSubscriptionInstalled = true
  window.api.keybindings.onChanged(() => {
    void rebuildTauriApplicationMenu()
  })
}

async function readTauriKeybindingOverrides(): Promise<KeybindingOverrides | undefined> {
  try {
    return (await window.api.keybindings.get()).overrides
  } catch {
    return undefined
  }
}

function createShortcutLabelResolver(
  platform: TauriMenuPlatform,
  keybindings?: KeybindingOverrides
): ShortcutLabelResolver {
  return (actionId) =>
    formatKeybindingList(getEffectiveKeybindingsForAction(actionId, platform, keybindings), platform)
}

function menuLabelWithShortcut(
  label: string,
  actionId: KeybindingActionId,
  shortcutLabel: ShortcutLabelResolver
): string {
  // Why: these shortcuts are renderer-policy-routed; menu labels may show them,
  // but native accelerators would steal terminal/editor/recorder key events.
  return `${label}\t${shortcutLabel(actionId)}`
}

function getTauriMenuPlatform(): TauriMenuPlatform {
  const userAgent = navigator.userAgent
  if (userAgent.includes('Mac')) {
    return 'darwin'
  }
  if (userAgent.includes('Windows')) {
    return 'win32'
  }
  return 'linux'
}
