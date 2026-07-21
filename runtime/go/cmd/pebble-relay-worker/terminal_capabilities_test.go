package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"runtime"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/hostprobe"
)

func TestTerminalCapabilitiesJSONReportsRelayHostPlatform(t *testing.T) {
	var output bytes.Buffer
	if err := run([]string{"terminal-capabilities-json"}, &http.Client{}, &output); err != nil {
		t.Fatal(err)
	}
	var capabilities hostprobe.TerminalCapabilities
	if err := json.Unmarshal(output.Bytes(), &capabilities); err != nil {
		t.Fatalf("invalid terminal capability JSON: %v", err)
	}
	wantPlatform := map[string]string{"darwin": "darwin", "linux": "linux", "windows": "win32"}[runtime.GOOS]
	if capabilities.HostPlatform == nil || *capabilities.HostPlatform != wantPlatform {
		t.Fatalf("host platform = %v, want %q", capabilities.HostPlatform, wantPlatform)
	}
	if capabilities.WSLDistros == nil {
		t.Fatal("wslDistros must serialize as an array")
	}
}
