package runtimecore

import (
	"testing"
	"time"
)

func TestSessionDraftReadyScannerQuietGate(t *testing.T) {
	scanner := newSessionDraftReadyScanner("render-quiet-after-bracketed-paste")
	now := time.Now()
	scanner.observe("\x1b[?20", now)
	scanner.observe("04hready", now.Add(10*time.Millisecond))
	if scanner.ready(now.Add(time.Second)) {
		t.Fatal("quiet gate fired before the canonical quiet window")
	}
	if !scanner.ready(now.Add(2 * time.Second)) {
		t.Fatal("quiet gate did not fire after bracketed-paste readiness")
	}
}

func TestSessionDraftReadyScannerMarkerGates(t *testing.T) {
	now := time.Now()
	codex := newSessionDraftReadyScanner("codex-composer-prompt")
	codex.observe("›\x1b[?2004h", now)
	if codex.ready(now.Add(3 * time.Second)) {
		t.Fatal("a prompt rendered before the handshake must not count")
	}
	codex.observe("render ›", now.Add(time.Second))
	if !codex.ready(now.Add(time.Second)) {
		t.Fatal("post-handshake Codex composer prompt must be ready")
	}
	cursor := newSessionDraftReadyScanner("render-cursor-after-bracketed-paste")
	cursor.observe("\x1b[?2004h", now)
	cursor.observe("\x1b[?25h", now.Add(time.Second))
	if !cursor.ready(now.Add(time.Second)) {
		t.Fatal("post-handshake cursor marker must be ready")
	}
}

func TestSessionDraftPasteSanitizesEmbeddedTerminator(t *testing.T) {
	if clean := sanitizeSessionDraft("hello\x1b[201~world"); clean != "helloworld" {
		t.Fatalf("unexpected sanitized draft %q", clean)
	}
}
