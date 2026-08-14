import { describe, expect, it } from 'vitest'
import { createTerminalImeCommitBridge } from './terminal-ime-commit-bridge'

function createTextarea() {
  const listeners = new Map<string, Set<(event: Event) => void>>()
  return {
    value: '',
    addEventListener(type: string, listener: (event: Event) => void) {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      listeners.get(type)?.delete(listener)
    },
    emit(type: string, data?: string) {
      for (const listener of listeners.get(type) ?? []) {
        listener({ type, data } as unknown as Event)
      }
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0
    }
  }
}

function createManualSchedule() {
  let pending: (() => void) | null = null
  return {
    schedule: (check: () => void) => {
      pending = check
      return () => {
        pending = null
      }
    },
    run: () => {
      const check = pending
      pending = null
      check?.()
    }
  }
}

describe('createTerminalImeCommitBridge', () => {
  it('commits composed text the terminal never forwarded', () => {
    // Why: this is the ArkWeb case — a candidate is chosen, composition ends,
    // and xterm emits nothing, so the keystroke never reaches the PTY.
    const textarea = createTextarea()
    const schedule = createManualSchedule()
    const committed: string[] = []
    createTerminalImeCommitBridge({
      textarea,
      onCommit: (text) => committed.push(text),
      scheduleCheck: schedule.schedule
    })

    textarea.emit('compositionstart')
    textarea.emit('compositionend', '好')
    schedule.run()

    expect(committed).toEqual(['好'])
  })

  it('stays out of the way when the terminal forwarded it already', () => {
    // Why: on a compliant WebView xterm commits the composition itself. Sending
    // again would duplicate every composed character.
    const textarea = createTextarea()
    const schedule = createManualSchedule()
    const committed: string[] = []
    const bridge = createTerminalImeCommitBridge({
      textarea,
      onCommit: (text) => committed.push(text),
      scheduleCheck: schedule.schedule
    })

    textarea.emit('compositionstart')
    bridge.noteTerminalData()
    textarea.emit('compositionend', '好')
    schedule.run()

    expect(committed).toEqual([])
  })

  it('falls back to the textarea when the event carries no data', () => {
    const textarea = createTextarea()
    const schedule = createManualSchedule()
    const committed: string[] = []
    createTerminalImeCommitBridge({
      textarea,
      onCommit: (text) => committed.push(text),
      scheduleCheck: schedule.schedule
    })

    textarea.value = 'hi'
    textarea.emit('compositionstart')
    textarea.emit('compositionend')
    schedule.run()

    expect(committed).toEqual(['hi'])
  })

  it('commits nothing for an empty composition', () => {
    const textarea = createTextarea()
    const schedule = createManualSchedule()
    const committed: string[] = []
    createTerminalImeCommitBridge({
      textarea,
      onCommit: (text) => committed.push(text),
      scheduleCheck: schedule.schedule
    })

    textarea.emit('compositionstart')
    textarea.emit('compositionend', '')
    schedule.run()

    expect(committed).toEqual([])
  })

  it('counts data per composition, not for the session', () => {
    // Why: a forwarded composition must not vouch for the next one, or the
    // first working commit would suppress every later broken one.
    const textarea = createTextarea()
    const schedule = createManualSchedule()
    const committed: string[] = []
    const bridge = createTerminalImeCommitBridge({
      textarea,
      onCommit: (text) => committed.push(text),
      scheduleCheck: schedule.schedule
    })

    textarea.emit('compositionstart')
    bridge.noteTerminalData()
    textarea.emit('compositionend', 'ok')
    schedule.run()

    textarea.emit('compositionstart')
    textarea.emit('compositionend', '好')
    schedule.run()

    expect(committed).toEqual(['好'])
  })

  it('drops its listeners and any pending check on dispose', () => {
    const textarea = createTextarea()
    const schedule = createManualSchedule()
    const committed: string[] = []
    const bridge = createTerminalImeCommitBridge({
      textarea,
      onCommit: (text) => committed.push(text),
      scheduleCheck: schedule.schedule
    })

    textarea.emit('compositionstart')
    textarea.emit('compositionend', '好')
    bridge.dispose()
    schedule.run()

    expect(committed).toEqual([])
    expect(textarea.listenerCount('compositionstart')).toBe(0)
    expect(textarea.listenerCount('compositionend')).toBe(0)
  })
})
