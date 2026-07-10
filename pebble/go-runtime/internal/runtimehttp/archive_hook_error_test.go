package runtimehttp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

// The renderer distinguishes an archive-hook veto from generic delete failures
// by the stable code and captured output, so the mapping is contract-tested.
func TestWriteRuntimeErrorMapsArchiveHookVeto(t *testing.T) {
	hookErr := &runtimecore.ArchiveHookError{Output: "veto-output"}
	rec := httptest.NewRecorder()
	writeRuntimeError(rec, fmt.Errorf("delete worktree: %w", hookErr))
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", rec.Code)
	}
	var payload map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["code"] != "archive-hook-failed" {
		t.Fatalf("expected archive-hook-failed code, got %#v", payload)
	}
	if payload["hookOutput"] != "veto-output" {
		t.Fatalf("expected captured hook output, got %#v", payload)
	}
}
