import { useEffect, type RefObject } from 'react'

export function useSessionRestoredBannerDismiss(
  visible: boolean,
  containerRef: RefObject<HTMLElement | null>,
  dismiss: () => void
): void {
  useEffect(() => {
    if (!visible) {
      return
    }
    const container = containerRef.current
    if (!container) {
      return
    }
    container.addEventListener('keydown', dismiss, { capture: true })
    container.addEventListener('pointerdown', dismiss, { capture: true })
    return () => {
      container.removeEventListener('keydown', dismiss, { capture: true })
      container.removeEventListener('pointerdown', dismiss, { capture: true })
    }
  }, [visible, containerRef, dismiss])
}
