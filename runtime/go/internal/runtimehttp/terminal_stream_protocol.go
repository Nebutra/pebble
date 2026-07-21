package runtimehttp

import (
	"encoding/binary"
	"errors"
)

const (
	terminalStreamKind        = 0x74
	terminalStreamVersion     = 1
	terminalStreamHeaderBytes = 16
)

type terminalStreamOpcode byte

const (
	terminalStreamOutput          terminalStreamOpcode = 1
	terminalStreamSnapshotStart   terminalStreamOpcode = 2
	terminalStreamSnapshotChunk   terminalStreamOpcode = 3
	terminalStreamSnapshotEnd     terminalStreamOpcode = 4
	terminalStreamResized         terminalStreamOpcode = 5
	terminalStreamError           terminalStreamOpcode = 6
	terminalStreamInput           terminalStreamOpcode = 7
	terminalStreamResize          terminalStreamOpcode = 8
	terminalStreamSubscribe       terminalStreamOpcode = 9
	terminalStreamUnsubscribe     terminalStreamOpcode = 10
	terminalStreamSnapshotRequest terminalStreamOpcode = 11
	terminalStreamMetadata        terminalStreamOpcode = 12
)

type terminalStreamFrame struct {
	Opcode   terminalStreamOpcode
	StreamID uint32
	Seq      uint64
	Payload  []byte
}

func encodeTerminalStreamFrame(frame terminalStreamFrame) []byte {
	result := make([]byte, terminalStreamHeaderBytes+len(frame.Payload))
	result[0] = terminalStreamKind
	result[1] = terminalStreamVersion
	result[2] = byte(frame.Opcode)
	binary.LittleEndian.PutUint32(result[4:8], frame.StreamID)
	binary.LittleEndian.PutUint32(result[8:12], uint32(frame.Seq>>32))
	binary.LittleEndian.PutUint32(result[12:16], uint32(frame.Seq))
	copy(result[terminalStreamHeaderBytes:], frame.Payload)
	return result
}

func decodeTerminalStreamFrame(data []byte) (terminalStreamFrame, error) {
	if len(data) < terminalStreamHeaderBytes || data[0] != terminalStreamKind || data[1] != terminalStreamVersion {
		return terminalStreamFrame{}, errors.New("invalid terminal stream frame")
	}
	opcode := terminalStreamOpcode(data[2])
	if opcode < terminalStreamOutput || opcode > terminalStreamMetadata {
		return terminalStreamFrame{}, errors.New("invalid terminal stream opcode")
	}
	high := uint64(binary.LittleEndian.Uint32(data[8:12]))
	low := uint64(binary.LittleEndian.Uint32(data[12:16]))
	return terminalStreamFrame{
		Opcode: opcode, StreamID: binary.LittleEndian.Uint32(data[4:8]), Seq: high<<32 | low,
		Payload: append([]byte(nil), data[terminalStreamHeaderBytes:]...),
	}, nil
}
