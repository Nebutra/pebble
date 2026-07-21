package runtimecore

import (
	"context"
	"testing"
	"time"
)

func TestEvaluateScheduledAutomationsSkipsRunsOutsideGrace(t *testing.T) {
	manager, _ := newSshTestManager(t)
	automation, err := manager.CreateAutomation(CreateAutomationRequest{
		Name:    "missed schedule",
		Enabled: true,
		Schedule: AutomationSchedule{
			Kind:            AutomationScheduleInterval,
			IntervalSeconds: 3600,
		},
		Action: AutomationAction{
			Kind: AutomationActionCreateTask,
			Payload: map[string]interface{}{
				"title": "must not execute",
				AutomationRendererPayloadKey: map[string]interface{}{
					"missedRunGraceMinutes": 30,
				},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	scheduledFor := now.Add(-2 * time.Hour)
	manager.mu.Lock()
	automation.NextRunAt = &scheduledFor
	manager.automations[automation.ID] = automation
	manager.mu.Unlock()

	runs, err := manager.EvaluateScheduledAutomations(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 || runs[0].Status != AutomationRunSkippedMissed {
		t.Fatalf("runs = %#v", runs)
	}
	if !runs[0].CreatedAt.Equal(scheduledFor) {
		t.Fatalf("createdAt = %s, want scheduled time %s", runs[0].CreatedAt, scheduledFor)
	}
	if len(manager.ListTasks()) != 0 {
		t.Fatal("missed run executed its action")
	}
	updated := manager.ListAutomations()[0]
	if updated.NextRunAt == nil || !updated.NextRunAt.After(now) {
		t.Fatalf("next run was not advanced: %#v", updated.NextRunAt)
	}
}
