const SHELL_READY_MARKER = '\x1b]777;pebble-shell-ready\x07'
const LEGACY_SHELL_READY_MARKER = '\x1b]777;pebble-shell-ready\x07'
const SHELL_READY_MARKERS = [SHELL_READY_MARKER, LEGACY_SHELL_READY_MARKER] as const

export type ShellReadyMarkerScanState = {
  matchPos: number
  heldBytes: string
}

export function createShellReadyMarkerScanState(): ShellReadyMarkerScanState {
  return { matchPos: 0, heldBytes: '' }
}

export function scanForShellReadyMarker(
  state: ShellReadyMarkerScanState,
  data: string
): { output: string; matched: boolean } {
  let output = ''

  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i] as string
    if (!state.heldBytes && ch !== SHELL_READY_MARKER[0]) {
      output += ch
      continue
    }

    state.heldBytes += ch
    state.matchPos = state.heldBytes.length

    if (SHELL_READY_MARKERS.includes(state.heldBytes as (typeof SHELL_READY_MARKERS)[number])) {
      const remaining = data.slice(i + 1)
      state.heldBytes = ''
      state.matchPos = 0
      return { output: output + remaining, matched: true }
    }

    if (SHELL_READY_MARKERS.some((marker) => marker.startsWith(state.heldBytes))) {
      continue
    }

    output += state.heldBytes
    const lastChar = state.heldBytes.at(-1)
    state.heldBytes = ''
    state.matchPos = 0
    if (lastChar === SHELL_READY_MARKER[0]) {
      state.heldBytes = lastChar
      state.matchPos = 1
      output = output.slice(0, -1)
    }
  }

  return { output, matched: false }
}
