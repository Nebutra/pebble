package remotehooks

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallKimiPreservesUserTOMLAndConverges(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, ".kimi-code", "config.toml")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	userConfig := "default_model = \"kimi-k2.6\"\n\n[providers.\"mine\"]\napi_key = \"sk-secret\"\n"
	if err := os.WriteFile(configPath, []byte(userConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	if status := installKimi(home); status.State != "installed" {
		t.Fatalf("unexpected status: %+v", status)
	}
	first, _ := os.ReadFile(configPath)
	if !strings.Contains(string(first), userConfig[:len(userConfig)-1]) || strings.Count(string(first), kimiBlockStart) != 1 {
		t.Fatalf("user TOML or managed block is invalid:\n%s", first)
	}
	for _, event := range kimiEvents {
		if !strings.Contains(string(first), `event = "`+event+`"`) {
			t.Fatalf("missing event %s", event)
		}
	}
	backup, _ := os.ReadFile(configPath + ".bak")
	if string(backup) != userConfig {
		t.Fatal("rolling backup does not contain original config")
	}
	if status := installKimi(home); status.State != "installed" {
		t.Fatalf("reinstall failed: %+v", status)
	}
	second, _ := os.ReadFile(configPath)
	if string(second) != string(first) || strings.Count(string(second), kimiBlockStart) != 1 {
		t.Fatal("reinstall did not converge")
	}
}

func TestInstallKimiRepairsOrphanedManagedBlock(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, ".kimi-code", "config.toml")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	orphaned := "model = \"custom\"\n\n" + kimiBlockStart + "\n[[hooks]]\nevent = \"Stop\"\n"
	if err := os.WriteFile(configPath, []byte(orphaned), 0o600); err != nil {
		t.Fatal(err)
	}
	installKimi(home)
	content, _ := os.ReadFile(configPath)
	if strings.Count(string(content), kimiBlockStart) != 1 || !strings.Contains(string(content), kimiBlockEnd) || !strings.Contains(string(content), `model = "custom"`) {
		t.Fatalf("orphaned block was not repaired:\n%s", content)
	}
}
