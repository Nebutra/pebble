package remotehooks

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallAntigravityPreservesBundlesAndMixedSchema(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, ".gemini/config/hooks.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"user":{"Stop":[{"command":"user-hook"}]},"pebble-status":{"Old":[{"command":"/old/agent-hooks/antigravity-hook.sh"}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	status := installAntigravity(home)
	if status.State != "installed" {
		t.Fatalf("unexpected status: %+v", status)
	}
	config := readTestConfig(t, path)
	if config["user"].(map[string]any)["Stop"] == nil {
		t.Fatal("user bundle dropped")
	}
	bundle := config["pebble-status"].(map[string]any)
	if len(bundle) != 4 || bundle["Old"] != nil {
		t.Fatalf("invalid bundle: %+v", bundle)
	}
	tool := bundle["PostToolUse"].([]any)[0].(map[string]any)
	if tool["matcher"] != "*" || tool["hooks"] == nil {
		t.Fatalf("wrong tool schema: %+v", tool)
	}
	stop := bundle["Stop"].([]any)[0].(map[string]any)
	if stop["command"] == nil || stop["hooks"] != nil {
		t.Fatalf("wrong direct schema: %+v", stop)
	}
}

func TestInstallCopilotWritesThirteenEventSpecificCommands(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, ".copilot/hooks/pebble.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"disableAllHooks":true,"hooks":{"Custom":[{"bash":"user-hook"}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	status := installCopilot(home)
	if status.State != "installed" {
		t.Fatalf("unexpected status: %+v", status)
	}
	config := readTestConfig(t, path)
	if config["version"].(float64) != 1 || config["disableAllHooks"] != nil {
		t.Fatal("Copilot top-level schema not normalized")
	}
	hooks := config["hooks"].(map[string]any)
	if len(hooks) != len(copilotEvents)+1 {
		t.Fatalf("wrong event count: %+v", hooks)
	}
	for _, event := range copilotEvents {
		definition := hooks[event].([]any)[0].(map[string]any)
		command := definition["bash"].(string)
		if !strings.Contains(command, "PEBBLE_COPILOT_HOOK_EVENT='"+event+"'") || definition["timeoutSec"].(float64) != 5 {
			t.Fatalf("wrong %s definition: %+v", event, definition)
		}
	}
}
