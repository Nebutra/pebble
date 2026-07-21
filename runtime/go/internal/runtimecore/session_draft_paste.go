package runtimecore

import (
	"context"
	"errors"
	"strings"
	"time"
)

const (
	draftPasteReadyTimeout = 8 * time.Second
	draftPasteQuietWindow  = 1500 * time.Millisecond
)

func (m *Manager) PasteSessionDraftWhenReady(ctx context.Context, sessionID, draft, signal string) error {
	ctx, cancel := context.WithTimeout(ctx, draftPasteReadyTimeout)
	defer cancel()
	scanner := newSessionDraftReadyScanner(signal)
	seenChunks := 0
	lastChunkFingerprint := ""
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		tail, err := m.TailSession(sessionID, 2000)
		if err != nil {
			return err
		}
		start := seenChunks
		if len(tail.Chunks) > 0 {
			last := tail.Chunks[len(tail.Chunks)-1]
			fingerprint := last.At.String() + "\x00" + last.Content
			if len(tail.Chunks) <= seenChunks && fingerprint != lastChunkFingerprint {
				// Why: the session output ring replaces its oldest chunk at capacity;
				// rescan the bounded window so a readiness marker is never skipped.
				start = 0
			}
			lastChunkFingerprint = fingerprint
		}
		if start < len(tail.Chunks) {
			for _, chunk := range tail.Chunks[start:] {
				scanner.observe(chunk.Content, time.Now())
			}
			seenChunks = len(tail.Chunks)
		}
		if scanner.ready(time.Now()) {
			clean := sanitizeSessionDraft(draft)
			return m.WriteSession(sessionID, SessionInputRequest{Text: "\x1b[200~" + clean + "\x1b[201~"})
		}
		select {
		case <-ctx.Done():
			return errors.New("agent draft input did not become ready before timeout")
		case <-ticker.C:
		}
	}
}

func sanitizeSessionDraft(draft string) string {
	return strings.ReplaceAll(draft, "\x1b[201~", "")
}

type sessionDraftReadyScanner struct {
	signal       string
	recent       string
	sawHandshake bool
	lastOutputAt time.Time
	markerReady  bool
}

func newSessionDraftReadyScanner(signal string) *sessionDraftReadyScanner {
	return &sessionDraftReadyScanner{signal: signal}
}

func (s *sessionDraftReadyScanner) observe(data string, now time.Time) {
	combined := s.recent + data
	if !s.sawHandshake {
		index := strings.Index(combined, "\x1b[?2004h")
		if index < 0 {
			s.recent = suffix(combined, 512)
			return
		}
		s.sawHandshake = true
		combined = combined[index+len("\x1b[?2004h"):]
	}
	s.lastOutputAt = now
	marker := ""
	if s.signal == "codex-composer-prompt" {
		marker = "›"
	} else if s.signal == "render-cursor-after-bracketed-paste" {
		marker = "\x1b[?25h"
	}
	if marker != "" && strings.Contains(combined, marker) {
		s.markerReady = true
	}
	s.recent = suffix(combined, 512)
}

func (s *sessionDraftReadyScanner) ready(now time.Time) bool {
	if !s.sawHandshake {
		return false
	}
	if s.signal == "codex-composer-prompt" || s.signal == "render-cursor-after-bracketed-paste" {
		return s.markerReady
	}
	return !s.lastOutputAt.IsZero() && now.Sub(s.lastOutputAt) >= draftPasteQuietWindow
}

func suffix(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[len(value)-limit:]
}
