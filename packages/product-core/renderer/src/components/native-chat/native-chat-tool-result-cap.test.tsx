// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { NativeChatToolRun } from './NativeChatToolRun'

// Mirrors MAX_TOOL_RESULT_CHARS in NativeChatToolRun.tsx. Duplicated rather than
// exported so a change to the cap has to be made deliberately in both places.
const MAX_TOOL_RESULT_CHARS = 4000

afterEach(cleanup)

/** Render a run and expand both the run and every tool line inside it, which is
 *  what a user does to read a result body. */
function renderExpanded(blocks: NativeChatBlock[]): HTMLElement {
  const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal={true} />)
  // The first button is the run's own toggle, already open via expandSignal;
  // clicking it would collapse the run and unmount the lines below.
  for (const line of screen.getAllByRole('button').slice(1)) {
    fireEvent.click(line)
  }
  return container
}

describe('native chat tool-result cap', () => {
  it('clips an oversized tool result body', () => {
    const container = renderExpanded([toolResult('x'.repeat(MAX_TOOL_RESULT_CHARS + 500))])

    const body = container.querySelector('pre')
    expect(body?.textContent).toHaveLength(MAX_TOOL_RESULT_CHARS + 1)
    expect(body?.textContent?.endsWith('…')).toBe(true)
    // Clipping is a memory bound, not a reading limit — the body still scrolls.
    expect(body?.className).toContain('overflow-auto')
  })

  it('leaves a tool result at the cap boundary untouched', () => {
    const container = renderExpanded([toolResult('y'.repeat(MAX_TOOL_RESULT_CHARS))])

    const body = container.querySelector('pre')
    expect(body?.textContent).toHaveLength(MAX_TOOL_RESULT_CHARS)
    expect(body?.textContent).not.toContain('…')
  })

  it('never applies the tool cap to assistant prose in the same message', () => {
    // Why: the cap exists for tool output only. A long assistant answer routed
    // through this run must not be clipped — ToolLine ignores non-tool blocks.
    const prose = 'z'.repeat(MAX_TOOL_RESULT_CHARS + 500)
    const container = renderExpanded([{ type: 'text', text: prose }, toolResult('short output')])

    expect(container.textContent).not.toContain('z')
    const body = container.querySelector('pre')
    expect(body?.textContent).toBe('short output')
  })
})

function toolResult(output: string): NativeChatBlock {
  return { type: 'tool-result', output }
}
