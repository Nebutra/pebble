export type FloatingTerminalMenuSide = 'top' | 'bottom'

export function getFloatingTerminalMenuSide(
  clientY: number,
  viewportHeight = globalThis.window?.innerHeight ?? 0
): FloatingTerminalMenuSide {
  if (viewportHeight <= 0) {
    return 'bottom'
  }
  return clientY > viewportHeight / 2 ? 'top' : 'bottom'
}
