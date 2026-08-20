import { describe, expect, it } from 'vitest'
import {
  TERMINAL_STREAM_HEADER_BYTES,
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame
} from './local-terminal-stream-protocol'

// The same vector is asserted in Go by
// TestTerminalStreamFrameMatchesTheRendererGoldenBytes. Two hand-written codecs
// drifting apart is the failure this pair exists to catch, so change both or
// neither.
const GOLDEN_INPUT_FRAME = [
  0x74, 0x01, 0x07, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x68, 0x69
]

describe('terminal stream frames', () => {
  it('encodes the bytes the runtime expects', () => {
    const encoded = encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Input,
      streamId: 3,
      payload: new TextEncoder().encode('hi')
    })
    expect([...encoded]).toEqual(GOLDEN_INPUT_FRAME)
  })

  it('decodes what it encodes, including a sequence above 32 bits', () => {
    const seq = 0x1_0000_0005
    const encoded = encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Output,
      streamId: 42,
      seq,
      payload: new TextEncoder().encode('pebble')
    })
    const decoded = decodeTerminalStreamFrame(encoded)
    expect(decoded).not.toBeNull()
    expect(decoded?.opcode).toBe(TerminalStreamOpcode.Output)
    expect(decoded?.streamId).toBe(42)
    expect(decoded?.seq).toBe(seq)
    expect(new TextDecoder().decode(decoded?.payload)).toBe('pebble')
  })

  it('rejects frames that are not this protocol', () => {
    expect(decodeTerminalStreamFrame(new Uint8Array(TERMINAL_STREAM_HEADER_BYTES - 1))).toBeNull()

    const wrongKind = new Uint8Array(GOLDEN_INPUT_FRAME)
    wrongKind[0] = 0x75
    expect(decodeTerminalStreamFrame(wrongKind)).toBeNull()

    const wrongVersion = new Uint8Array(GOLDEN_INPUT_FRAME)
    wrongVersion[1] = 0x02
    expect(decodeTerminalStreamFrame(wrongVersion)).toBeNull()

    const unknownOpcode = new Uint8Array(GOLDEN_INPUT_FRAME)
    unknownOpcode[2] = 0x63
    expect(decodeTerminalStreamFrame(unknownOpcode)).toBeNull()
  })

  it('decodes a frame that sits at an offset inside a larger buffer', () => {
    // Why: a socket message arrives as an ArrayBuffer view, and reading the
    // header from the wrong origin would silently mis-address every stream.
    const backing = new Uint8Array(GOLDEN_INPUT_FRAME.length + 8)
    backing.set(GOLDEN_INPUT_FRAME, 8)
    const decoded = decodeTerminalStreamFrame(backing.subarray(8))
    expect(decoded?.streamId).toBe(3)
    expect(new TextDecoder().decode(decoded?.payload)).toBe('hi')
  })
})
