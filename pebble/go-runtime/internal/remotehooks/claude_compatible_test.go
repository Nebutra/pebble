package remotehooks

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestInstallClaudeCompatiblePreservesUserHooksAndWritesExecutables(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	content := `{"theme":"dark","hooks":{"Stop":[{"hooks":[{"command":"user-hook"},{"command":"/old/agent-hooks/claude-hook.sh"}]}]}}`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	statuses := InstallClaudeCompatible(home)
	if len(statuses) != 2 || statuses[0].State != "installed" || statuses[1].State != "installed" {
		t.Fatalf("unexpected statuses: %+v", statuses)
	}
	for _, agent := range compatibleAgents {
		configPath := filepath.Join(home, agent.configDir, "settings.json")
		var config map[string]any
		content, err := os.ReadFile(configPath)
		if err != nil || json.Unmarshal(content, &config) != nil {
			t.Fatalf("invalid %s config: %v", agent.name, err)
		}
		hooks := config["hooks"].(map[string]any)
		if len(hooks) != len(claudeEvents) {
			t.Fatalf("%s missing events: %+v", agent.name, hooks)
		}
		if agent.name == "claude" && !strings.Contains(string(content), "user-hook") {
			t.Fatal("Claude user hook was dropped")
		}
		if strings.Contains(string(content), "/old/agent-hooks/") {
			t.Fatal("stale command survived")
		}
		info, err := os.Stat(filepath.Join(home, ".pebble", "agent-hooks", agent.script))
		if err != nil {
			t.Fatal(err)
		}
		if runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
			t.Fatalf("unexpected mode %o", info.Mode().Perm())
		}
	}
}

func TestInstallClaudeCompatibleRejectsRelativeHome(t *testing.T) {
	for _, status := range InstallClaudeCompatible("relative") {
		if status.State != "error" {
			t.Fatalf("expected error: %+v", status)
		}
	}
}
