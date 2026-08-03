import { useEffect } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { recoverVisibleTerminalWindowWake } from './terminal-visibility-resume'

type UseTerminalWindowWakeRecoveryArgs = {
  isVisible: boolean
  managerRef: React.RefObject<PaneManager | null>
  isActiveRef: React.RefObject<boolean>
  isVisibleRef: React.RefObject<boolean>
}

export function useTerminalWindowWakeRecovery({
  isVisible,
  managerRef,
  isActiveRef,
  isVisibleRef
}: UseTerminalWindowWakeRecoveryArgs): void {
  useEffect(() => {
    if (!isVisible) {
      return
    }
    let wakeRecoveryFrameId: number | null = null
    const cancelScheduledWakeRecovery = (): void => {
      if (wakeRecoveryFrameId === null || typeof cancelAnimationFrame !== 'function') {
        wakeRecoveryFrameId = null
        return
      }
      cancelAnimationFrame(wakeRecoveryFrameId)
      wakeRecoveryFrameId = null
    }
    let settledClearGlyphAtlases = false
    const recoverVisibleWake = (clearGlyphAtlases: boolean): void => {
      // Focus and visibility often fire together; keep one immediate recovery and one settled RAF pass.
      if (wakeRecoveryFrameId !== null) {
        // Why: a pending settled pass may only upgrade in strength — a plain
        // focus that lands after a genuine wake must not skip its atlas clear.
        settledClearGlyphAtlases ||= clearGlyphAtlases
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      recoverVisibleTerminalWindowWake({
        manager,
        isActive: isActiveRef.current,
        clearGlyphAtlases
      })
      if (typeof requestAnimationFrame !== 'function') {
        return
      }
      settledClearGlyphAtlases = clearGlyphAtlases
      wakeRecoveryFrameId = requestAnimationFrame(() => {
        wakeRecoveryFrameId = null
        const clearGlyphAtlasesOnSettle = settledClearGlyphAtlases
        settledClearGlyphAtlases = false
        const settledManager = managerRef.current
        if (!settledManager || !isVisibleRef.current) {
          return
        }
        recoverVisibleTerminalWindowWake({
          manager: settledManager,
          isActive: isActiveRef.current,
          clearGlyphAtlases: clearGlyphAtlasesOnSettle
        })
      })
    }
    // Why (#66 / upstream #12061): plain refocus and fullscreen visibility returns
    // keep the warm shared glyph atlas. Wiping it on every Space swipe fans out
    // global resets across dozens of managers and freezes the renderer.
    const onFocus = (): void => recoverVisibleWake(false)
    const onVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        recoverVisibleWake(false)
      }
    }
    window.addEventListener('focus', onFocus)
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    return () => {
      cancelScheduledWakeRecovery()
      window.removeEventListener('focus', onFocus)
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    }
  }, [isActiveRef, isVisible, isVisibleRef, managerRef])
}
