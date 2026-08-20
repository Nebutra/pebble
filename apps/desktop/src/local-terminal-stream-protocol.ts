// The wire format of runtime/go/internal/runtimehttp/terminal_stream_protocol.go.
// Both sides must agree byte for byte, so the layout is spelled out here rather
// than derived: kind, version, opcode, one reserved byte, a little-endian stream
// id, then the sequence number as two little-endian halves, high word first.

export const TERMINAL_STREAM_KIND = 0x74
export const TERMINAL_STREAM_VERSION = 1
export const TERMINAL_STREAM_HEADER_BYTES = 16

export const TerminalStreamOpcode = {
  Output: 1,
  SnapshotStart: 2,
  SnapshotChunk: 3,
  SnapshotEnd: 4,
  Resized: 5,
  Error: 6,
  Input: 7,
  Resize: 8,
  Subscribe: 9,
  Unsubscribe: 10,
  SnapshotRequest: 11,
  Metadata: 12
} as const

export type TerminalStreamOpcodeValue =
  (typeof TerminalStreamOpcode)[keyof typeof TerminalStreamOpcode]

export type TerminalStreamFrame = {
  opcode: TerminalStreamOpcodeValue
  streamId: number
  seq: number
  payload: Uint8Array
}

export function encodeTerminalStreamFrame(
  frame: Omit<TerminalStreamFrame, 'seq'> & { seq?: number }
): Uint8Array {
  const payload = frame.payload
  const result = new Uint8Array(TERMINAL_STREAM_HEADER_BYTES + payload.length)
  const view = new DataView(result.buffer)
  result[0] = TERMINAL_STREAM_KIND
  result[1] = TERMINAL_STREAM_VERSION
  result[2] = frame.opcode
  view.setUint32(4, frame.streamId, true)
  const seq = frame.seq ?? 0
  view.setUint32(8, Math.floor(seq / 0x1_0000_0000), true)
  view.setUint32(12, seq >>> 0, true)
  result.set(payload, TERMINAL_STREAM_HEADER_BYTES)
  return result
}

export function decodeTerminalStreamFrame(data: Uint8Array): TerminalStreamFrame | null {
  if (
    data.length < TERMINAL_STREAM_HEADER_BYTES ||
    data[0] !== TERMINAL_STREAM_KIND ||
    data[1] !== TERMINAL_STREAM_VERSION
  ) {
    return null
  }
  const opcode = data[2] as TerminalStreamOpcodeValue
  if (opcode < TerminalStreamOpcode.Output || opcode > TerminalStreamOpcode.Metadata) {
    return null
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const high = view.getUint32(8, true)
  const low = view.getUint32(12, true)
  return {
    opcode,
    streamId: view.getUint32(4, true),
    seq: high * 0x1_0000_0000 + low,
    payload: data.subarray(TERMINAL_STREAM_HEADER_BYTES)
  }
}
