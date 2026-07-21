package runtimehttp

import (
	"encoding/json"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestLegacySharedControlHostCapabilitiesExposeRuntimeHost(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	methods := []string{
		"provider.list", "providers.list", "nativeProvider.list",
		"provider.status", "subsystem.status",
		"preflight.detectWindowsTerminalCapabilities",
		"host.platform", "host.wsl.isAvailable", "host.wsl.listDistros",
		"host.pwsh.isAvailable", "host.gitBash.isAvailable",
	}
	for _, method := range methods {
		params := json.RawMessage(`{}`)
		if method == "provider.status" || method == "subsystem.status" {
			params = json.RawMessage(`{"subsystem":"browser"}`)
		}
		if _, handled, callErr := server.runLegacySharedControlHostCapabilityMethod(method, params); !handled || callErr != nil {
			t.Errorf("method %q: handled=%v err=%v", method, handled, callErr)
		}
	}
}
