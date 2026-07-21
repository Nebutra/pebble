import { Window } from 'happy-dom'

if (typeof window !== 'undefined' && window.localStorage === undefined) {
  const storageWindow = new Window()
  // Why: Node 26 exposes a disabled global localStorage that masks happy-dom's
  // implementation; tests still need the browser storage contract used by Tauri.
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storageWindow.localStorage
  })
}
