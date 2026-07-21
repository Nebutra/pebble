package remotehooks

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestInstallHermesPreservesConfigAndEnablesManagedPlugin(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, ".hermes", "config.yaml")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	existing := "model: custom\nplugins:\n  enabled: [user-plugin]\n  disabled: [pebble-status, other-plugin]\n"
	if err := os.WriteFile(configPath, []byte(existing), 0o600); err != nil {
		t.Fatal(err)
	}

	status := installHermes(home)
	if status.State != "installed" || !status.ManagedHooksPresent {
		t.Fatalf("unexpected status: %+v", status)
	}
	content, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := yaml.Unmarshal(content, &config); err != nil {
		t.Fatal(err)
	}
	if config["model"] != "custom" {
		t.Fatalf("unrelated config was lost: %+v", config)
	}
	plugins := config["plugins"].(map[string]any)
	if !strings.Contains(strings.Join(anyStrings(plugins["enabled"]), ","), "pebble-status") || strings.Contains(strings.Join(anyStrings(plugins["disabled"]), ","), "pebble-status") {
		t.Fatalf("plugin enablement did not converge: %+v", plugins)
	}
	manifest, _ := os.ReadFile(filepath.Join(home, ".hermes/plugins/pebble-status/plugin.yaml"))
	for _, event := range hermesEvents {
		if !strings.Contains(string(manifest), "  - "+event) {
			t.Fatalf("manifest missing %s", event)
		}
	}
}

func TestInstallHermesDoesNotOverwriteUserPlugin(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, ".hermes/plugins/pebble-status/__init__.py")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("# user plugin\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	status := installHermes(home)
	if status.State != "partial" || status.ManagedHooksPresent {
		t.Fatalf("user plugin was not protected: %+v", status)
	}
	content, _ := os.ReadFile(path)
	if string(content) != "# user plugin\n" {
		t.Fatal("user plugin was overwritten")
	}
}

func TestHermesPluginSourceCompiles(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not installed")
	}
	path := filepath.Join(t.TempDir(), "hermes_plugin.py")
	if err := os.WriteFile(path, []byte(hermesPluginSource), 0o600); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command(python, "-m", "py_compile", path).CombinedOutput(); err != nil {
		t.Fatalf("generated plugin does not compile: %v\n%s", err, output)
	}
}

func anyStrings(value any) []string {
	values, _ := value.([]any)
	result := make([]string, 0, len(values))
	for _, value := range values {
		if item, ok := value.(string); ok {
			result = append(result, item)
		}
	}
	return result
}
