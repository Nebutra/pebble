package runtimecore

import (
	"testing"
	"time"
)

func TestAutomationWorkspaceProvenanceTokenLifecycle(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	automation := Automation{
		ID: "auto-1", Name: "Nightly summary", Enabled: true,
		Action: AutomationAction{Payload: map[string]interface{}{
			AutomationRendererPayloadKey: map[string]interface{}{
				"workspaceMode": "new_per_run", "projectId": "repo-1",
				"executionTargetType": "local", "executionTargetId": "local",
				"runContext": map[string]interface{}{"projectId": "project-1", "repoId": "repo-1", "hostId": "local"},
			},
		}},
	}
	run := AutomationRun{
		ID: "run-1", AutomationID: automation.ID, Status: AutomationRunQueued,
		Payload: automation.Action.Payload, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	manager.mu.Lock()
	manager.automations[automation.ID] = automation
	manager.automationRuns[run.ID] = run
	manager.mu.Unlock()
	token, err := manager.issueAutomationDispatchToken(automation.ID, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	request := AutomationWorkspaceProvenanceRequest{
		AutomationID: automation.ID, AutomationRunID: run.ID,
		DispatchToken: token, CreateRequestID: "create-1",
	}
	provenance, err := manager.BeginAutomationWorkspaceProvenance(request, "repo-1")
	if err != nil {
		t.Fatal(err)
	}
	if provenance.ProjectID != "project-1" || provenance.RepoID != "repo-1" || provenance.AutomationNameSnapshot != automation.Name {
		t.Fatalf("unexpected provenance: %#v", provenance)
	}
	if _, err := manager.BeginAutomationWorkspaceProvenance(request, "repo-1"); err == nil {
		t.Fatal("in-flight token replay must be rejected")
	}
	manager.ReleaseAutomationWorkspaceProvenance(request)
	if _, err := manager.BeginAutomationWorkspaceProvenance(request, "repo-1"); err != nil {
		t.Fatalf("released reservation should be retryable: %v", err)
	}
	manager.FinishAutomationWorkspaceProvenance(request)
	if _, err := manager.BeginAutomationWorkspaceProvenance(request, "repo-1"); err == nil {
		t.Fatal("consumed token must not be reusable")
	}
}

func TestAutomationWorkspaceProvenanceRejectsWrongRepo(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	automation := Automation{ID: "auto-1", Name: "Run", Action: AutomationAction{Payload: map[string]interface{}{
		AutomationRendererPayloadKey: map[string]interface{}{"workspaceMode": "new_per_run", "projectId": "repo-1"},
	}}}
	run := AutomationRun{ID: "run-1", AutomationID: automation.ID, Payload: automation.Action.Payload}
	manager.mu.Lock()
	manager.automations[automation.ID] = automation
	manager.automationRuns[run.ID] = run
	manager.mu.Unlock()
	token, err := manager.issueAutomationDispatchToken(automation.ID, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.BeginAutomationWorkspaceProvenance(AutomationWorkspaceProvenanceRequest{
		AutomationID: automation.ID, AutomationRunID: run.ID, DispatchToken: token, CreateRequestID: "create-1",
	}, "repo-2")
	if err == nil {
		t.Fatal("repo mismatch must be rejected")
	}
}
