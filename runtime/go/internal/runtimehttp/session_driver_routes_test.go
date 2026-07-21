package runtimehttp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestDesktopSessionInputLockedReturns423AndReclaimReleases(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	sessionID := "sess-driver-http"
	manager.MobileTookSessionFloor(sessionID, "device-1")

	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(
		http.MethodPost,
		"/v1/sessions/"+sessionID+"/input",
		strings.NewReader(`{"text":"x","source":"desktop"}`),
	))
	if rec.Code != http.StatusLocked {
		t.Fatalf("expected 423 for desktop input while mobile drives, got %d: %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(
		http.MethodPost,
		"/v1/sessions/"+sessionID+"/resize",
		strings.NewReader(`{"cols":120,"rows":30,"source":"desktop"}`),
	))
	if rec.Code != http.StatusLocked {
		t.Fatalf("expected 423 for desktop resize while mobile drives, got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/sessions/"+sessionID+"/driver", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 driver read, got %d", rec.Code)
	}
	var driver runtimecore.SessionDriverState
	if err := json.Unmarshal(rec.Body.Bytes(), &driver); err != nil {
		t.Fatal(err)
	}
	if driver.Kind != "mobile" || driver.ClientID != "device-1" {
		t.Fatalf("expected mobile driver snapshot, got %+v", driver)
	}

	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/sessions/"+sessionID+"/reclaim-desktop", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 reclaim, got %d", rec.Code)
	}
	var reclaim map[string]bool
	if err := json.Unmarshal(rec.Body.Bytes(), &reclaim); err != nil {
		t.Fatal(err)
	}
	if !reclaim["reclaimed"] {
		t.Fatal("expected reclaimed=true while mobile held the floor")
	}

	// After reclaim the desktop write reaches the session lookup (404 here:
	// no live PTY in this test) instead of the 423 lock.
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(
		http.MethodPost,
		"/v1/sessions/"+sessionID+"/input",
		strings.NewReader(`{"text":"x","source":"desktop"}`),
	))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 after reclaim for missing session, got %d", rec.Code)
	}
}

func TestMobileResizeRouteRestoresDesktopFitOnReclaim(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY fit integration uses /bin/sh")
	}
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.StartSession(context.Background(), runtimecore.StartSessionRequest{ProjectID: project.ID, Command: []string{"/bin/sh"}, Cols: 126, Rows: 38})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = manager.StopSession(session.ID) })
	server := NewServer(manager)

	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/sessions/"+session.ID+"/resize", strings.NewReader(`{"cols":72,"rows":22,"source":"mobile","clientId":"phone-1"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected mobile resize 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if driver := manager.GetSessionDriver(session.ID); driver.Kind != "mobile" || driver.ClientID != "phone-1" {
		t.Fatalf("mobile resize did not take floor: %+v", driver)
	}

	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/sessions/"+session.ID+"/reclaim-desktop", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected reclaim 200, got %d: %s", rec.Code, rec.Body.String())
	}
	restored, err := manager.SessionStatus(session.ID)
	if err != nil || restored.Cols != 126 || restored.Rows != 38 || manager.GetSessionDriver(session.ID).Kind != "desktop" {
		t.Fatalf("reclaim did not restore desktop state: %+v, %v", restored, err)
	}
}
