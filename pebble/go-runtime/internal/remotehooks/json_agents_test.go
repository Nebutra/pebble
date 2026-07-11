package remotehooks

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readTestConfig(t *testing.T, path string) map[string]any {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := json.Unmarshal(content, &config); err != nil {
		t.Fatal(err)
	}
	return config
}

func TestInstallAllWritesGeminiCursorAndDroidSchemas(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".gemini"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".gemini/settings.json"), []byte(`{"hooks":{"PreToolUse":[{"hooks":[{"command":"/old/agent-hooks/gemini-hook.sh"}]}],"Custom":[{"hooks":[{"command":"user-hook"}]}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	statuses := InstallAll(home)
	if len(statuses) != 14 {
		t.Fatalf("expected fourteen statuses, got %+v", statuses)
	}
	for _, status := range statuses {
		if status.State != "installed" {
			t.Fatalf("unexpected status: %+v", status)
		}
	}

	gemini := readTestConfig(t, filepath.Join(home, ".gemini/settings.json"))
	geminiHooks := gemini["hooks"].(map[string]any)
	if len(geminiHooks) != len(geminiEvents)+1 || geminiHooks["PreToolUse"] != nil {
		t.Fatalf("invalid Gemini events: %+v", geminiHooks)
	}
	for _, event := range geminiEvents {
		definition := geminiHooks[event].([]any)[0].(map[string]any)
		handler := definition["hooks"].([]any)[0].(map[string]any)
		if handler["timeout"].(float64) != 10000 {
			t.Fatalf("wrong Gemini timeout: %+v", handler)
		}
	}
	geminiScript, _ := os.ReadFile(filepath.Join(home, ".pebble/agent-hooks/gemini-hook.sh"))
	if !strings.HasPrefix(string(geminiScript), "#!/bin/sh\nprintf '{}\\n'") {
		t.Fatal("Gemini JSON stdout contract missing")
	}

	cursor := readTestConfig(t, filepath.Join(home, ".cursor/hooks.json"))
	if cursor["version"].(float64) != 1 {
		t.Fatal("Cursor version missing")
	}
	for _, event := range cursorEvents {
		definition := cursor["hooks"].(map[string]any)[event].([]any)[0].(map[string]any)
		if definition["command"] == nil || definition["hooks"] != nil {
			t.Fatalf("wrong Cursor schema: %+v", definition)
		}
	}

	droid := readTestConfig(t, filepath.Join(home, ".factory/settings.json"))
	droidHooks := droid["hooks"].(map[string]any)
	if len(droidHooks) != 8 {
		t.Fatalf("wrong Droid events: %+v", droidHooks)
	}
	for _, event := range []string{"PreToolUse", "PostToolUse", "PermissionRequest"} {
		definition := droidHooks[event].([]any)[0].(map[string]any)
		if definition["matcher"] != "*" {
			t.Fatalf("matcher missing for %s", event)
		}
	}

	grok := readTestConfig(t, filepath.Join(home, ".grok/hooks/pebble-status.json"))
	grokHooks := grok["hooks"].(map[string]any)
	if len(grokHooks) != 8 {
		t.Fatalf("wrong Grok events: %+v", grokHooks)
	}
	for _, event := range []string{"PreToolUse", "PostToolUse", "PostToolUseFailure"} {
		definition := grokHooks[event].([]any)[0].(map[string]any)
		if definition["matcher"] != "*" {
			t.Fatalf("Grok matcher missing for %s", event)
		}
	}
}
