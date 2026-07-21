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
// session.output events: at most one event per emit window per session,
// keeping only the newest maxBytes bytes and counting what it dropped so
// consumers know to tail-fetch the full buffer instead of trusting the event.
type sessionOutputEmitter struct {
	mu        sync.Mutex
	emit      func(topic string, payload interface{})
	emitDelay time.Duration
	maxBytes  int

	timer        *time.Timer
	buffer       []byte
	stream       string
	chunkCount   int
	droppedBytes int
	firstAt      time.Time
	snapshot     Session
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
	if len(e.buffer) > e.maxBytes {
		start := len(e.buffer) - e.maxBytes
		// Why: PTY reads may split a rune, and trimming at the raw byte budget
		// must not turn the retained newest tail into malformed JSON text.
		for start < len(e.buffer) && !utf8.RuneStart(e.buffer[start]) {
			start++
		}
		e.droppedBytes += start
		e.buffer = append(e.buffer[:0:0], e.buffer[start:]...)
	}
	if e.timer == nil {
		e.timer = time.AfterFunc(e.emitDelay, e.flushTimerFired)
	}
	e.mu.Unlock()
}

func (e *sessionOutputEmitter) flushTimerFired() {
	e.mu.Lock()
	e.timer = nil
	topic, payload, pending := e.takeLocked()
	e.mu.Unlock()
	if pending {
		e.emit(topic, payload)
	}
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
	topic, payload, pending := e.takeLocked()
	e.mu.Unlock()
	if pending {
		e.emit(topic, payload)
	}
}

func (e *sessionOutputEmitter) takeLocked() (string, map[string]interface{}, bool) {
	if e.chunkCount == 0 {
		return "", nil, false
	}
	// Payload keeps the pre-coalescing {session, chunk} shape so the SSE push
	// bridge and mobile terminal projection consume it unchanged.
	payload := map[string]interface{}{
		"session":         e.snapshot,
		"chunk":           OutputChunk{At: e.firstAt, Stream: e.stream, Content: string(e.buffer)},
		"coalescedChunks": e.chunkCount,
	}
	if e.droppedBytes > 0 {
		payload["droppedBytes"] = e.droppedBytes
	}
	e.buffer = nil
	e.chunkCount = 0
	e.droppedBytes = 0
	e.stream = ""
	return "session.output", payload, true
}
