import { useEffect, useRef, type RefObject } from 'react'
import { toast } from 'sonner'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { translate } from '@/i18n/i18n'

const SHORTCUTS_ESCAPE_CONFIRM_TOAST_ID = 'shortcuts-escape-confirm'
const SHORTCUTS_ESCAPE_CONFIRM_WINDOW_MS = 2200

type SettingsKeyboardScopeOptions = {
  activeSectionId: string
  closeSettingsPage: () => Promise<void>
  enabled: boolean
  keybindings: KeybindingOverrides
  searchInputRef: RefObject<HTMLInputElement | null>
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  if (target.isContentEditable) {
    return true
  }
  return target.matches('input, textarea, select')
}

function hasVisibleOverlay(): boolean {
  return Array.from(
    document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"]')
  ).some((element) => {
    if (!(element instanceof HTMLElement) || element.closest('[aria-hidden="true"]')) {
      return false
    }
    const style = window.getComputedStyle(element)
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      element.getClientRects().length > 0
    )
  })
}

export function useSettingsKeyboardScope({
  activeSectionId,
  closeSettingsPage,
  enabled,
  keybindings,
  searchInputRef
}: SettingsKeyboardScopeOptions): void {
  const shortcutsEscapeConfirmUntilRef = useRef(0)

  useEffect(() => {
    // Why: retained Settings remains mounted behind the workbench; inert does
    // not suppress document listeners, so hidden Settings must own no shortcuts.
    if (!enabled) {
      shortcutsEscapeConfirmUntilRef.current = 0
      toast.dismiss(SHORTCUTS_ESCAPE_CONFIRM_TOAST_ID)
      return
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) {
        return
      }

      if (keybindingMatchesAction('settings.search', event, getShortcutPlatform(), keybindings)) {
        const input = searchInputRef.current
        if (!input) {
          return
        }
        event.preventDefault()
        input.focus()
        input.select()
        return
      }

      if (event.key !== 'Escape' || hasVisibleOverlay() || isEditableTarget(event.target)) {
        return
      }

      if (activeSectionId !== 'shortcuts') {
        void closeSettingsPage()
        return
      }

      event.preventDefault()
      const now = Date.now()
      if (now <= shortcutsEscapeConfirmUntilRef.current) {
        shortcutsEscapeConfirmUntilRef.current = 0
        toast.dismiss(SHORTCUTS_ESCAPE_CONFIRM_TOAST_ID)
        void closeSettingsPage()
        return
      }
      shortcutsEscapeConfirmUntilRef.current = now + SHORTCUTS_ESCAPE_CONFIRM_WINDOW_MS
      toast.info(
        translate(
          'auto.components.settings.Settings.acc7bbdefd',
          'Press ESC again to exit settings'
        ),
        {
          id: SHORTCUTS_ESCAPE_CONFIRM_TOAST_ID,
          duration: SHORTCUTS_ESCAPE_CONFIRM_WINDOW_MS,
          className: 'whitespace-nowrap'
        }
      )
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [activeSectionId, closeSettingsPage, enabled, keybindings, searchInputRef])
}
