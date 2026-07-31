package runtimehttp

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestNonLoopbackRemotesAreNotFilteredWithoutLanSharedControl(t *testing.T) {
	t.Parallel()
	manager := newTestManager(t)
	server := NewServerWithOptions(manager, ServerOptions{})

	// Why: without opt-in the TCP listener is loopback-only, so ServeHTTP must
	// not interpret httptest's default 192.0.2.1 RemoteAddr as an off-host peer.
	req := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
	req.RemoteAddr = "192.168.1.50:40000"
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("without LAN opt-in, RemoteAddr must not gate control, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestLanSharedControlAllowsOnlySharedControlOffLoopback(t *testing.T) {
	t.Parallel()
	manager := newTestManager(t)
	server := NewServerWithOptions(manager, ServerOptions{AllowNonLoopbackSharedControl: true})

	// Control plane stays forbidden from a non-loopback remote even with empty bearer.
	sessions := httptest.NewRequest(http.MethodPost, "/v1/sessions", strings.NewReader(`{"command":["true"]}`))
	sessions.RemoteAddr = "192.168.1.50:40000"
	sessions.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, sessions)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("POST /v1/sessions must stay loopback-only, got %d body=%s", rec.Code, rec.Body.String())
	}

	// Localhost-label proxy path must not run for non-loopback remotes.
	label := httptest.NewRequest(http.MethodGet, "http://app.localhost:17777/", nil)
	label.RemoteAddr = "192.168.1.50:40002"
	label.Host = "app.localhost:17777"
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, label)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("localhost-label must stay loopback-only, got %d body=%s", rec.Code, rec.Body.String())
	}

	// Shared-control upgrade is admitted past the LAN gate (authorize + upgrade may still
	// fail later without full WS hijack in httptest — we only assert not Forbidden).
	ws := httptest.NewRequest(http.MethodGet, "/v1/shared-control", nil)
	ws.RemoteAddr = "192.168.1.50:40001"
	ws.Header.Set("Upgrade", "websocket")
	ws.Header.Set("Connection", "Upgrade")
	ws.Header.Set("Sec-WebSocket-Version", "13")
	ws.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, ws)
	if rec.Code == http.StatusForbidden {
		t.Fatalf("shared-control websocket must be allowed off-loopback when opted in: %s", rec.Body.String())
	}

	// Loopback control plane still works with empty bearer (today's model).
	loopbackStatus := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
	loopbackStatus.RemoteAddr = "127.0.0.1:50000"
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, loopbackStatus)
	if rec.Code != http.StatusOK {
		t.Fatalf("loopback status should succeed, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestStartWithOptionsLanSharedControlBindAndLayering(t *testing.T) {
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	_ = probe.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager := newTestManager(t)
	errCh := make(chan error, 1)
	go func() {
		errCh <- StartWithOptions(ctx, fmt.Sprintf("127.0.0.1:%d", port), manager, ServerOptions{
			AllowNonLoopbackSharedControl: true,
		})
	}()
	defer func() {
		cancel()
		select {
		case <-errCh:
		case <-time.After(3 * time.Second):
		}
	}()

	client := &http.Client{Timeout: 500 * time.Millisecond}
	deadline := time.Now().Add(3 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/v1/status", port))
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				lastErr = nil
				break
			}
			lastErr = fmt.Errorf("status %d", resp.StatusCode)
		} else {
			lastErr = err
		}
		time.Sleep(20 * time.Millisecond)
	}
	if lastErr != nil {
		t.Fatalf("loopback control plane not ready: %v", lastErr)
	}

	// Prove opt-in rewrote the bind off pure loopback: a second listener on the
	// same loopback port must fail while the server is up (port owned on all ifaces).
	if conflict, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", port)); err == nil {
		_ = conflict.Close()
		t.Fatal("expected 0.0.0.0 bind to own the port when LAN shared-control is on")
	}

	// Multi-homed dial when the host has a usable non-loopback IPv4. Some VPN/UTUN
	// addresses accept TCP but never complete HTTP; treat network errors as "handler
	// did not succeed". RemoteAddr unit tests are the authoritative R2/R3 gate.
	lanHost, ok := firstNonLoopbackIPv4()
	if !ok {
		t.Log("no non-loopback IPv4 on this host; RemoteAddr unit tests cover the gate")
		return
	}
	sessionsURL := fmt.Sprintf("http://%s/v1/sessions", net.JoinHostPort(lanHost, fmt.Sprint(port)))
	req, err := http.NewRequest(http.MethodPost, sessionsURL, strings.NewReader(`{"command":["true"]}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Logf("LAN control dial did not complete (%v); control handler was not successfully executed", err)
	} else {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		_ = resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			t.Fatalf("LAN POST /v1/sessions must not succeed, body=%s", body)
		}
		if resp.StatusCode != http.StatusForbidden {
			t.Logf("LAN POST /v1/sessions returned %d (want Forbidden when HTTP completes)", resp.StatusCode)
		}
	}

	wsReq, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://%s/v1/shared-control", net.JoinHostPort(lanHost, fmt.Sprint(port))), nil)
	if err != nil {
		t.Fatal(err)
	}
	wsReq.Header.Set("Upgrade", "websocket")
	wsReq.Header.Set("Connection", "Upgrade")
	wsReq.Header.Set("Sec-WebSocket-Version", "13")
	wsReq.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	wsResp, err := client.Do(wsReq)
	if err != nil {
		t.Logf("LAN shared-control dial incomplete on %s (%v); bind ownership check already passed", lanHost, err)
		return
	}
	// Why: a successful websocket upgrade leaves a live body stream. Draining it
	// with io.Copy hangs forever on hosted runners (package timeout 10m). Only
	// peek a bounded payload for non-upgrade responses.
	if wsResp.StatusCode == http.StatusSwitchingProtocols {
		_ = wsResp.Body.Close()
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(wsResp.Body, 1024))
	_ = wsResp.Body.Close()
	if wsResp.StatusCode == http.StatusForbidden {
		t.Fatalf("LAN shared-control must be admitted past the loopback gate, got %d", wsResp.StatusCode)
	}
}

func TestStartWithOptionsDefaultStaysLoopbackOnly(t *testing.T) {
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	_ = probe.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager := newTestManager(t)
	errCh := make(chan error, 1)
	go func() {
		errCh <- StartWithOptions(ctx, fmt.Sprintf("127.0.0.1:%d", port), manager, ServerOptions{})
	}()
	defer func() {
		cancel()
		select {
		case <-errCh:
		case <-time.After(3 * time.Second):
		}
	}()

	client := &http.Client{Timeout: 300 * time.Millisecond}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/v1/status", port))
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}

	lanHost, ok := firstNonLoopbackIPv4()
	if !ok {
		t.Log("no non-loopback IPv4; skip bind-scope check")
		return
	}
	resp, err := client.Get(fmt.Sprintf("http://%s/v1/status", net.JoinHostPort(lanHost, fmt.Sprint(port))))
	if err == nil {
		_ = resp.Body.Close()
		t.Fatalf("default loopback bind must not accept LAN status connections (got HTTP %d)", resp.StatusCode)
	}
}

func firstNonLoopbackIPv4() (string, bool) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "", false
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() || ip.To4() == nil {
				continue
			}
			return ip.String(), true
		}
	}
	return "", false
}

func newTestManager(t *testing.T) *runtimecore.Manager {
	t.Helper()
	dir := t.TempDir()
	manager, err := runtimecore.NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { manager.Shutdown() })
	return manager
}
