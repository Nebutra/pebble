package remotehooks

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallAmpWritesCompleteBoundedPlugin(t *testing.T) {
	home := t.TempDir()
	status := installAmp(home)
	if status.State != "installed" || !status.ManagedHooksPresent {
		t.Fatalf("unexpected status: %+v", status)
	}
	content, err := os.ReadFile(filepath.Join(home, ".config/amp/plugins/pebble-agent-status.ts"))
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"session.start", "agent.start", "tool.call", "tool.result", "agent.end", "MAX_PENDING_POSTS=50", "PEBBLE_AGENT_HOOK_ENDPOINT", "AbortController"} {
		if !strings.Contains(string(content), expected) {
			t.Fatalf("missing %s", expected)
		}
	}
}

func TestInstallAmpDoesNotOverwriteUserPlugin(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, ".config/amp/plugins/pebble-agent-status.ts")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("export default function userPlugin() {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	status := installAmp(home)
	if status.State != "partial" || status.ManagedHooksPresent {
		t.Fatalf("unexpected status: %+v", status)
	}
	content, _ := os.ReadFile(path)
	if string(content) != "export default function userPlugin() {}\n" {
		t.Fatal("user plugin was overwritten")
	}
}
