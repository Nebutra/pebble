package runtimehttp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

// isolateAiVaultScanHome points every root the local AI Vault scan walks at an
// empty temporary home. Without it the scan reads the developer's real agent
// transcripts, which makes the test machine-dependent and slow enough to time
// out under -race on a workstation with a large history.
func isolateAiVaultScanHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	// Why: each of these relocates one agent's history outright, so an empty HOME
	// alone still leaves the scan pointed at whatever the developer has set.
	for _, name := range []string{
		"CODEX_HOME",
		"COPILOT_HOME",
		"PI_CODING_AGENT_DIR",
		"OPENCODE_CONFIG_DIR",
		"GROK_HOME",
		"OPENCLAW_STATE_DIR",
		"DEVIN_HOME",
		"KIMI_CODE_HOME",
	} {
		t.Setenv(name, filepath.Join(home, "absent", name))
	}
	return home
}

// writeClaudeAiVaultTranscript seeds one discoverable Claude session recorded
// against cwd, so the scan has something local to find rather than asserting
// over an empty result.
func writeClaudeAiVaultTranscript(t *testing.T, home, sessionID, cwd string) {
	t.Helper()
	dir := filepath.Join(home, ".claude", "projects", "pebble")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	record, err := json.Marshal(map[string]any{
		"sessionId": sessionID,
		"cwd":       cwd,
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
		"type":      "user",
		"content":   "review the pairing flow",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, sessionID+".jsonl"), append(record, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestLegacySharedControlAiVaultScansPairedHostLocally(t *testing.T) {
	home := isolateAiVaultScanHome(t)
	scope := t.TempDir()
	writeClaudeAiVaultTranscript(t, home, "paired-session", scope)
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{manager: manager}
	raw, _ := json.Marshal(runtimecore.AiVaultListRequest{
		Limit:              7,
		ExecutionHostScope: "all",
		ScopePaths:         []string{scope},
	})
	value, handled, err := server.runLegacySharedControlAiVaultMethod(context.Background(), "aiVault.listSessions", raw)
	if err != nil || !handled {
		t.Fatalf("unexpected AI Vault dispatch: handled=%v err=%v", handled, err)
	}
	result := value.(runtimecore.AiVaultListResult)
	for _, issue := range result.Issues {
		if issue.ExecutionHostID != "local" {
			t.Fatalf("paired scan escaped local host: %#v", issue)
		}
	}
	// Why: no paired host is reachable from this runtime, so an "all" scope must
	// still resolve every hit to the local host rather than attributing one to a
	// remote it never talked to.
	if len(result.Sessions) != 1 {
		t.Fatalf("expected the one seeded session, got %#v", result.Sessions)
	}
	session := result.Sessions[0]
	if session.ExecutionHostID != "local" || session.SessionID != "paired-session" {
		t.Fatalf("paired scan escaped local host: %#v", session)
	}
}

func TestLegacySharedControlAiVaultIgnoresOtherMethods(t *testing.T) {
	server := &Server{}
	if _, handled, err := server.runLegacySharedControlAiVaultMethod(context.Background(), "other.method", nil); handled || err != nil {
		t.Fatalf("unexpected unrelated method handling: handled=%v err=%v", handled, err)
	}
}
