package runtimehttp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"runtime"
	"strings"
	"testing"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

func agentHookTestServer(t *testing.T, options ServerOptions) (*Server, *runtimecore.Manager) {
	t.Helper()
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.Shutdown)
	return NewServerWithOptions(manager, options), manager
}

func postAgentHookForm(server *Server, path string, form url.Values, hookToken string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if hookToken != "" {
		req.Header.Set("X-Pebble-Agent-Hook-Token", hookToken)
	}
	server.ServeHTTP(rec, req)
	return rec
}

func TestAgentHookIngestRouteUpdatesSessionHookState(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("session spawn test uses a POSIX shell")
	}
	server, manager := agentHookTestServer(t, ServerOptions{BearerToken: "bearer-secret"})
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.StartSession(context.Background(), runtimecore.StartSessionRequest{
		ProjectID:   project.ID,
		Command:     []string{"/bin/sh", "-c", "sleep 30"},
		LaunchToken: "hook-launch-token",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = manager.StopSession(session.ID) })

	form := url.Values{}
	form.Set("launchToken", "hook-launch-token")
	form.Set("paneKey", "tab-1:leaf-1")
	form.Set("payload", `{"hook_event_name":"Stop"}`)

	// Hook scripts hold the hook token (== bearer token by default) but no
	// bearer header; the /hook route must bypass the bearer gate.
	rec := postAgentHookForm(server, "/hook/claude", form, "bearer-secret")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var result runtimecore.AgentHookIngestResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.Accepted || result.State != runtimecore.SessionHookIdle {
		t.Fatalf("expected accepted idle ingest, got %#v", result)
	}

	snapshot, err := manager.SessionStatus(session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.HookAgentState != runtimecore.SessionHookIdle {
		t.Fatalf("expected idle hook state, got %q", snapshot.HookAgentState)
	}
}

func TestAgentHookIngestRouteRejectsBadToken(t *testing.T) {
	server, _ := agentHookTestServer(t, ServerOptions{BearerToken: "bearer-secret"})

	form := url.Values{}
	form.Set("payload", `{"hook_event_name":"Stop"}`)

	rec := postAgentHookForm(server, "/hook/claude", form, "wrong-token")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for wrong hook token, got %d", rec.Code)
	}
	rec = postAgentHookForm(server, "/hook/claude", form, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for missing hook token, got %d", rec.Code)
	}
}

func TestAutomationRunDispatchResultRoute(t *testing.T) {
	server, manager := agentHookTestServer(t, ServerOptions{})
	automation, err := manager.CreateAutomation(runtimecore.CreateAutomationRequest{
		Name:     "renderer dispatch",
		Enabled:  true,
		Schedule: runtimecore.AutomationSchedule{Kind: runtimecore.AutomationScheduleManual},
		Action: runtimecore.AutomationAction{
			Kind:    runtimecore.AutomationActionCreateTask,
			Payload: map[string]interface{}{"title": "run agent"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err := manager.TriggerAutomation(context.Background(), automation.ID, runtimecore.TriggerAutomationRequest{})
	if err != nil {
		t.Fatal(err)
	}

	body := strings.NewReader(`{"status":"completed","workspaceId":"ws-1","terminalSessionId":"sess-1"}`)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/automations/runs/"+run.ID+"/dispatch-result", body))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var updated runtimecore.AutomationRun
	if err := json.Unmarshal(rec.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if updated.DispatchState == nil || updated.DispatchState.WorkspaceID != "ws-1" ||
		updated.DispatchState.TerminalSessionID != "sess-1" {
		t.Fatalf("expected dispatch state in response, got %#v", updated.DispatchState)
	}

	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/automations/runs/"+run.ID+"/dispatch-result",
		strings.NewReader(`{"status":"nonsense"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid status, got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/automations/runs/missing/dispatch-result",
		strings.NewReader(`{"status":"completed"}`)))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown run, got %d", rec.Code)
	}
}
