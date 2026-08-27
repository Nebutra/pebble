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
	// Why the window still needs a cap: a command dumping megabytes between
	// flushes would otherwise retain all of it. Whole parts are now sent as soon
	// as they fill, so the retained buffer stays under one part instead of being
	// trimmed down to one — bounded memory without discarding bytes.
	var written strings.Builder
	for range 200 {
		emitter.append(testOutputChunk("0123456789"), session)
		written.WriteString("0123456789")
		emitter.mu.Lock()
		held := len(emitter.buffer)
		emitter.mu.Unlock()
		if held > emitter.maxBytes {
			t.Fatalf("window grew to %d bytes, past the %d cap", held, emitter.maxBytes)
		}
	}
	emitter.flushNow()

	events := recorder.snapshot()
	var combined strings.Builder
	for i, event := range events {
		content := event.payload["chunk"].(OutputChunk).Content
		if len(content) > 16 {
			t.Fatalf("event %d is %d bytes, over the budget", i, len(content))
		}
		if _, dropped := event.payload["droppedBytes"]; dropped {
			t.Fatalf("event %d still reports droppedBytes", i)
		}
		combined.WriteString(content)
	}
	// Why every byte and not a tail: this is a terminal's byte stream, and a gap
	// in it truncates an escape sequence rather than merely losing some text.
	if combined.String() != written.String() {
		t.Fatalf("delivered %d bytes of %d", combined.Len(), written.Len())
	}
}

func TestSessionOutputEmitterWindowsDoNotLeakIntoEachOther(t *testing.T) {
	recorder := &emitRecorder{}
	emitter := newTestOutputEmitter(recorder, 16)
	session := Session{ID: "sess-1"}
	// Why the first window has to overflow: the buffer is reused rather than
	// regrown from nil, so the reset only gets exercised once it has split.
	first := strings.Repeat("first", 8)
	emitter.append(testOutputChunk(first), session)
	emitter.flushNow()
	firstCount := len(recorder.snapshot())
	if firstCount < 2 {
		t.Fatalf("expected the 40-byte window to split, got %d events", firstCount)
	}
	emitter.append(testOutputChunk("second"), session)
	emitter.flushNow()

	events := recorder.snapshot()
	var firstWindow strings.Builder
	for _, event := range events[:firstCount] {
		firstWindow.WriteString(event.payload["chunk"].(OutputChunk).Content)
	}
	if firstWindow.String() != first {
		t.Fatalf("first window delivered %q, want %q", firstWindow.String(), first)
	}
	// Why: a shorter window must not expose the bytes a longer one left behind.
	if content := events[len(events)-1].payload["chunk"].(OutputChunk).Content; content != "second" {
		t.Fatalf("second window leaked the first: %q", content)
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
