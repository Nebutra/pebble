package runtimecore

import (
	"strings"
	"sync"
	"testing"
	"unicode/utf8"
)

// Why this matters beyond a byte count: the coalescer used to drop bytes from
// the MIDDLE of a PTY stream, and a PTY stream is protocol, not text. A hole
// truncates an escape sequence, so the terminal misreads everything after it —
// characters vanish, the cursor lands in the wrong cell, and whatever the
// previous frame left there stays on screen. A single 80KB burst lost 49KB.
func TestSessionOutputEmitterDeliversEveryByteOfABurst(t *testing.T) {
	var mu sync.Mutex
	var parts []string
	var chunkCounts []int
	emitter := &sessionOutputEmitter{}
	emitter.configure(func(topic string, payload interface{}) {
		if topic != "session.output" {
			return
		}
		body := payload.(map[string]interface{})
		mu.Lock()
		parts = append(parts, body["chunk"].(OutputChunk).Content)
		chunkCounts = append(chunkCounts, body["coalescedChunks"].(int))
		if _, dropped := body["droppedBytes"]; dropped {
			t.Error("payload still reports droppedBytes")
		}
		mu.Unlock()
	})

	// Faithful to readStream: 4096 bytes per read, in a tight loop. A command
	// dumping output fills the pipe faster than the 1ms window closes, so the
	// reads land in one window. Twenty of them is 80KB — far less than a
	// `cargo test` or a long diff actually produces.
	const reads = 20
	line := "\x1b[38;5;244m" + strings.Repeat("x", 200) + "\x1b[0m\r\n"
	chunk := strings.Repeat(line, 4096/len(line)+1)[:4096]
	var written strings.Builder
	for i := 0; i < reads; i++ {
		emitter.append(OutputChunk{Stream: "stdout", Content: chunk}, Session{})
		written.WriteString(chunk)
	}
	emitter.flushNow()

	mu.Lock()
	defer mu.Unlock()
	joined := strings.Join(parts, "")
	if joined != written.String() {
		t.Fatalf("delivered %d bytes of %d, and not byte-identical", len(joined), written.Len())
	}
	if len(parts) < 2 {
		t.Fatalf("emitted %d events; a burst past the budget must be split", len(parts))
	}
	for i, part := range parts {
		if len(part) > maxSessionOutputEventBytes {
			t.Fatalf("part %d is %d bytes, over the %d budget", i, len(part), maxSessionOutputEventBytes)
		}
	}
	t.Logf("%d bytes delivered across %d bounded parts, nothing dropped", len(joined), len(parts))
}

// Why: the point of coalescing is that ordinary shell echo stays one event.
func TestSessionOutputEmitterStillCoalescesASmallWindow(t *testing.T) {
	var mu sync.Mutex
	var parts []string
	emitter := &sessionOutputEmitter{}
	emitter.configure(func(_ string, payload interface{}) {
		mu.Lock()
		parts = append(parts, payload.(map[string]interface{})["chunk"].(OutputChunk).Content)
		mu.Unlock()
	})

	for _, text := range []string{"$ ", "echo hi", "\r\n", "hi\r\n"} {
		emitter.append(OutputChunk{Stream: "stdout", Content: text}, Session{})
	}
	emitter.flushNow()

	mu.Lock()
	defer mu.Unlock()
	if len(parts) != 1 || parts[0] != "$ echo hi\r\nhi\r\n" {
		t.Fatalf("expected one coalesced event, got %#v", parts)
	}
}

// Why: a multibyte rune split across a part boundary would serialise as
// malformed text, which is the reason the old trim walked to a rune start.
func TestSessionOutputEmitterNeverSplitsARune(t *testing.T) {
	var mu sync.Mutex
	var parts []string
	emitter := &sessionOutputEmitter{}
	emitter.configure(func(_ string, payload interface{}) {
		mu.Lock()
		parts = append(parts, payload.(map[string]interface{})["chunk"].(OutputChunk).Content)
		mu.Unlock()
	})

	// 3-byte runes do not divide the budget evenly, so a naive split lands
	// inside one.
	burst := strings.Repeat("界", maxSessionOutputEventBytes)
	emitter.append(OutputChunk{Stream: "stdout", Content: burst}, Session{})
	emitter.flushNow()

	mu.Lock()
	defer mu.Unlock()
	joined := strings.Join(parts, "")
	if joined != burst {
		t.Fatalf("delivered %d bytes of %d", len(joined), len(burst))
	}
	for i, part := range parts {
		if !utf8.ValidString(part) {
			t.Fatalf("part %d is not valid UTF-8", i)
		}
	}
}
