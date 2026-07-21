import { invoke } from '@tauri-apps/api/core'

export function reloadTauriWebview(ignoreCache: boolean): void {
  void invoke('webview_reload', { ignoreCache }).catch(() => window.location.reload())
}

export function toggleTauriDevtools(): Promise<boolean> {
  return invoke<boolean>('webview_toggle_devtools')
}
