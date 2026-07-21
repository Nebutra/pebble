import type {
  CheckMenuItemOptions,
  MenuItemOptions,
  PredefinedMenuItemOptions,
  SubmenuOptions
} from '@tauri-apps/api/menu'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { translate } from '../../../packages/product-core/renderer/src/i18n/i18n'
import {
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  type KeybindingActionId,
  type KeybindingOverrides
} from '../../../packages/product-core/shared/keybindings'
import { buildTauriAppearanceMenuItems } from './tauri-appearance-menu-state'
import { PRODUCT_NAME } from './product-brand'
import {
  emitTauriEmptyUiEvent as emitEmptyUiEvent,
  emitTauriTerminalZoom as emitTerminalZoom
} from './tauri-ui-events'
import { reloadTauriWebview, toggleTauriDevtools } from './tauri-webview-reload'
import { requestTauriAppQuit } from './tauri-window-api'
import { rebuildTauriApplicationMenu } from './tauri-menu-api'

type TauriMenuEntry =
  | SubmenuOptions
  | MenuItemOptions
  | PredefinedMenuItemOptions
  | CheckMenuItemOptions
type TauriMenuPlatform = Extract<NodeJS.Platform, 'darwin' | 'linux' | 'win32'>
type ShortcutLabelResolver = (actionId: KeybindingActionId) => string

// The native application-menu template is split out of tauri-menu-api.ts so the
// install/lifecycle module stays focused on menu state and event wiring.
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
    buildHelpMenu(isMac)
  ]
}

function buildMacAppMenu(shortcutLabel: ShortcutLabelResolver): SubmenuOptions {
  return submenu(PRODUCT_NAME, [
    aboutItem(),
    menuItem(menuText('checkForUpdates', 'Check for Updates...'), () => {
      void window.api.updater.check({})
    }),
    separator(),
    menuItem(
      menuLabelWithShortcut(menuText('settings', 'Settings'), 'app.settings', shortcutLabel),
      () => emitEmptyUiEvent('openSettings')
    ),
    separator(),
    predefined('Services'),
    separator(),
    predefined('Hide'),
    predefined('HideOthers'),
    predefined('ShowAll'),
    separator(),
    menuItem(menuText('quit', `Quit ${PRODUCT_NAME}`), requestTauriAppQuit, 'CmdOrCtrl+Q')
  ])
}

function buildFileMenu(shortcutLabel: ShortcutLabelResolver): SubmenuOptions {
  return submenu(menuText('file', 'File'), [
    menuItem(
      menuLabelWithShortcut(menuText('settings', 'Settings'), 'app.settings', shortcutLabel),
      () => emitEmptyUiEvent('openSettings')
    ),
    separator(),
    menuItem(menuText('exit', 'Exit'), requestTauriAppQuit, 'CmdOrCtrl+Q')
  ])
}

function buildEditMenu(): SubmenuOptions {
  return submenu(menuText('edit', 'Edit'), [
    predefined('Undo'),
    predefined('Redo'),
    separator(),
    predefined('Cut'),
    predefined('Copy'),
    menuItem(menuText('paste', 'Paste'), () => emitEmptyUiEvent('appMenuPaste'), 'CmdOrCtrl+V'),
    predefined('SelectAll')
  ])
}

async function buildViewMenu(shortcutLabel: ShortcutLabelResolver): Promise<SubmenuOptions> {
  return submenu(menuText('view', 'View'), [
    menuItem(menuText('reload', 'Reload'), () => reloadTauriWebview(false)),
    menuItem(
      menuLabelWithShortcut(
        menuText('forceReload', 'Force Reload'),
        'app.forceReload',
        shortcutLabel
      ),
      () => reloadTauriWebview(true)
    ),
    menuItem(menuText('toggleDevTools', 'Toggle Developer Tools'), () => {
      void toggleTauriDevtools().catch((error) => {
        console.error('[tauri-menu] could not toggle developer tools:', error)
      })
    }),
    separator(),
    menuItem(
      menuLabelWithShortcut(menuText('resetSize', 'Reset Size'), 'zoom.reset', shortcutLabel),
      () => emitTerminalZoom('reset')
    ),
    menuItem(menuLabelWithShortcut(menuText('zoomIn', 'Zoom In'), 'zoom.in', shortcutLabel), () =>
      emitTerminalZoom('in')
    ),
    menuItem(
      menuLabelWithShortcut(menuText('zoomOut', 'Zoom Out'), 'zoom.out', shortcutLabel),
      () => emitTerminalZoom('out')
    ),
    separator(),
    menuItem(
      menuLabelWithShortcut(
        menuText('openWorktreePalette', 'Open Worktree Palette'),
        'worktree.palette',
        shortcutLabel
      ),
      () => emitEmptyUiEvent('toggleWorktreePalette')
    ),
    separator(),
    menuItem(menuText('toggleFullscreen', 'Toggle Full Screen'), () => {
      void toggleTauriFullscreen()
    }),
    separator(),
    submenu(menuText('appearance', 'Appearance'), [
      menuItem(
        menuLabelWithShortcut(
          menuText('toggleLeftSidebar', 'Toggle Left Sidebar'),
          'sidebar.left.toggle',
          shortcutLabel
        ),
        () => emitEmptyUiEvent('toggleLeftSidebar')
      ),
      menuItem(
        menuLabelWithShortcut(
          menuText('toggleRightSidebar', 'Toggle Right Sidebar'),
          'sidebar.right.toggle',
          shortcutLabel
        ),
        () => emitEmptyUiEvent('toggleRightSidebar')
      ),
      separator(),
      ...(await buildTauriAppearanceMenuItems(rebuildTauriApplicationMenu))
    ])
  ])
}

function buildWindowMenu(): SubmenuOptions {
  return submenu(menuText('window', 'Window'), [predefined('Minimize'), predefined('Maximize')])
}

function buildHelpMenu(isMac: boolean): SubmenuOptions {
  const baseItems: TauriMenuEntry[] = [
    menuItem(menuText('reportCrash', 'Report Crash...'), () => emitEmptyUiEvent('openCrashReport')),
    separator(),
    menuItem(menuText('explorePebble', 'Explore Pebble'), () =>
      emitEmptyUiEvent('openFeatureTour')
    ),
    menuItem(menuText('gettingStarted', 'Getting Started with Pebble'), () =>
      emitEmptyUiEvent('openSetupGuide')
    )
  ]

  // macOS owns About and updater actions in the application menu, matching the Electron shell.
  return submenu(
    menuText('help', 'Help'),
    isMac
      ? baseItems
      : [
          ...baseItems,
          separator(),
          aboutItem(),
          menuItem(menuText('checkForUpdates', 'Check for Updates...'), () => {
            void window.api.updater.check({})
          })
        ]
  )
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

function menuText(key: string, fallback: string): string {
  return translate(`menu.${key}`, fallback)
}

function createShortcutLabelResolver(
  platform: TauriMenuPlatform,
  keybindings?: KeybindingOverrides
): ShortcutLabelResolver {
  return (actionId) =>
    formatKeybindingList(
      getEffectiveKeybindingsForAction(actionId, platform, keybindings),
      platform
    )
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
