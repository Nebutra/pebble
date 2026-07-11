package runtimecore

import (
	"strings"
	"sync"
	"testing"
	"time"
)

type recordedEmit struct {
	topic   string
	payload map[string]interface{}
}

type emitRecorder struct {
	mu     sync.Mutex
	events []recordedEmit
}

func (r *emitRecorder) emit(topic string, payload interface{}) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, recordedEmit{topic: topic, payload: payload.(map[string]interface{})})
}

func (r *emitRecorder) snapshot() []recordedEmit {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]recordedEmit(nil), r.events...)
}

func newTestOutputEmitter(recorder *emitRecorder, maxBytes int) *sessionOutputEmitter {
	emitter := &sessionOutputEmitter{}
	emitter.configure(recorder.emit)
	emitter.emitDelay = 5 * time.Millisecond
	emitter.maxBytes = maxBytes
	return emitter
}

func testOutputChunk(content string) OutputChunk {
	return OutputChunk{At: time.Now().UTC(), Stream: "stdout", Content: content}
}

func TestSessionOutputEmitterCoalescesRapidChunks(t *testing.T) {
	recorder := &emitRecorder{}
	emitter := newTestOutputEmitter(recorder, maxSessionOutputEventBytes)
	session := Session{ID: "sess-1"}
	for i := 0; i < 50; i++ {
		emitter.append(testOutputChunk("line\n"), session)
	}
	emitter.flushNow()
	events := recorder.snapshot()
	if len(events) < 1 || len(events) >= 50 {
		t.Fatalf("expected coalesced emission (1..49 events), got %d", len(events))
	}
	var combined strings.Builder
	var chunks int
	for _, event := range events {
		if event.topic != "session.output" {
			t.Fatalf("unexpected topic %q", event.topic)
		}
		chunk := event.payload["chunk"].(OutputChunk)
		combined.WriteString(chunk.Content)
		chunks += event.payload["coalescedChunks"].(int)
	}
	if combined.String() != strings.Repeat("line\n", 50) {
		t.Fatalf("coalesced content lost data: got %d bytes", combined.Len())
	}
	if chunks != 50 {
		t.Fatalf("expected 50 coalesced chunks accounted for, got %d", chunks)
	}
}

func TestSessionOutputEmitterBoundsPayloadAndCountsDrops(t *testing.T) {
	recorder := &emitRecorder{}
	emitter := newTestOutputEmitter(recorder, 16)
	session := Session{ID: "sess-1"}
	emitter.append(testOutputChunk("0123456789"), session)
	emitter.append(testOutputChunk("abcdefghij"), session)
	emitter.flushNow()
	events := recorder.snapshot()
	if len(events) != 1 {
		t.Fatalf("expected a single flush, got %d", len(events))
	}
	chunk := events[0].payload["chunk"].(OutputChunk)
	if chunk.Content != "456789abcdefghij" {
		t.Fatalf("expected newest 16-byte tail, got %q", chunk.Content)
	}
	if dropped := events[0].payload["droppedBytes"].(int); dropped != 4 {
		t.Fatalf("expected 4 dropped bytes, got %d", dropped)
	}
}

func TestSessionOutputEmitterFlushNowDrainsPendingWindow(t *testing.T) {
	recorder := &emitRecorder{}
	emitter := newTestOutputEmitter(recorder, maxSessionOutputEventBytes)
	emitter.emitDelay = time.Hour
	emitter.append(testOutputChunk("tail\n"), Session{ID: "sess-2"})
	if len(recorder.snapshot()) != 0 {
		t.Fatal("append must not emit before the window elapses")
	}
	emitter.flushNow()
	events := recorder.snapshot()
	if len(events) != 1 {
		t.Fatalf("expected one flushed event, got %d", len(events))
	}
	if session := events[0].payload["session"].(Session); session.ID != "sess-2" {
		t.Fatalf("expected session snapshot on payload, got %q", session.ID)
	}
	emitter.flushNow()
	if len(recorder.snapshot()) != 1 {
		t.Fatal("empty flush must not emit")
	}
}
