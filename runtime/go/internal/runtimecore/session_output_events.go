package runtimecore

import (
	"sync"
	"time"
	"unicode/utf8"
)

// Why: rapid PTY output must not flood /v1/events (and mobile relay frames)
// with one event per line, and a single event payload must stay bounded even
// when a command dumps megabytes between flushes.
const (
	// Why: this delay sits before the Rust event bridge and xterm paint. Keeping
	// it at 1ms makes shell echo immediate while still merging same-read bursts.
	sessionOutputEmitDelay     = time.Millisecond
	maxSessionOutputEventBytes = 32 * 1024
)

// sessionOutputEmitter coalesces per-line output chunks into bounded
// session.output events: at most one event per emit window per session, split
// into consecutive bounded parts when a window carries more than one event's
// worth.
//
// Why split rather than keep the newest tail: this used to drop the oldest
// bytes past the budget and report the count to consumers. A PTY stream is
// protocol, not text — a hole truncates an escape sequence, so every byte after
// it is misread. Characters vanish, the cursor lands in the wrong cell, and
// whatever the previous frame left there stays on screen. A single 80KB burst
// lost 49KB that way, and no desktop consumer ever acted on that report.
type sessionOutputEmitter struct {
	mu        sync.Mutex
	emit      func(topic string, payload interface{})
	emitDelay time.Duration
	maxBytes  int

	timer      *time.Timer
	buffer     []byte
	stream     string
	chunkCount int
	firstAt    time.Time
	snapshot   Session
}

func (e *sessionOutputEmitter) configure(emit func(topic string, payload interface{})) {
	e.emit = emit
	e.emitDelay = sessionOutputEmitDelay
	e.maxBytes = maxSessionOutputEventBytes
}

func (e *sessionOutputEmitter) append(chunk OutputChunk, snapshot Session) {
	if e.emit == nil {
		return
	}
	e.mu.Lock()
	if e.chunkCount == 0 {
		e.firstAt = chunk.At
	}
	// Why: PTY sessions carry a single merged stream; on the rare interleave
	// the latest stream labels the coalesced event, which is what the mobile
	// terminal projection uses for line styling.
	e.stream = chunk.Stream
	e.snapshot = snapshot
	e.chunkCount++
	e.buffer = append(e.buffer, chunk.Content...)
	// Why: a window that has already filled at least one event's worth is sent
	// straight away instead of growing until the timer fires. That keeps
	// in-window memory bounded the way the old trim did, without the trim's
	// cost of throwing bytes away.
	var ready []map[string]interface{}
	if len(e.buffer) >= e.maxBytes {
		ready = e.drainLocked(true)
	}
	if e.timer == nil && e.chunkCount > 0 {
		e.timer = time.AfterFunc(e.emitDelay, e.flushTimerFired)
	}
	e.mu.Unlock()
	e.emitAll(ready)
}

func (e *sessionOutputEmitter) flushTimerFired() {
	e.mu.Lock()
	e.timer = nil
	ready := e.drainLocked(false)
	e.mu.Unlock()
	e.emitAll(ready)
}

// flushNow drains any pending coalesced output synchronously. Called before a
// terminal session.status emit so exit output never arrives after the exit.
func (e *sessionOutputEmitter) flushNow() {
	if e.emit == nil {
		return
	}
	e.mu.Lock()
	if e.timer != nil {
		e.timer.Stop()
		e.timer = nil
	}
	ready := e.drainLocked(false)
	e.mu.Unlock()
	e.emitAll(ready)
}

func (e *sessionOutputEmitter) emitAll(events []map[string]interface{}) {
	// Emitted outside the lock, in order: a terminal replays these bytes in
	// sequence, so reordering them corrupts the screen exactly as a gap would.
	for _, payload := range events {
		e.emit("session.output", payload)
	}
}

// drainLocked turns the pending window into consecutive bounded payloads.
//
// wholePartsOnly keeps a trailing remainder smaller than the budget in the
// buffer, so an in-progress window keeps coalescing instead of emitting a
// short event per read.
func (e *sessionOutputEmitter) drainLocked(wholePartsOnly bool) []map[string]interface{} {
	if e.chunkCount == 0 || len(e.buffer) == 0 {
		return nil
	}
	events := make([]map[string]interface{}, 0, len(e.buffer)/e.maxBytes+1)
	consumed := 0
	for consumed < len(e.buffer) {
		remaining := len(e.buffer) - consumed
		if remaining < e.maxBytes && wholePartsOnly {
			break
		}
		end := consumed + min(remaining, e.maxBytes)
		// Why: PTY reads split runes, and a part boundary must not cut one in
		// half or the payload is malformed JSON text. Walk back to a rune start;
		// the bytes stay in the buffer and lead the next part.
		for end > consumed && end < len(e.buffer) && !utf8.RuneStart(e.buffer[end]) {
			end--
		}
		if end == consumed {
			// A part-sized run with no rune boundary in it: emit it raw rather
			// than spin. Losing the split is better than losing the bytes.
			end = consumed + min(remaining, e.maxBytes)
		}
		events = append(events, map[string]interface{}{
			// Payload keeps the pre-coalescing {session, chunk} shape so the SSE
			// push bridge and mobile terminal projection consume it unchanged.
			"session":         e.snapshot,
			"chunk":           OutputChunk{At: e.firstAt, Stream: e.stream, Content: string(e.buffer[consumed:end])},
			"coalescedChunks": e.chunkCount,
		})
		consumed = end
	}
	if consumed == 0 {
		return nil
	}
	// Why: the payloads copied their bytes above, so the window's buffer can be
	// reused instead of regrown from nil on every emit.
	e.buffer = e.buffer[:copy(e.buffer, e.buffer[consumed:])]
	if len(e.buffer) == 0 {
		e.chunkCount = 0
		e.stream = ""
	}
	return events
}
