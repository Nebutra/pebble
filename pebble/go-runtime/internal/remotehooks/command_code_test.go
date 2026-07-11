package remotehooks

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallCommandCodePreservesUserHooksAndWritesManagedEvents(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, ".commandcode", "settings.json")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	existing := `{"hooks":{"PreToolUse":[{"hooks":[{"command":"user-hook"}]},{"hooks":[{"command":"/old/.pebble/agent-hooks/command-code-hook.sh"}]}],"Custom":[{"hooks":[{"command":"custom-hook"}]}]}}`
	if err := os.WriteFile(configPath, []byte(existing), 0o600); err != nil {
		t.Fatal(err)
	}

	status := installCommandCode(home)
	if status.State != "installed" || !status.ManagedHooksPresent {
		t.Fatalf("unexpected status: %+v", status)
	}
	config := readTestConfig(t, configPath)
	hooks := config["hooks"].(map[string]any)
	if len(hooks["PreToolUse"].([]any)) != 2 || len(hooks["Custom"].([]any)) != 1 {
		t.Fatalf("user hooks were not preserved: %+v", hooks)
	}
	for _, event := range []string{"PreToolUse", "PostToolUse", "Stop"} {
		definitions := hooks[event].([]any)
		managed := definitions[len(definitions)-1].(map[string]any)
		if event == "Stop" && managed["matcher"] != nil {
			t.Fatalf("Stop must not have a matcher: %+v", managed)
		}
		if event != "Stop" && managed["matcher"] != ".*" {
			t.Fatalf("matcher missing for %s: %+v", event, managed)
		}
		handler := managed["hooks"].([]any)[0].(map[string]any)
		if handler["timeout"].(float64) != 10 || !strings.Contains(handler["command"].(string), "command-code-hook.sh") {
			t.Fatalf("invalid managed handler for %s: %+v", event, handler)
		}
	}
}

func TestCommandCodeScriptRecoversSanitizedEnvironment(t *testing.T) {
	required := []string{
		`/proc/$pid/environ`,
		`ps eww -p "$pid"`,
		`pebble-dev/agent-hooks"/*/endpoint.env`,
		`[ "$endpoint_port" = "$PEBBLE_AGENT_HOOK_PORT" ]`,
		`/hook/command-code`,
		`payload@-`,
	}
	for _, marker := range required {
		if !strings.Contains(commandCodeScript, marker) {
			t.Fatalf("managed script is missing %q", marker)
		}
	}
}
