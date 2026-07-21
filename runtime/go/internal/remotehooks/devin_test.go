package remotehooks

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallDevinParsesJSONCAndPreservesUserConfig(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, ".config", "devin", "config.json")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	existing := `{
  // Devin permits comments and trailing commas.
  "permissions": {"mode": "normal"},
  "read_config_from": {"claude": true},
  "hooks": {"PreToolUse": [{"hooks": [{"command": "user-hook"}]}]},
}`
	if err := os.WriteFile(configPath, []byte(existing), 0o600); err != nil {
		t.Fatal(err)
	}

	status := installDevin(home)
	if status.State != "installed" || !strings.Contains(status.Detail, "Claude hooks") {
		t.Fatalf("unexpected status: %+v", status)
	}
	config := readTestConfig(t, configPath)
	if config["permissions"].(map[string]any)["mode"] != "normal" {
		t.Fatalf("unrelated config was lost: %+v", config)
	}
	hooks := config["hooks"].(map[string]any)
	if len(hooks["PreToolUse"].([]any)) != 2 {
		t.Fatalf("user hook was not preserved: %+v", hooks)
	}
	for _, event := range devinEvents {
		definitions := hooks[event].([]any)
		managed := definitions[len(definitions)-1].(map[string]any)
		if managed["matcher"] != nil {
			t.Fatalf("Devin matcher must be omitted for %s", event)
		}
		command := managed["hooks"].([]any)[0].(map[string]any)["command"].(string)
		if !strings.Contains(command, "devin-hook.sh") {
			t.Fatalf("managed command missing for %s", event)
		}
	}
	script, _ := os.ReadFile(filepath.Join(home, ".pebble/agent-hooks/devin-hook.sh"))
	if !strings.Contains(string(script), "/hook/devin") {
		t.Fatal("Devin transport endpoint missing")
	}
}

func TestInstallDevinLeavesMalformedJSONCUntouched(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, ".config", "devin", "config.json")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	original := []byte(`{"hooks": }`)
	if err := os.WriteFile(configPath, original, 0o600); err != nil {
		t.Fatal(err)
	}
	status := installDevin(home)
	if status.State != "error" || !strings.Contains(status.Detail, "Could not parse") && !strings.Contains(status.Detail, "could not parse") {
		t.Fatalf("malformed JSONC was not rejected: %+v", status)
	}
	content, _ := os.ReadFile(configPath)
	if string(content) != string(original) {
		t.Fatal("malformed config was overwritten")
	}
	if _, err := os.Stat(filepath.Join(home, ".pebble/agent-hooks/devin-hook.sh")); !os.IsNotExist(err) {
		t.Fatal("script was published after config parse failure")
	}
}
