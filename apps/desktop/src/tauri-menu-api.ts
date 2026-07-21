import { Menu } from '@tauri-apps/api/menu'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { i18n } from '../../../packages/product-core/renderer/src/i18n/i18n'
import type { KeybindingOverrides } from '../../../packages/product-core/shared/keybindings'
import {
  subscribeTauriEmptyUiEvent as subscribeEmptyUiEvent,
  subscribeTauriIndexedUiEvent as subscribeIndexedUiEvent,
  subscribeTauriTerminalShortcutCaptured as subscribeTerminalShortcutCaptured,
  subscribeTauriTerminalZoom as subscribeTerminalZoom,
  subscribeTauriWorktreeHistoryNavigate as subscribeWorktreeHistoryNavigate
} from './tauri-ui-events'
import {
  _resetTauriWindowShortcutBridgeForTests,
  installTauriWindowShortcutBridge
} from './tauri-window-shortcut-bridge'
import { buildTauriMenuTemplate } from './tauri-menu-template'

export { buildTauriMenuTemplate } from './tauri-menu-template'

let tauriMenu: Menu | null = null
let pendingTauriMenu: Promise<Menu> | null = null
let tauriZoomLevel = 0
let tauriMenuKeybindingSubscriptionInstalled = false
let tauriMenuLanguageSubscriptionInstalled = false

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
  installTauriMenuLanguageSubscription()
  installTauriWindowShortcutBridge()
}

export function _resetTauriMenuApiForTests(): void {
  tauriMenu = null
  pendingTauriMenu = null
  tauriZoomLevel = 0
  tauriMenuKeybindingSubscriptionInstalled = false
  tauriMenuLanguageSubscriptionInstalled = false
  i18n.off('languageChanged', rebuildTauriApplicationMenu)
  _resetTauriWindowShortcutBridgeForTests()
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

export async function rebuildTauriApplicationMenu(): Promise<void> {
  pendingTauriMenu = null
  tauriMenu = await createTauriMenu()
  await tauriMenu.setAsAppMenu()
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

function installTauriMenuLanguageSubscription(): void {
  if (tauriMenuLanguageSubscriptionInstalled) {
    return
  }
  tauriMenuLanguageSubscriptionInstalled = true
  // Why: native menus live outside React and do not rerender when the renderer
  // locale changes, so rebuild them from the newly loaded catalog.
  i18n.on('languageChanged', rebuildTauriApplicationMenu)
}

async function readTauriKeybindingOverrides(): Promise<KeybindingOverrides | undefined> {
  try {
    return (await window.api.keybindings.get()).overrides
  } catch {
    return undefined
  }
}
