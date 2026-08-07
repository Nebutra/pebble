package runtimecore

import (
	"strconv"
	"strings"
	"testing"
	"time"
)

// The output hot path trims the coalescing window lazily and retires ring
// chunks by moving a head index. These tests pin the bounds both rely on.

func TestSessionOutputEmitterBoundsTheWindowBetweenFlushes(t *testing.T) {
	recorder := &emitRecorder{}
	emitter := newTestOutputEmitter(recorder, 16)
	session := Session{ID: "sess-1"}
	// Why: trimming is deferred to the flush, so the window itself needs its own
	// cap or a command dumping megabytes between flushes would retain all of it.
	for range 200 {
		emitter.append(testOutputChunk("0123456789"), session)
		emitter.mu.Lock()
		held := len(emitter.buffer)
		emitter.mu.Unlock()
		if held > 2*emitter.maxBytes {
			t.Fatalf("window grew to %d bytes, past the %d cap", held, 2*emitter.maxBytes)
		}
	}
	emitter.flushNow()

	events := recorder.snapshot()
	if len(events) != 1 {
		t.Fatalf("expected a single flush, got %d", len(events))
	}
	chunk := events[0].payload["chunk"].(OutputChunk)
	if chunk.Content != "4567890123456789" {
		t.Fatalf("expected the newest 16-byte tail, got %q", chunk.Content)
	}
	// Why: the in-window trims and the flush trim must add up to everything the
	// payload could not carry, or consumers cannot tell they need to tail-fetch.
	if dropped := events[0].payload["droppedBytes"].(int); dropped != 200*10-16 {
		t.Fatalf("dropped %d bytes, want %d", dropped, 200*10-16)
	}
}

func TestSessionOutputEmitterWindowsDoNotLeakIntoEachOther(t *testing.T) {
	recorder := &emitRecorder{}
	emitter := newTestOutputEmitter(recorder, 16)
	session := Session{ID: "sess-1"}
	// Why: the first window has to overflow, or the reset of the carried drop
	// count and buffer would go unexercised.
	emitter.append(testOutputChunk(strings.Repeat("first", 8)), session)
	emitter.flushNow()
	emitter.append(testOutputChunk("second"), session)
	emitter.flushNow()

	events := recorder.snapshot()
	if len(events) != 2 {
		t.Fatalf("expected two flushes, got %d", len(events))
	}
	// Why: the window buffer is reused rather than regrown from nil, so a shorter
	// window must not expose the bytes a longer one left behind.
	if content := events[1].payload["chunk"].(OutputChunk).Content; content != "second" {
		t.Fatalf("second window carried stale bytes: %q", content)
	}
	if dropped, carried := events[1].payload["droppedBytes"]; carried {
		t.Fatalf("second window inherited the previous window's drop count: %v", dropped)
	}
	if dropped := events[0].payload["droppedBytes"].(int); dropped != 8*5-16 {
		t.Fatalf("first window dropped %d bytes, want %d", dropped, 8*5-16)
	}
}

func newRingTestSession() *processSession {
	started := time.Now().UTC()
	session := &processSession{
		id:           "sess-ring",
		command:      []string{"/bin/bash"},
		status:       SessionRunning,
		startedAt:    started,
		updatedAt:    started,
		cols:         80,
		rows:         24,
		output:       make([]OutputChunk, 0, 8),
		screen:       newTerminalScreen(80, 24),
		stateChanged: make(chan struct{}),
		exitHandled:  make(chan struct{}),
	}
	session.outputEvents.configure(func(string, interface{}) {})
	return session
}

func TestSessionOutputRingHoldsExactlyTheNewestChunks(t *testing.T) {
	session := newRingTestSession()
	total := maxSessionChunks + maxRetiredSessionChunks*3
	for index := range total {
		session.appendOutput("stdout", strconv.Itoa(index))
		// Why: retiring by head index lets the backing array outgrow the cap, so
		// the live window is what has to stay bounded — on every append, not just
		// at the compaction points.
		if live := session.snapshot().OutputChunks; live > maxSessionChunks {
			t.Fatalf("live window grew to %d chunks, past the %d cap", live, maxSessionChunks)
		}
	}
	if live := session.snapshot().OutputChunks; live != maxSessionChunks {
		t.Fatalf("live window settled at %d chunks, want %d", live, maxSessionChunks)
	}
	// Why: a head index alone would leave retired chunks in the backing array
	// forever. Compaction is what bounds the array, and only the array bound
	// distinguishes retiring from leaking.
	session.mu.RLock()
	held := len(session.output)
	session.mu.RUnlock()
	if held > maxSessionChunks+maxRetiredSessionChunks {
		t.Fatalf("backing array held %d chunks, past the %d bound", held, maxSessionChunks+maxRetiredSessionChunks)
	}

	tail := session.tail(0)
	if len(tail) != maxSessionChunks {
		t.Fatalf("tail returned %d chunks, want %d", len(tail), maxSessionChunks)
	}
	// Why: compaction rewrites the backing array underneath the live window, so
	// the retained chunks must still be the newest ones, in order.
	for offset, chunk := range tail {
		want := strconv.Itoa(total - maxSessionChunks + offset)
		if chunk.Content != want {
			t.Fatalf("tail[%d] = %q, want %q", offset, chunk.Content, want)
		}
	}
	if newest := session.tail(3); len(newest) != 3 || newest[2].Content != strconv.Itoa(total-1) {
		t.Fatalf("limited tail = %#v, want the last three chunks", newest)
	}
}

func TestSessionOutputRingReleasesRetiredChunks(t *testing.T) {
	session := newRingTestSession()
	for range maxSessionChunks + maxRetiredSessionChunks*2 {
		session.appendOutput("stdout", strings.Repeat("z", 32))
	}
	session.mu.RLock()
	defer session.mu.RUnlock()
	// Why: compaction reslices in place, so the vacated tail must be cleared or
	// retired chunks stay reachable for as long as the session lives.
	for _, stale := range session.output[len(session.output):cap(session.output)] {
		if stale.Content != "" {
			t.Fatal("retired chunk still reachable past the live window")
		}
	}
}

func TestSessionOutputRingClearResetsTheHead(t *testing.T) {
	session := newRingTestSession()
	for range maxSessionChunks + maxRetiredSessionChunks + 1 {
		session.appendOutput("stdout", "x")
	}
	if session.clearBuffer().OutputChunks != 0 {
		t.Fatal("clearing the buffer left chunks behind")
	}
	session.appendOutput("stdout", "after")
	if live := session.snapshot().OutputChunks; live != 1 {
		t.Fatalf("post-clear append produced %d chunks, want 1", live)
	}
	if tail := session.tail(0); len(tail) != 1 || tail[0].Content != "after" {
		t.Fatalf("post-clear tail = %#v, want just the new chunk", tail)
	}
}
