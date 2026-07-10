package runtimecore

import (
	"context"
	"errors"
	"testing"
)

func createDispatchWritebackRun(t *testing.T) (*Manager, AutomationRun) {
	t.Helper()
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.Shutdown)
	automation, err := manager.CreateAutomation(CreateAutomationRequest{
		Name:    "renderer dispatch",
		Enabled: true,
		Schedule: AutomationSchedule{
			Kind: AutomationScheduleManual,
		},
		Action: AutomationAction{
			Kind:    AutomationActionCreateTask,
			Payload: map[string]interface{}{"title": "run agent"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err := manager.TriggerAutomation(context.Background(), automation.ID, TriggerAutomationRequest{})
	if err != nil {
		t.Fatal(err)
	}
	return manager, run
}

func TestRecordAutomationRunDispatchResultPersistsRendererOutcome(t *testing.T) {
	manager, run := createDispatchWritebackRun(t)

	updated, err := manager.RecordAutomationRunDispatchResult(run.ID, AutomationDispatchResultRequest{
		Status:               "completed",
		WorkspaceID:          "ws-1",
		WorkspaceDisplayName: "feature/agent-work",
		TerminalSessionID:    "sess-7",
		TerminalPaneKey:      "tab-1:leaf-1",
		TerminalPtyID:        "pty-9",
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Status != AutomationRunCompleted {
		t.Fatalf("expected completed native status, got %q", updated.Status)
	}
	state := updated.DispatchState
	if state == nil {
		t.Fatal("expected dispatch state to be recorded")
	}
	if state.Status != "completed" || state.WorkspaceID != "ws-1" ||
		state.TerminalSessionID != "sess-7" || state.TerminalPaneKey != "tab-1:leaf-1" ||
		state.TerminalPtyID != "pty-9" || state.WorkspaceDisplayName != "feature/agent-work" {
		t.Fatalf("dispatch state fields not persisted: %#v", state)
	}
	if state.ReportedAt.IsZero() {
		t.Fatal("expected reportedAt timestamp")
	}

	// The writeback must land on the stored run record, not only the response.
	listed := manager.ListAutomationRuns(updated.AutomationID)
	if len(listed) != 1 || listed[0].DispatchState == nil ||
		listed[0].DispatchState.WorkspaceID != "ws-1" {
		t.Fatalf("stored run missing dispatch state: %#v", listed)
	}
}

func TestRecordAutomationRunDispatchResultFailureSetsError(t *testing.T) {
	manager, run := createDispatchWritebackRun(t)

	updated, err := manager.RecordAutomationRunDispatchResult(run.ID, AutomationDispatchResultRequest{
		Status: "dispatch_failed",
		Error:  "workspace setup failed",
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Status != AutomationRunFailed {
		t.Fatalf("expected failed native status, got %q", updated.Status)
	}
	if updated.Error != "workspace setup failed" {
		t.Fatalf("expected run error writeback, got %q", updated.Error)
	}
}

func TestRecordAutomationRunDispatchResultKeepsNativeStatusForNonFinalStates(t *testing.T) {
	manager, run := createDispatchWritebackRun(t)
	// Manual createTask runs complete natively before the renderer reports.
	nativeStatus := manager.ListAutomationRuns(run.AutomationID)[0].Status

	updated, err := manager.RecordAutomationRunDispatchResult(run.ID, AutomationDispatchResultRequest{
		Status:      "dispatched",
		WorkspaceID: "ws-2",
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Status != nativeStatus {
		t.Fatalf("non-final renderer status must not rewrite native status: got %q want %q", updated.Status, nativeStatus)
	}
	if updated.DispatchState == nil || updated.DispatchState.Status != "dispatched" {
		t.Fatalf("expected dispatched state recorded, got %#v", updated.DispatchState)
	}
}

func TestRecordAutomationRunDispatchResultValidation(t *testing.T) {
	manager, run := createDispatchWritebackRun(t)

	if _, err := manager.RecordAutomationRunDispatchResult(run.ID, AutomationDispatchResultRequest{
		Status: "totally-made-up",
	}); err == nil {
		t.Fatal("expected invalid status to be rejected")
	}
	if _, err := manager.RecordAutomationRunDispatchResult("autorun-missing", AutomationDispatchResultRequest{
		Status: "completed",
	}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound for unknown run, got %v", err)
	}
}
