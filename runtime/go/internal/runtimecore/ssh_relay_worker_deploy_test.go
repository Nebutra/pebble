package runtimecore

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestBundledRelayWorkerPathResolvesEveryPackagedTarget(t *testing.T) {
	directory := t.TempDir()
	for _, target := range []relayPlatform{
		{goos: "darwin", goarch: "amd64"},
		{goos: "darwin", goarch: "arm64"},
		{goos: "linux", goarch: "amd64"},
		{goos: "linux", goarch: "arm64"},
		{goos: "windows", goarch: "amd64"},
		{goos: "windows", goarch: "arm64"},
	} {
		extension := ""
		if target.goos == "windows" {
			extension = ".exe"
		}
		name := "pebble-relay-worker-" + target.goos + "-" + target.goarch + extension
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, []byte("worker"), 0o600); err != nil {
			t.Fatal(err)
		}
		actual, err := bundledRelayWorkerPath(directory, target.goos, target.goarch)
		if err != nil || actual != path {
			t.Fatalf("resolve %s/%s = %q, %v; want %q", target.goos, target.goarch, actual, err, path)
		}
	}
}

func TestBundledRelayWorkerPathRejectsMissingAndUnsupportedTargets(t *testing.T) {
	if _, err := bundledRelayWorkerPath(t.TempDir(), "linux", "amd64"); err == nil {
		t.Fatal("missing packaged worker must fail")
	}
	if _, err := bundledRelayWorkerPath(t.TempDir(), "freebsd", "amd64"); err == nil {
		t.Fatal("unsupported packaged worker target must fail")
	}
}

func TestParseRelayPlatformSupportsWindowsOpenSshArchitectures(t *testing.T) {
	for input, expected := range map[string]relayPlatform{
		"Windows X64\r\n":   {goos: "windows", goarch: "amd64"},
		"windows Arm64\r\n": {goos: "windows", goarch: "arm64"},
		"Linux x86_64\n":    {goos: "linux", goarch: "amd64"},
		"Darwin arm64\n":    {goos: "darwin", goarch: "arm64"},
	} {
		actual, err := parseRelayPlatform(input)
		if err != nil || actual != expected {
			t.Fatalf("parseRelayPlatform(%q) = %#v, %v; want %#v", input, actual, err, expected)
		}
	}
}

func TestParseRelayPlatformRejectsUnsupportedWindowsArchitecture(t *testing.T) {
	if _, err := parseRelayPlatform("windows x86"); err == nil || !strings.Contains(err.Error(), "windows/x86") {
		t.Fatalf("expected bounded unsupported-platform error, got %v", err)
	}
}

func TestWindowsRelayPlatformProbeUsesEncodedPowerShell(t *testing.T) {
	script := decodePowerShellCommandForTest(t, windowsRelayPlatformProbeCommand())
	if !strings.Contains(script, "RuntimeInformation]::OSArchitecture") || !strings.Contains(script, "windows ") {
		t.Fatalf("unexpected Windows platform probe: %s", script)
	}
}

func TestWindowsRelayDeployReadsBinaryStdinAndReturnsAbsolutePath(t *testing.T) {
	script := decodePowerShellCommandForTest(t, relayWorkerDeployCommand(relayPlatform{goos: "windows", goarch: "amd64"}))
	for _, required := range []string{"OpenStandardInput", "CopyTo", "Move-Item", windowsRelayWorkerRelativePath, "Write-Output $dst"} {
		if !strings.Contains(script, required) {
			t.Fatalf("Windows deploy script omitted %q: %s", required, script)
		}
	}
	if !isWindowsAbsolutePath(`C:\Users\Pebble User\.pebble\bin\pebble-relay-worker.exe`) {
		t.Fatal("drive-qualified Windows worker path must be accepted on every client OS")
	}
	if !isWindowsAbsolutePath(`\\server\profile\.pebble\bin\pebble-relay-worker.exe`) {
		t.Fatal("UNC Windows worker path must be accepted")
	}
	if isWindowsAbsolutePath(`.pebble\bin\pebble-relay-worker.exe`) {
		t.Fatal("relative Windows worker path must be rejected")
	}
}

func TestWindowsRelayInvocationPreservesPathAndArgumentLiterals(t *testing.T) {
	command := remoteWorkerCommand(sshRelayWorkerDeployment{
		platform: relayPlatform{goos: "windows", goarch: "amd64"},
		path:     `C:\Users\Pebble User\.pebble\bin\pebble-relay-worker.exe`,
	}, []string{"file-list-json", "--root", `C:\repo with space\it's here`})
	script := decodePowerShellCommandForTest(t, command)
	for _, required := range []string{
		`& 'C:\Users\Pebble User\.pebble\bin\pebble-relay-worker.exe'`,
		`'file-list-json'`,
		`'C:\repo with space\it''s here'`,
		`exit $LASTEXITCODE`,
	} {
		if !strings.Contains(script, required) {
			t.Fatalf("Windows worker command omitted %q: %s", required, script)
		}
	}
}

func TestWindowsMissingRelayWorkerTriggersDeployment(t *testing.T) {
	message := "pebble-relay-worker.exe : The term 'pebble-relay-worker.exe' is not recognized as the name of a cmdlet"
	if !isMissingRelayWorkerError(assertionError(message)) {
		t.Fatal("PowerShell command-not-found must trigger native worker deployment")
	}
}

func decodePowerShellCommandForTest(t *testing.T, command string) string {
	t.Helper()
	const marker = "-EncodedCommand "
	index := strings.Index(command, marker)
	if index < 0 {
		t.Fatalf("command is not encoded PowerShell: %s", command)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(command[index+len(marker):]))
	if err != nil || len(raw)%2 != 0 {
		t.Fatalf("decode command: %v", err)
	}
	units := make([]uint16, len(raw)/2)
	for index := range units {
		units[index] = uint16(raw[index*2]) | uint16(raw[index*2+1])<<8
	}
	return string(utf16.Decode(units))
}
