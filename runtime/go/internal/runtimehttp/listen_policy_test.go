package runtimehttp

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRequestFromLoopback(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		remote string
		want   bool
	}{
		{"127.0.0.1:54321", true},
		{"[::1]:54321", true},
		{"192.168.1.20:54321", false},
		{"10.0.0.8:9", false},
	} {
		req := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
		req.RemoteAddr = tc.remote
		if got := requestFromLoopback(req); got != tc.want {
			t.Fatalf("remote %s: got %v want %v", tc.remote, got, tc.want)
		}
	}
}

func TestIsNonLoopbackSharedControlPath(t *testing.T) {
	t.Parallel()
	ws := httptest.NewRequest(http.MethodGet, "/v1/shared-control", nil)
	ws.Header.Set("Upgrade", "websocket")
	ws.Header.Set("Connection", "Upgrade")
	if !isNonLoopbackSharedControlPath(ws) {
		t.Fatal("shared-control websocket upgrade must be allowed off-loopback")
	}

	sessions := httptest.NewRequest(http.MethodPost, "/v1/sessions", nil)
	if isNonLoopbackSharedControlPath(sessions) {
		t.Fatal("control sessions must not be allowed off-loopback")
	}

	pairing := httptest.NewRequest(http.MethodPost, "/v1/shared-control/pairing", nil)
	if isNonLoopbackSharedControlPath(pairing) {
		t.Fatal("pairing mint stays on the loopback control plane")
	}

	plain := httptest.NewRequest(http.MethodGet, "/v1/shared-control", nil)
	if isNonLoopbackSharedControlPath(plain) {
		t.Fatal("non-upgrade shared-control GET is not the public LAN surface")
	}
}

func TestResolveListenAddress(t *testing.T) {
	t.Parallel()
	if got := resolveListenAddress("127.0.0.1:17777", false); got != "127.0.0.1:17777" {
		t.Fatalf("default bind changed: %s", got)
	}
	if got := resolveListenAddress("127.0.0.1:17777", true); got != "0.0.0.0:17777" {
		t.Fatalf("opt-in should widen loopback bind: %s", got)
	}
	if got := resolveListenAddress("0.0.0.0:6768", true); got != "0.0.0.0:6768" {
		t.Fatalf("wildcard listen should stay: %s", got)
	}
	if got := resolveListenAddress("192.168.1.20:6768", true); got != "192.168.1.20:6768" {
		t.Fatalf("explicit LAN listen should stay: %s", got)
	}
}
