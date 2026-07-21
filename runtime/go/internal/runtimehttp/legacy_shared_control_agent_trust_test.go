package runtimehttp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestLegacySharedControlAgentTrustWritesRemoteHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{manager: manager}
	workspace := filepath.Join(home, "remote-workspace")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]string{"preset": "copilot", "workspacePath": workspace})
	result, handled, err := server.runLegacySharedControlAgentTrustMethod("agentTrust.markTrusted", raw)
	if err != nil || !handled {
		t.Fatalf("unexpected trust result: %#v handled=%v err=%v", result, handled, err)
	}
	config, err := os.ReadFile(filepath.Join(home, ".copilot", "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid(config) {
		t.Fatalf("invalid remote Copilot config: %s", config)
	}
}

func TestLegacySharedControlAgentTrustRejectsInvalidRequest(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{manager: manager}
	if _, handled, err := server.runLegacySharedControlAgentTrustMethod("agentTrust.markTrusted", json.RawMessage(`{"preset":"codex","workspacePath":"relative"}`)); !handled || err == nil {
		t.Fatalf("expected handled invalid request, got handled=%v err=%v", handled, err)
	}
	if _, handled, err := server.runLegacySharedControlAgentTrustMethod("other.method", nil); handled || err != nil {
		t.Fatalf("unexpected unrelated method handling: handled=%v err=%v", handled, err)
	}
}
