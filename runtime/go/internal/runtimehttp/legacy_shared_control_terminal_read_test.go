package runtimehttp

import (
	"encoding/json"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestLegacySharedControlTranscriptRequestAcceptsStringAndNumericCursors(t *testing.T) {
	for _, raw := range []string{`{"cursor":"42","limit":7}`, `{"cursor":42,"limit":7}`} {
		cursor, limit, err := readLegacySharedControlTranscriptRequest(json.RawMessage(raw))
		if err != nil || cursor == nil || *cursor != 42 || limit != 7 {
			t.Fatalf("unexpected parsed request for %s: cursor=%v limit=%d err=%v", raw, cursor, limit, err)
		}
	}
}

func TestLegacySharedControlTranscriptRequestRejectsFractionalCursor(t *testing.T) {
	if _, _, err := readLegacySharedControlTranscriptRequest(json.RawMessage(`{"cursor":1.5}`)); err == nil {
		t.Fatal("expected invalid cursor error")
	}
}

func TestLegacySharedControlTerminalReadPreservesAuthoritativeMetadata(t *testing.T) {
	result := legacySharedControlTerminalReadResult("sess-1", runtimecore.SessionRunning, runtimecore.TerminalTranscriptRead{
		Tail:              []string{"line"},
		Truncated:         true,
		Limited:           true,
		OldestCursor:      "10",
		NextCursor:        "11",
		LatestCursor:      "20",
		ReturnedLineCount: 1,
	})
	if result["truncated"] != true || result["limited"] != true || result["oldestCursor"] != "10" || result["nextCursor"] != "11" || result["latestCursor"] != "20" {
		t.Fatalf("authoritative transcript metadata was lost: %#v", result)
	}
}
