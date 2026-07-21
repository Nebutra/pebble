package runtimehttp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestDispatchPreambleRouteReturnsNativeProtocol(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	task, err := manager.CreateTask(runtimecore.CreateTaskRequest{
		Title: "route preview",
		Body:  "prove the native endpoint",
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(
		http.MethodGet,
		"/v1/orchestration/dispatch-preamble?taskId="+task.ID+"&from=term-route&devMode=true",
		nil,
	)
	recorder := httptest.NewRecorder()
	NewServer(manager).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Preamble string `json:"preamble"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(response.Preamble, "pebble-dev orchestration ask") ||
		!strings.Contains(response.Preamble, "prove the native endpoint") {
		t.Fatalf("unexpected preamble: %s", response.Preamble)
	}
}

func TestLegacySharedControlDispatchShowMapsLatestSession(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	task, err := manager.CreateTask(runtimecore.CreateTaskRequest{Title: "parallel worker"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.DispatchTask(runtimecore.DispatchTaskRequest{
		TaskID: task.ID, Assignee: "codex", SessionID: "session-old",
	}); err != nil {
		t.Fatal(err)
	}
	latest, err := manager.DispatchTask(runtimecore.DispatchTaskRequest{
		TaskID: task.ID, Assignee: "claude", SessionID: "session-live",
	})
	if err != nil {
		t.Fatal(err)
	}

	result, handled, err := NewServer(manager).runLegacySharedControlOrchestrationMethod(
		"orchestration.dispatchShow",
		json.RawMessage(`{"task":"`+task.ID+`"}`),
	)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	dispatch := result.(map[string]interface{})["dispatch"].(map[string]interface{})
	if dispatch["id"] != latest.ID || dispatch["assignee_handle"] != "session-live" {
		t.Fatalf("unexpected dispatch projection: %#v", dispatch)
	}
}

func TestLegacySharedControlDispatchShowReturnsNullAndPreviewsPreamble(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	result, handled, err := server.runLegacySharedControlOrchestrationMethod(
		"orchestration.dispatchShow", json.RawMessage(`{"task":"missing"}`),
	)
	if err != nil || !handled || result.(map[string]interface{})["dispatch"] != nil {
		t.Fatalf("unexpected empty result: %#v handled=%v err=%v", result, handled, err)
	}
	if _, handled, err := server.runLegacySharedControlOrchestrationMethod(
		"orchestration.dispatchShow", json.RawMessage(`{"task":"missing","preamble":true}`),
	); !handled || err == nil {
		t.Fatalf("expected missing-task preamble error, handled=%v err=%v", handled, err)
	}
	task, err := manager.CreateTask(runtimecore.CreateTaskRequest{Title: "native preview"})
	if err != nil {
		t.Fatal(err)
	}
	previewResult, handled, err := server.runLegacySharedControlOrchestrationMethod(
		"orchestration.dispatchShow",
		json.RawMessage(`{"task":"`+task.ID+`","preamble":true,"from":"term-coord","devMode":true}`),
	)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	preamble, _ := previewResult.(map[string]interface{})["preamble"].(string)
	if !strings.Contains(preamble, "pebble-dev orchestration send") ||
		!strings.Contains(preamble, "term-coord") {
		t.Fatalf("unexpected preamble: %s", preamble)
	}
	if _, handled, err := server.runLegacySharedControlOrchestrationMethod(
		"repo.list", json.RawMessage(`{}`),
	); handled || err != nil {
		t.Fatalf("unrelated method handled=%v err=%v", handled, err)
	}
}

func TestDispatchShowIsAllowedForMobileSharedControl(t *testing.T) {
	if !legacySharedControlMobileMethodAllowed("orchestration.dispatchShow") {
		t.Fatal("dispatchShow must be readable by the mobile task-to-terminal flow")
	}
}
