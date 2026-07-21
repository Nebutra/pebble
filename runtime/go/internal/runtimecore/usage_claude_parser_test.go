package runtimecore

import (
	"strings"
	"testing"
)

func TestReadClaudeUsageTurnsMatchesStreamingDedupeSemantics(t *testing.T) {
	input := strings.Join([]string{
		`{"type":"user","sessionId":"session-1","timestamp":"2026-01-01T00:00:00Z"}`,
		`{"type":"assistant","sessionId":"session-1","timestamp":"2026-01-01T00:01:00Z","requestId":"request-1","message":{"id":"message-1","model":"claude-sonnet","usage":{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4}}}`,
		`{"type":"assistant","sessionId":"session-1","timestamp":"2026-01-01T00:01:01Z","requestId":"request-1","message":{"id":"message-1","model":"claude-sonnet","usage":{"input_tokens":12,"output_tokens":8,"cache_read_input_tokens":2,"cache_creation_input_tokens":5}}}`,
	}, "\n")
	turns, err := readClaudeUsageTurns(strings.NewReader(input), "fallback")
	if err != nil {
		t.Fatal(err)
	}
	if len(turns) != 1 {
		t.Fatalf("expected one deduplicated turn, got %#v", turns)
	}
	turn := turns[0]
	if turn.InputTokens != 12 || turn.OutputTokens != 8 || turn.CacheReadTokens != 3 || turn.CacheWriteTokens != 5 {
		t.Fatalf("streaming usage maxima drifted: %#v", turn)
	}
}

func TestClaudeUsageLineUsesFilenameSessionFallbackAndRejectsEmptyUsage(t *testing.T) {
	valid := parseClaudeUsageLine(`{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"usage":{"output_tokens":1}}}`, "file-session")
	if valid == nil || valid.SessionID != "file-session" {
		t.Fatalf("fallback session missing: %#v", valid)
	}
	if parseClaudeUsageLine(`{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"usage":{}}}`, "file-session") != nil {
		t.Fatal("zero-usage rows must not become turns")
	}
}
