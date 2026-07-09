package runtimecore

import "bytes"

// altScreenScanner tracks whether a terminal stream is currently in the
// alternate screen buffer by watching for the smcup/rmcup DEC private-mode
// sequences. It mirrors what the Electron terminal reports as
// `isAlternateScreen` (buffer.active.type === 'alternate' in
// src/main/daemon/headless-emulator.ts), which those sequences drive.
//
// Recognized enter/leave pairs (the same modes xterm.js toggles the alt buffer
// on): 1049, 1047, and 47. Sequences can straddle chunk boundaries, so a short
// tail of unmatched bytes is carried between Feed calls.
type altScreenScanner struct {
	active  bool
	pending []byte
}

// altScreenMarkers pairs each DEC private mode's set (enter) and reset (leave)
// byte sequence.
var altScreenMarkers = []struct {
	enter []byte
	leave []byte
}{
	{enter: []byte("\x1b[?1049h"), leave: []byte("\x1b[?1049l")},
	{enter: []byte("\x1b[?1047h"), leave: []byte("\x1b[?1047l")},
	{enter: []byte("\x1b[?47h"), leave: []byte("\x1b[?47l")},
}

// maxAltMarkerLen is the longest recognized marker; we retain at most this many
// trailing bytes minus one so a marker split across two Feed calls still joins.
const maxAltMarkerLen = 8

// Feed processes a chunk of PTY output and returns the alt-screen state after
// consuming it. The scan is order-preserving: whichever enter/leave marker
// appears last in the stream wins.
func (s *altScreenScanner) Feed(chunk []byte) bool {
	if len(chunk) == 0 {
		return s.active
	}
	buf := chunk
	if len(s.pending) > 0 {
		buf = append(append([]byte(nil), s.pending...), chunk...)
	}

	// Walk the buffer left to right; the last marker seen sets the final state.
	for i := 0; i < len(buf); i++ {
		if buf[i] != 0x1b {
			continue
		}
		for _, marker := range altScreenMarkers {
			if bytes.HasPrefix(buf[i:], marker.enter) {
				s.active = true
				i += len(marker.enter) - 1
				break
			}
			if bytes.HasPrefix(buf[i:], marker.leave) {
				s.active = false
				i += len(marker.leave) - 1
				break
			}
		}
	}

	s.pending = retainMarkerTail(buf)
	return s.active
}

// Active returns the last observed alt-screen state without feeding new bytes.
func (s *altScreenScanner) Active() bool {
	return s.active
}

// retainMarkerTail keeps the trailing bytes that could be the start of a marker
// split across the next chunk. It only retains from the last ESC in the window.
func retainMarkerTail(buf []byte) []byte {
	tailLen := maxAltMarkerLen - 1
	if tailLen > len(buf) {
		tailLen = len(buf)
	}
	tail := buf[len(buf)-tailLen:]
	if idx := bytes.LastIndexByte(tail, 0x1b); idx >= 0 {
		return append([]byte(nil), tail[idx:]...)
	}
	return nil
}
