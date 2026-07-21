package runtimehttp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestAutomationRendererReadyRouteReturnsStartupCatchUp(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.Shutdown)
	automation, err := manager.CreateAutomation(runtimecore.CreateAutomationRequest{
		Name:     "renderer startup catch-up",
		Enabled:  true,
		Schedule: runtimecore.AutomationSchedule{Kind: runtimecore.AutomationScheduleManual},
		Action: runtimecore.AutomationAction{Kind: runtimecore.AutomationActionCreateTask, Payload: map[string]interface{}{
			"title": "run agent",
			runtimecore.AutomationRendererPayloadKey: map[string]interface{}{
				"workspaceMode": "existing",
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err := manager.TriggerAutomation(context.Background(), automation.ID, runtimecore.TriggerAutomationRequest{})
	if err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	NewServer(manager).ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodPost, "/v1/automations/renderer-ready", nil),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	var dispatches []runtimecore.AutomationRendererDispatch
	if err := json.Unmarshal(recorder.Body.Bytes(), &dispatches); err != nil {
		t.Fatal(err)
	}
	if len(dispatches) != 1 || dispatches[0].Run.ID != run.ID || dispatches[0].DispatchToken == "" {
		t.Fatalf("unexpected startup catch-up response: %#v", dispatches)
	}
}
