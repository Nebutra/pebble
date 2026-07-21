import type { CheckMenuItemOptions } from '@tauri-apps/api/menu'

import type { GlobalSettings } from '../../../packages/product-core/shared/types'
import { translate } from '../../../packages/product-core/renderer/src/i18n/i18n'

type AppearanceSettingsKey = 'showTasksButton' | 'showAutomationsButton' | 'showMobileButton'

export async function buildTauriAppearanceMenuItems(
  rebuildMenu: () => Promise<void>
): Promise<CheckMenuItemOptions[]> {
  const [settings, ui] = await Promise.all([window.api.settings.get(), window.api.ui.get()])
  return [
    checkItem(
      menuText('showStatusBar', 'Show Status Bar'),
      ui.statusBarVisible !== false,
      async () => {
        await window.api.ui.set({ statusBarVisible: !(ui.statusBarVisible !== false) })
        await rebuildMenu()
      }
    ),
    checkItem(
      menuText('showTasksButton', 'Show Tasks Button'),
      settings.showTasksButton !== false,
      () => toggleAppearanceSetting('showTasksButton', rebuildMenu)
    ),
    checkItem(
      menuText('showAutomationsButton', 'Show Automations Button'),
      settings.showAutomationsButton !== false,
      () => toggleAppearanceSetting('showAutomationsButton', rebuildMenu)
    ),
    checkItem(
      menuText('showMobileButton', 'Show Pebble Mobile Button'),
      settings.showMobileButton !== false,
      () => toggleAppearanceSetting('showMobileButton', rebuildMenu)
    ),
    checkItem(
      menuText('showTitlebarAppName', 'Show Titlebar App Name'),
      settings.showTitlebarAppName !== false,
      async () => {
        await window.api.settings.set({
          showTitlebarAppName: !(settings.showTitlebarAppName !== false)
        })
        await rebuildMenu()
      }
    )
  ]
}

function menuText(key: string, fallback: string): string {
  return translate(`menu.${key}`, fallback)
}

function checkItem(
  text: string,
  checked: boolean,
  action: () => void | Promise<void>
): CheckMenuItemOptions {
  return {
    text,
    checked,
    action: () => {
      void action()
    }
  }
}

async function toggleAppearanceSetting(
  key: AppearanceSettingsKey,
  rebuildMenu: () => Promise<void>
): Promise<void> {
  const settings = await window.api.settings.get()
  const current = settings[key] !== false
  await window.api.settings.set({ [key]: !current } satisfies Partial<GlobalSettings>)
  await rebuildMenu()
}
