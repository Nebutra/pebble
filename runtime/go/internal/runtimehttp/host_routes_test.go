package runtimehttp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestHostTerminalCapabilitiesEndpoint(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	req := httptest.NewRequest(http.MethodGet, "/v1/host/terminal-capabilities", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var caps struct {
		WSLAvailable     bool     `json:"wslAvailable"`
		WSLDistros       []string `json:"wslDistros"`
		PwshAvailable    bool     `json:"pwshAvailable"`
		GitBashAvailable bool     `json:"gitBashAvailable"`
		HostPlatform     *string  `json:"hostPlatform"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &caps); err != nil {
		t.Fatal(err)
	}
	if caps.WSLDistros == nil {
		t.Fatal("wslDistros must serialize as an array, not null")
	}
	if caps.HostPlatform == nil {
		t.Fatal("hostPlatform must be present")
	}
	// Off Windows (the CI/dev platform here) every probe is false by contract.
	if runtime.GOOS != "windows" {
		if caps.WSLAvailable || caps.PwshAvailable || caps.GitBashAvailable {
			t.Fatalf("expected all-false off Windows, got %+v", caps)
		}
		if len(caps.WSLDistros) != 0 {
			t.Fatalf("expected no distros off Windows, got %v", caps.WSLDistros)
		}
	}
}

func TestHostTerminalCapabilitiesRejectsPost(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	req := httptest.NewRequest(http.MethodPost, "/v1/host/terminal-capabilities", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}
