import {
  type KeybindingContext,
  type KeybindingOverrides,
  normalizeTerminalShortcutPolicy,
  type TerminalShortcutPolicy
} from '../../../packages/product-core/shared/keybindings'
import {
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../../packages/product-core/shared/modifier-double-tap-detector'
import type { GlobalSettings } from '../../../packages/product-core/shared/types'
import {
  getWindowShortcutActionId,
  resolveWindowShortcutAction,
  type WindowShortcutAction,
  type WindowShortcutInput,
  windowShortcutActionCapturesTerminal
} from '../../../packages/product-core/shared/window-shortcut-policy'
import { emitTauriTerminalShortcutCaptured } from './tauri-ui-events'
import { isTauriSpeechModelAvailable, TAURI_SPEECH_AVAILABLE } from './tauri-speech-api'
import { sendTauriWindowShortcutAction } from './tauri-window-shortcut-dispatch'

type TauriShortcutPlatform = Extract<NodeJS.Platform, 'darwin' | 'linux' | 'win32'>

const tauriDoubleTapDetector = new ModifierDoubleTapDetector()

let tauriWindowShortcutBridgeInstalled = false
let tauriShortcutSettings: Pick<GlobalSettings, 'terminalShortcutPolicy' | 'voice'> | null = null
let tauriShortcutKeybindings: KeybindingOverrides | undefined

export function installTauriWindowShortcutBridge(): void {
  if (tauriWindowShortcutBridgeInstalled) {
    return
  }
  tauriWindowShortcutBridgeInstalled = true
  void refreshTauriShortcutSettings()
  void refreshTauriShortcutKeybindings()
  window.api.settings.onChanged((updates) => {
    tauriShortcutSettings = {
      terminalShortcutPolicy:
        updates.terminalShortcutPolicy ?? tauriShortcutSettings?.terminalShortcutPolicy,
      voice: updates.voice ?? tauriShortcutSettings?.voice
    }
  })
  window.api.keybindings.onChanged((snapshot) => {
    tauriShortcutKeybindings = snapshot.overrides
  })
  // Why: Tauri has no Electron before-input-event. A capture-phase renderer
  // bridge preserves the same shortcut policy without native accelerators
  // stealing terminal/editor/recorder key events.
  window.addEventListener('keydown', handleTauriWindowShortcutKeyDown, { capture: true })
  window.addEventListener('keyup', handleTauriWindowShortcutKeyUp, { capture: true })
  window.addEventListener('blur', resetTauriWindowShortcutBridge)
}

export function _resetTauriWindowShortcutBridgeForTests(): void {
  tauriWindowShortcutBridgeInstalled = false
  tauriShortcutSettings = null
  tauriShortcutKeybindings = undefined
  tauriDoubleTapDetector.reset()
}

async function refreshTauriShortcutSettings(): Promise<void> {
  try {
    const settings = await window.api.settings.get()
    tauriShortcutSettings = {
      terminalShortcutPolicy: settings.terminalShortcutPolicy,
      voice: settings.voice
    }
  } catch {
    tauriShortcutSettings = {
      terminalShortcutPolicy: 'pebble-first',
      voice: undefined
    }
  }
}

async function refreshTauriShortcutKeybindings(): Promise<void> {
  try {
    tauriShortcutKeybindings = (await window.api.keybindings.get()).overrides
  } catch {
    tauriShortcutKeybindings = undefined
  }
}

function handleTauriWindowShortcutKeyDown(event: KeyboardEvent): void {
  if (shouldSkipTauriWindowShortcutTarget(event.target)) {
    return
  }
  const context = getTauriShortcutContext(event.target)
  const terminalShortcutPolicy = getTauriTerminalShortcutPolicy()
  const detected = tauriDoubleTapDetector.process(
    toModifierDoubleTapEvent({
      type: 'keyDown',
      code: event.code,
      key: event.key,
      shift: event.shiftKey,
      control: event.ctrlKey,
      alt: event.altKey,
      meta: event.metaKey,
      isAutoRepeat: event.repeat
    }),
    Date.now()
  )
  if (detected) {
    dispatchTauriWindowShortcutInput(
      { type: 'keyDown', doubleTapModifier: detected.modifier },
      event,
      { context, terminalShortcutPolicy, isAutoRepeat: false }
    )
    return
  }
  dispatchTauriWindowShortcutInput(toTauriWindowShortcutInput(event, 'keyDown'), event, {
    context,
    terminalShortcutPolicy,
    isAutoRepeat: event.repeat
  })
}

function handleTauriWindowShortcutKeyUp(event: KeyboardEvent): void {
  tauriDoubleTapDetector.process(
    toModifierDoubleTapEvent({
      type: 'keyUp',
      code: event.code,
      key: event.key,
      shift: event.shiftKey,
      control: event.ctrlKey,
      alt: event.altKey,
      meta: event.metaKey
    }),
    Date.now()
  )
}

function resetTauriWindowShortcutBridge(): void {
  tauriDoubleTapDetector.reset()
}

function dispatchTauriWindowShortcutInput(
  input: WindowShortcutInput,
  event: KeyboardEvent,
  options: {
    context: KeybindingContext
    terminalShortcutPolicy: TerminalShortcutPolicy
    isAutoRepeat: boolean
  }
): boolean {
  if (event.defaultPrevented) {
    return false
  }
  const action = resolveWindowShortcutAction(
    input,
    getTauriShortcutPlatform(),
    tauriShortcutKeybindings,
    {
      context: options.context,
      terminalShortcutPolicy: options.terminalShortcutPolicy
    }
  )
  if (!action) {
    return false
  }
  return dispatchTauriWindowShortcutAction(action, event, options)
}

function dispatchTauriWindowShortcutAction(
  action: WindowShortcutAction,
  event: KeyboardEvent,
  options: {
    context: KeybindingContext
    terminalShortcutPolicy: TerminalShortcutPolicy
    isAutoRepeat: boolean
  }
): boolean {
  if (
    isFloatingWorkspaceTerminalInputTarget(event.target) &&
    (action.type === 'toggleLeftSidebar' || action.type === 'toggleRightSidebar')
  ) {
    return false
  }

  if (action.type === 'dictationKeyDown' && !canDispatchTauriDictationShortcut()) {
    return false
  }
  if (options.isAutoRepeat && action.type === 'dictationKeyDown') {
    event.preventDefault()
    return true
  }

  event.preventDefault()
  maybeEmitTauriTerminalShortcutCapture(action, options)
  sendTauriWindowShortcutAction(action)
  return true
}

function maybeEmitTauriTerminalShortcutCapture(
  action: WindowShortcutAction,
  options: {
    context: KeybindingContext
    terminalShortcutPolicy: TerminalShortcutPolicy
  }
): void {
  if (
    options.context !== 'terminal' ||
    options.terminalShortcutPolicy !== 'pebble-first' ||
    !windowShortcutActionCapturesTerminal(action)
  ) {
    return
  }
  const actionId = getWindowShortcutActionId(action)
  if (actionId) {
    emitTauriTerminalShortcutCaptured(actionId)
  }
}

function toTauriWindowShortcutInput(
  event: KeyboardEvent,
  type: 'keyDown' | 'keyUp'
): WindowShortcutInput {
  return {
    type,
    key: event.key,
    code: event.code,
    alt: event.altKey,
    meta: event.metaKey,
    control: event.ctrlKey,
    shift: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey
  }
}

function getTauriShortcutContext(target: EventTarget | null): KeybindingContext {
  return targetHasClass(target, 'xterm-helper-textarea') ? 'terminal' : 'app'
}

function getTauriTerminalShortcutPolicy(): TerminalShortcutPolicy {
  return normalizeTerminalShortcutPolicy(tauriShortcutSettings?.terminalShortcutPolicy)
}

function canDispatchTauriDictationShortcut(): boolean {
  if (!TAURI_SPEECH_AVAILABLE) {
    return false
  }
  const voice = tauriShortcutSettings?.voice
  return Boolean(
    voice?.enabled &&
    voice.sttModel &&
    isTauriSpeechModelAvailable(voice.sttModel) &&
    (voice.dictationMode ?? 'toggle') === 'toggle'
  )
}

function shouldSkipTauriWindowShortcutTarget(target: EventTarget | null): boolean {
  return targetClosest(target, '[data-shortcut-recorder-active]') !== null
}

function isFloatingWorkspaceTerminalInputTarget(target: EventTarget | null): boolean {
  return (
    targetClosest(target, '[data-floating-terminal-panel]') !== null &&
    (targetHasClass(target, 'xterm-helper-textarea') || targetClosest(target, '.xterm') !== null)
  )
}

function targetHasClass(target: EventTarget | null, className: string): boolean {
  const candidate = target as { classList?: { contains?: (name: string) => boolean } } | null
  if (typeof candidate?.classList?.contains !== 'function') {
    return false
  }
  return candidate.classList.contains(className)
}

function targetClosest(target: EventTarget | null, selector: string): Element | null {
  const closest = (target as { closest?: (selector: string) => Element | null } | null)?.closest
  if (typeof closest !== 'function') {
    return null
  }
  return closest.call(target, selector)
}

function getTauriShortcutPlatform(): TauriShortcutPlatform {
  const userAgent = navigator.userAgent
  if (userAgent.includes('Mac')) {
    return 'darwin'
  }
  if (userAgent.includes('Windows')) {
    return 'win32'
  }
  return 'linux'
}
