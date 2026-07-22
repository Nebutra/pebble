import type { Page } from '@playwright/test'

type BrowserPlatform = 'darwin' | 'linux' | 'win32'

function platformForHost(): BrowserPlatform {
  if (process.platform === 'darwin') {
    return 'darwin'
  }
  if (process.platform === 'win32') {
    return 'win32'
  }
  return 'linux'
}

export async function installTauriBrowserInternals(page: Page): Promise<void> {
  await page.addInitScript((platform: BrowserPlatform) => {
    const callbacks = new Map<number, (payload: unknown) => unknown>()
    let nextCallbackId = 1

    const invoke = async (command: string): Promise<unknown> => {
      if (command === 'app_platform_info') {
        return { platform, osRelease: '', displayServer: null }
      }
      if (command === 'plugin:window|is_focused') {
        return true
      }
      if (command === 'plugin:window|is_visible') {
        return true
      }
      if (command === 'plugin:window|scale_factor') {
        return 1
      }
      if (command === 'plugin:window|inner_size') {
        return { width: 1440, height: 900 }
      }
      if (command === 'plugin:window|outer_size') {
        return { width: 1440, height: 900 }
      }
      if (command === 'plugin:window|inner_position') {
        return { x: 0, y: 0 }
      }
      if (command === 'plugin:window|outer_position') {
        return { x: 0, y: 0 }
      }
      if (command === 'plugin:window|get_all_windows') {
        return ['main']
      }
      if (command.startsWith('plugin:event|')) {
        return 0
      }
      return undefined
    }

    Object.assign(window, {
      __TAURI_INTERNALS__: {
        metadata: {
          currentWindow: { label: 'main' },
          currentWebview: { windowLabel: 'main', label: 'main' }
        },
        invoke,
        transformCallback(callback: (payload: unknown) => unknown, once = false) {
          const id = nextCallbackId
          nextCallbackId += 1
          callbacks.set(id, (payload) => {
            if (once) {
              callbacks.delete(id)
            }
            return callback(payload)
          })
          return id
        },
        unregisterCallback(id: number) {
          callbacks.delete(id)
        },
        runCallback(id: number, payload: unknown) {
          callbacks.get(id)?.(payload)
        },
        callbacks,
        convertFileSrc(filePath: string, protocol = 'asset') {
          return `${protocol}://localhost/${encodeURIComponent(filePath)}`
        }
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener() {}
      }
    })
  }, platformForHost())
}
