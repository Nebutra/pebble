/**
 * Braille-glyph spinner detection.
 *
 * Why its own module: three unrelated concerns ask this same question — Pi
 * title matching, Claude identity, and generic status detection — so it does
 * not belong to any one of them.
 */

const BRAILLE_BLOCK_START = 0x2800
const BRAILLE_BLOCK_END = 0x28ff

/** Whether the title contains any glyph from the Unicode Braille Patterns block. */
export function containsBrailleSpinner(title: string): boolean {
  for (const char of title) {
    const codePoint = char.codePointAt(0)
    if (
      codePoint !== undefined &&
      codePoint >= BRAILLE_BLOCK_START &&
      codePoint <= BRAILLE_BLOCK_END
    ) {
      return true
    }
  }
  return false
}
