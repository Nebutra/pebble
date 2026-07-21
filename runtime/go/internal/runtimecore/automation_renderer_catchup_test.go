package runtimecore

import (
	"context"
	"testing"
)

func TestCatchUpAutomationRendererDispatchesReturnsOnlyPendingRendererRuns(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.Shutdown)
	automation, err := manager.CreateAutomation(CreateAutomationRequest{
		Name:     "renderer startup catch-up",
		Enabled:  true,
		Schedule: AutomationSchedule{Kind: AutomationScheduleManual},
		Action: AutomationAction{Kind: AutomationActionCreateTask, Payload: map[string]interface{}{
			"title": "run agent",
			AutomationRendererPayloadKey: map[string]interface{}{
				"workspaceMode": "existing",
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err := manager.TriggerAutomation(context.Background(), automation.ID, TriggerAutomationRequest{})
	if err != nil {
		t.Fatal(err)
	}

	dispatches, err := manager.CatchUpAutomationRendererDispatches()
	if err != nil {
		t.Fatal(err)
	}
	if len(dispatches) != 1 || dispatches[0].Run.ID != run.ID ||
		dispatches[0].Automation.ID != automation.ID || dispatches[0].DispatchToken == "" {
		t.Fatalf("unexpected renderer catch-up dispatches: %#v", dispatches)
	}

	if _, err := manager.RecordAutomationRunDispatchResult(run.ID, AutomationDispatchResultRequest{
		Status: "completed",
	}); err != nil {
		t.Fatal(err)
	}
	dispatches, err = manager.CatchUpAutomationRendererDispatches()
	if err != nil {
		t.Fatal(err)
	}
	if len(dispatches) != 0 {
		t.Fatalf("completed renderer run must not be caught up again: %#v", dispatches)
	}
}
