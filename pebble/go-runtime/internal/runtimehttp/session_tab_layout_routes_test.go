package runtimehttp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

func sessionRoutesTestServer(t *testing.T) (*Server, *runtimecore.Manager) {
	t.Helper()
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	return NewServer(manager), manager
}

func TestSessionTabLayoutRoutes(t *testing.T) {
	server, _ := sessionRoutesTestServer(t)

	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/session-tab-layouts/wt-1", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 before save, got %d: %s", rec.Code, rec.Body.String())
	}

	body := strings.NewReader(`{"activeTabId":"tab-2","tabGroups":[{"id":"g1"}]}`)
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/v1/session-tab-layouts/wt-1", body))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on save, got %d: %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/session-tab-layouts/wt-1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 after save, got %d: %s", rec.Code, rec.Body.String())
	}
	var layout runtimecore.SessionTabLayout
	if err := json.Unmarshal(rec.Body.Bytes(), &layout); err != nil {
		t.Fatal(err)
	}
	if layout.ActiveTabID != "tab-2" || layout.SnapshotVersion != 1 {
		t.Fatalf("unexpected layout: %#v", layout)
	}
}

func TestSessionPlacementHookStatusAndWaitRoutes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("session routes test uses a POSIX shell")
	}
	server, manager := sessionRoutesTestServer(t)
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(
		http.MethodPost,
		"/v1/sessions",
		strings.NewReader(`{"projectId":"`+project.ID+`","command":["/bin/sh","-c","sleep 5"],"tabId":"tab-old"}`),
	))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 session, got %d: %s", rec.Code, rec.Body.String())
	}
	var session runtimecore.Session
	if err := json.Unmarshal(rec.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = manager.StopSession(session.ID) })

	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(
		http.MethodPatch,
		"/v1/sessions/"+session.ID,
		strings.NewReader(`{"tabId":"tab-new","leafId":"leaf-new"}`),
	))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on placement patch, got %d: %s", rec.Code, rec.Body.String())
	}
	var moved runtimecore.Session
	if err := json.Unmarshal(rec.Body.Bytes(), &moved); err != nil {
		t.Fatal(err)
	}
	if moved.TabID != "tab-new" || moved.LeafID != "leaf-new" {
		t.Fatalf("expected moved placement, got %#v", moved)
	}

	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(
		http.MethodPost,
		"/v1/sessions/"+session.ID+"/hook-status",
		strings.NewReader(`{"state":"idle"}`),
	))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on hook status, got %d: %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(
		http.MethodPost,
		"/v1/sessions/"+session.ID+"/wait",
		strings.NewReader(`{"for":"tui-idle","timeoutMs":2000}`),
	))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on wait, got %d: %s", rec.Code, rec.Body.String())
	}
	var wait runtimecore.SessionWaitResult
	if err := json.Unmarshal(rec.Body.Bytes(), &wait); err != nil {
		t.Fatal(err)
	}
	if !wait.Satisfied || wait.HookAgentState != runtimecore.SessionHookIdle {
		t.Fatalf("expected hook idle to satisfy wait, got %#v", wait)
	}
}
