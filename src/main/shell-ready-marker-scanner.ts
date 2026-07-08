export const SHELL_READY_MARKER_PREFIX = '\x1b]777;pebble-shell-ready'
export const LEGACY_SHELL_READY_MARKER_PREFIX = '\x1b]777;pebble-shell-ready'
export const SHELL_READY_MARKER = `${SHELL_READY_MARKER_PREFIX}\x07`
const SHELL_READY_MARKERS = [SHELL_READY_MARKER, `${LEGACY_SHELL_READY_MARKER_PREFIX}\x07`] as const

export type ShellReadyScanState = {
  matchPos: number
  heldBytes: string
}

export type ShellReadyScanResult = {
  output: string
  matched: boolean
  postMarkerBytesObserved: boolean
}

export function createShellReadyScanState(): ShellReadyScanState {
  return { matchPos: 0, heldBytes: '' }
}

export function drainShellReadyHeldBytes(state: ShellReadyScanState): string {
  const heldBytes = state.heldBytes
  state.heldBytes = ''
  state.matchPos = 0
  return heldBytes
}

export function scanForShellReady(state: ShellReadyScanState, data: string): ShellReadyScanResult {
  let output = ''

  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i] as string
    if (!state.heldBytes && ch !== SHELL_READY_MARKER_PREFIX[0]) {
      output += ch
      continue
    }

    state.heldBytes += ch
    state.matchPos = state.heldBytes.length

    if (SHELL_READY_MARKERS.includes(state.heldBytes as (typeof SHELL_READY_MARKERS)[number])) {
      const remaining = data.slice(i + 1)
      state.heldBytes = ''
      state.matchPos = 0
      return {
        output: output + remaining,
        matched: true,
        postMarkerBytesObserved: remaining.length > 0
      }
    }

    if (SHELL_READY_MARKERS.some((marker) => marker.startsWith(state.heldBytes))) {
      continue
    }

    output += state.heldBytes
    const lastChar = state.heldBytes.at(-1)
    state.heldBytes = ''
    state.matchPos = 0
    if (lastChar === SHELL_READY_MARKER_PREFIX[0]) {
      state.heldBytes = lastChar
      state.matchPos = 1
      output = output.slice(0, -1)
    }
  }

  return { output, matched: false, postMarkerBytesObserved: false }
}
