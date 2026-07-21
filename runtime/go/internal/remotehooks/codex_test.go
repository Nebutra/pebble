package remotehooks

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallCodexWritesSixHooksAndMatchingTrust(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, ".codex", "hooks.json")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	existing := `{"hooks":{"Stop":[{"hooks":[{"command":"user-hook"}]}]},"_managed":{"external-manager":{"Stop":[0]}}}`
	if err := os.WriteFile(configPath, []byte(existing), 0o600); err != nil {
		t.Fatal(err)
	}
	status := installCodex(home)
	if status.State != "installed" {
		t.Fatalf("unexpected status: %+v", status)
	}
	config := readTestConfig(t, configPath)
	if config["_managed"] == nil {
		t.Fatal("remote top-level metadata was not preserved")
	}
	hooks := config["hooks"].(map[string]any)
	toml, _ := os.ReadFile(filepath.Join(home, ".codex/config.toml"))
	command := managedCommand(filepath.Join(home, ".pebble/agent-hooks/codex-hook.sh"))
	for _, event := range codexEvents {
		definitions := hooks[event.name].([]any)
		groupIndex := len(definitions) - 1
		handler := definitions[groupIndex].(map[string]any)["hooks"].([]any)[0].(map[string]any)
		if handler["timeout"].(float64) != 10 {
			t.Fatalf("timeout missing for %s", event.name)
		}
		key := configPath + ":" + event.label + ":" + string(rune('0'+groupIndex)) + ":0"
		if !strings.Contains(string(toml), key) || !strings.Contains(string(toml), codexTrustedHash(event.label, command)) {
			t.Fatalf("trust missing for %s:\n%s", event.name, toml)
		}
	}
}

func TestCodexTrustHashMatchesKnownCanonicalIdentity(t *testing.T) {
	command := "if [ -x '/home/dev/.pebble/agent-hooks/codex-hook.sh' ]; then /bin/sh '/home/dev/.pebble/agent-hooks/codex-hook.sh'; fi"
	if got, want := codexTrustedHash("permission_request", command), "sha256:9f0be15d55a155c7d31cc44f6579889ab15a714cd23522cb2d41232f3df55cdd"; got != want {
		t.Fatalf("hash drifted: got %s want %s", got, want)
	}
}

func TestUpsertCodexTrustBlockPreservesDisabledAndOtherToml(t *testing.T) {
	entry := codexTrustEntry{key: "/home/dev/.codex/hooks.json:stop:0:0", hash: "sha256:new"}
	existing := "model = \"gpt\"\n\n[hooks.state.\"/home/dev/.codex/hooks.json:stop:0:0\"]\nenabled = false\ntrusted_hash = \"sha256:old\"\n\n[projects.\"/repo\"]\ntrust_level = \"trusted\"\n"
	updated := upsertCodexTrustBlock(existing, entry)
	if strings.Count(updated, entry.key) != 1 || !strings.Contains(updated, "enabled = false") || !strings.Contains(updated, "trusted_hash = \"sha256:new\"") || !strings.Contains(updated, "trust_level = \"trusted\"") {
		t.Fatalf("trust upsert corrupted TOML:\n%s", updated)
	}
}
