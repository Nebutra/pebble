package remotehooks

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestInstallAllForWindowsReturnsFourteenProviderStatuses(t *testing.T) {
	home := t.TempDir()
	statuses := InstallAllForPlatform(home, "windows")
	if len(statuses) != 14 {
		t.Fatalf("expected fourteen provider statuses, got %+v", statuses)
	}
	expected := windowsAgentNames()
	for index, status := range statuses {
		if status.Agent != expected[index] || status.State != "installed" || !status.ManagedHooksPresent {
			t.Fatalf("provider %d did not install independently: %+v", index, status)
		}
		if status.ConfigPath == "" {
			t.Fatalf("provider %s omitted its config path", status.Agent)
		}
	}
}

func TestWindowsManagedHooksUseProviderNativePayloads(t *testing.T) {
	t.Setenv("SystemRoot", `C:\Windows`)
	home := t.TempDir()
	if statuses := InstallAllForPlatform(home, "windows"); len(statuses) != 14 {
		t.Fatal("Windows install did not return the complete provider matrix")
	}

	assertFileContains(t, filepath.Join(home, ".pebble", "agent-hooks", "claude-hook.cmd"), "curl.exe", "payload@-", "PEBBLE_AGENT_HOOK_ENDPOINT")
	assertFileContains(t, filepath.Join(home, ".pebble", "agent-hooks", "gemini-hook.cmd"), "echo {}", "curl.exe")
	assertFileContains(t, filepath.Join(home, ".pebble", "agent-hooks", "copilot-hook.ps1"), "Write-Output '{}'", "Invoke-WebRequest", "hookEventName")
	assertFileContains(t, filepath.Join(home, ".pebble", "agent-hooks", "antigravity-stop.cmd"), "PEBBLE_ANTIGRAVITY_EVENT=Stop")
	assertFileContains(t, filepath.Join(home, ".pebble", "agent-hooks", "antigravity-hook.cmd"), `{"decision":""}`, "hook_event_name")
	assertFileContains(t, filepath.Join(home, ".pebble", "agent-hooks", "kimi-hook.sh"), "#!/bin/sh", "/hook/kimi")
	assertFileContains(t, filepath.Join(home, ".hermes", "plugins", "pebble-status", "__init__.py"), "/hook/hermes")
	assertFileContains(t, filepath.Join(home, ".config", "amp", "plugins", "pebble-agent-status.ts"), "/hook/amp")

	claude := readTestConfig(t, filepath.Join(home, ".claude", "settings.json"))
	command := claude["hooks"].(map[string]any)[claudeEvents[0]].([]any)[0].(map[string]any)["hooks"].([]any)[0].(map[string]any)["command"].(string)
	if !strings.Contains(command, "C:/Windows/System32/WindowsPowerShell") || !strings.Contains(command, "EncodedCommand") {
		t.Fatalf("Claude did not receive its Git-Bash-safe Windows launcher: %q", command)
	}

	copilot := readTestConfig(t, filepath.Join(home, ".copilot", "hooks", "pebble.json"))
	definition := copilot["hooks"].(map[string]any)[copilotEvents[0]].([]any)[0].(map[string]any)
	if definition["powershell"] == nil || definition["bash"] != nil {
		t.Fatalf("Copilot did not receive its native powershell field: %+v", definition)
	}

	devinPath := filepath.Join(home, "AppData", "Roaming", "devin", "config.json")
	devin := readTestConfig(t, devinPath)
	devinCommand := devin["hooks"].(map[string]any)[devinEvents[0]].([]any)[0].(map[string]any)["hooks"].([]any)[0].(map[string]any)["command"].(string)
	if !strings.HasPrefix(devinCommand, "cmd /d /s /c") {
		t.Fatalf("Devin did not receive its cmd.exe launcher: %q", devinCommand)
	}
}

func TestWindowsInstallConvergesAndPreservesUserHooks(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, ".cursor", "hooks.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"hooks":{"custom":[{"type":"command","command":"user-owned"}],"stop":[{"type":"command","command":"C:\\old\\agent-hooks\\cursor-hook.cmd"}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	InstallAllForPlatform(home, "windows")
	first, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	InstallAllForPlatform(home, "windows")
	second, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Fatal("Windows reinstall did not converge")
	}
	config := readTestConfig(t, path)
	hooks := config["hooks"].(map[string]any)
	if hooks["custom"].([]any)[0].(map[string]any)["command"] != "user-owned" || len(hooks["stop"].([]any)) != 1 {
		t.Fatalf("user hook was lost or stale managed hook duplicated: %+v", hooks)
	}
}

func TestWindowsPowerShellLauncherEncodesExactManagedPath(t *testing.T) {
	t.Setenv("SystemRoot", `C:\Windows`)
	path := `C:\Users\Ada Lovelace\.pebble\agent-hooks\claude-hook.cmd`
	launcher := windowsPowerShellCmdLauncher(path)
	encoded := launcher[strings.LastIndex(launcher, " ")+1:]
	bytes, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	words := make([]uint16, 0, len(bytes)/2)
	for index := 0; index < len(bytes); index += 2 {
		words = append(words, uint16(bytes[index])|uint16(bytes[index+1])<<8)
	}
	decoded := string(utf16.Decode(words))
	if decoded != `& 'C:\Users\Ada Lovelace\.pebble\agent-hooks\claude-hook.cmd'` {
		t.Fatalf("launcher changed the managed path: %q", decoded)
	}
}

func TestWindowsInvalidHomeReportsEveryProviderSeparately(t *testing.T) {
	statuses := InstallAllForPlatform("relative", "windows")
	if len(statuses) != 14 {
		t.Fatalf("expected fourteen typed errors, got %+v", statuses)
	}
	for _, status := range statuses {
		if status.Agent == "" || status.State != "error" || !strings.Contains(status.Detail, "absolute") {
			t.Fatalf("invalid provider error: %+v", status)
		}
	}
}

func assertFileContains(t *testing.T, path string, needles ...string) {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, needle := range needles {
		if !strings.Contains(string(content), needle) {
			t.Fatalf("%s does not contain %q", path, needle)
		}
	}
}
