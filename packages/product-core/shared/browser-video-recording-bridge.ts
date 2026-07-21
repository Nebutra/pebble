export type BrowserVideoRecordingStartInput = {
  browserTabId: string
  label: string
  path: string
  worktree?: string
  format: 'webm' | 'mp4'
}

export type BrowserVideoRecordingStopResult = {
  path: string
  frames: number
  bytes: number
  durationMs: number
  mimeType: string
}

export type TauriBrowserVideoRecordingBridge = {
  start: (
    input: BrowserVideoRecordingStartInput
  ) => Promise<{ started: true; path: string; mimeType: string }>
  stop: (browserTabId: string) => Promise<BrowserVideoRecordingStopResult>
  rebind: (browserTabId: string, label: string) => Promise<void>
  stopForTab: (browserTabId: string) => Promise<void>
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __pebbleTauriBrowserVideoRecordings?: TauriBrowserVideoRecordingBridge
  }
}
