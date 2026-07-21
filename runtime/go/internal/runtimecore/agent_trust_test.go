package runtimecore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestAgentTrustPresetsPreserveExistingConfiguration(t *testing.T) {
	home := t.TempDir()
	workspace := filepath.Join(home, "workspace")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".copilot"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".copilot", "config.json"), []byte(`{"theme":"dark"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := markCopilotWorkspaceTrusted(home, workspace); err != nil {
		t.Fatal(err)
	}
	var copilot map[string]any
	if err := json.Unmarshal(mustReadAgentTrustFile(t, filepath.Join(home, ".copilot", "config.json")), &copilot); err != nil {
		t.Fatal(err)
	}
	if copilot["theme"] != "dark" || len(copilot["trustedFolders"].([]any)) != 1 {
		t.Fatalf("unexpected Copilot config: %#v", copilot)
	}

	codex := filepath.Join(home, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(codex), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(codex, []byte("model = \"gpt-5\"\n\n[projects.\""+workspace+"\"]\ntrust_level = \"untrusted\"\n\n[other]\nvalue = true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := markCodexWorkspaceTrusted(codex, workspace); err != nil {
		t.Fatal(err)
	}
	updated := string(mustReadAgentTrustFile(t, codex))
	if !strings.Contains(updated, `trust_level = "trusted"`) || !strings.Contains(updated, "[other]\nvalue = true") {
		t.Fatalf("unexpected Codex config: %s", updated)
	}

	if err := markCursorWorkspaceTrusted(home, workspace); err != nil {
		t.Fatal(err)
	}
	slug := regexpAgentTrustSlug(workspace)
	var cursor map[string]string
	if err := json.Unmarshal(mustReadAgentTrustFile(t, filepath.Join(home, ".cursor", "projects", slug, ".workspace-trusted")), &cursor); err != nil {
		t.Fatal(err)
	}
	if cursor["workspacePath"] != workspace || cursor["trustedAt"] == "" {
		t.Fatalf("unexpected Cursor marker: %#v", cursor)
	}
}

func TestAgentTrustRejectsRelativeAndCorruptInputs(t *testing.T) {
	if _, err := validatedAgentTrustWorkspace("relative/workspace"); err == nil {
		t.Fatal("expected relative workspace path to be rejected")
	}
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".copilot"), 0o755); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(home, ".copilot", "config.json")
	if err := os.WriteFile(config, []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := markCopilotWorkspaceTrusted(home, filepath.Join(home, "workspace")); err == nil {
		t.Fatal("expected corrupt Copilot config to be preserved")
	}
	if string(mustReadAgentTrustFile(t, config)) != "not json" {
		t.Fatal("corrupt Copilot config was overwritten")
	}
}

func regexpAgentTrustSlug(workspace string) string {
	slug := strings.TrimLeft(workspace, `/\`)
	return regexp.MustCompile(`[\\/:*?"<>|]+`).ReplaceAllString(slug, "-")
}

func mustReadAgentTrustFile(t *testing.T, path string) []byte {
	t.Helper()
	bytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return bytes
}
