package runtimecore

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func precheckSleepCommand() string {
	if runtime.GOOS == "windows" {
		return "ping -n 6 127.0.0.1 > NUL"
	}
	return "sleep 5"
}

func newPrecheckTestManager(t *testing.T) *Manager {
	t.Helper()
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	return manager
}

func createPrecheckAutomation(t *testing.T, manager *Manager, precheck *AutomationPrecheck) Automation {
	t.Helper()
	automation, err := manager.CreateAutomation(CreateAutomationRequest{
		Name:    "gated task",
		Enabled: true,
		Schedule: AutomationSchedule{
			Kind:            AutomationScheduleInterval,
			IntervalSeconds: 60,
		},
		Action: AutomationAction{
			Kind: AutomationActionCreateTask,
			Payload: map[string]interface{}{
				"title": "gated work",
			},
		},
		Precheck: precheck,
	})
	if err != nil {
		t.Fatal(err)
	}
	return automation
}

func evaluateDue(t *testing.T, manager *Manager, automation Automation) AutomationRun {
	t.Helper()
	runs, err := manager.EvaluateScheduledAutomations(context.Background(), automation.NextRunAt.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 {
		t.Fatalf("expected one due run, got %#v", runs)
	}
	return runs[0]
}

func TestScheduledAutomationPrecheckPassRunsAction(t *testing.T) {
	manager := newPrecheckTestManager(t)
	dir := t.TempDir()
	automation := createPrecheckAutomation(t, manager, &AutomationPrecheck{
		Command:    "exit 0",
		WorkingDir: dir,
	})
	run := evaluateDue(t, manager, automation)
	if run.Status != AutomationRunCompleted || run.TaskID == "" {
		t.Fatalf("passing precheck should let the action run: %#v", run)
	}
	if run.PrecheckResult == nil || run.PrecheckResult.ExitCode == nil || *run.PrecheckResult.ExitCode != 0 {
		t.Fatalf("run should record the passing precheck result: %#v", run.PrecheckResult)
	}
}

func TestScheduledAutomationPrecheckFailureSkipsAction(t *testing.T) {
	dataDir := t.TempDir()
	manager, err := NewManager(dataDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	automation := createPrecheckAutomation(t, manager, &AutomationPrecheck{
		Command:    "exit 3",
		WorkingDir: t.TempDir(),
	})
	run := evaluateDue(t, manager, automation)
	if run.Status != AutomationRunSkippedPrecheck {
		t.Fatalf("failing precheck should skip the run: %#v", run)
	}
	if run.TaskID != "" || len(manager.ListTasks()) != 0 {
		t.Fatalf("skipped run must not execute the action: %#v", run)
	}
	if run.PrecheckResult == nil || run.PrecheckResult.ExitCode == nil || *run.PrecheckResult.ExitCode != 3 {
		t.Fatalf("run should record the failing exit code: %#v", run.PrecheckResult)
	}
	if !strings.Contains(run.Error, "exited with code 3") {
		t.Fatalf("run error should describe the precheck failure: %q", run.Error)
	}

	// The skipped run and its precheck result must survive a reload.
	reloaded, err := NewManager(dataDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	persisted := reloaded.ListAutomationRuns(automation.ID)
	if len(persisted) != 1 || persisted[0].Status != AutomationRunSkippedPrecheck || persisted[0].PrecheckResult == nil {
		t.Fatalf("skipped precheck run was not persisted: %#v", persisted)
	}
}

func TestScheduledAutomationPrecheckTimeoutSkipsAction(t *testing.T) {
	manager := newPrecheckTestManager(t)
	automation := createPrecheckAutomation(t, manager, &AutomationPrecheck{
		Command:        precheckSleepCommand(),
		TimeoutSeconds: 1,
		WorkingDir:     t.TempDir(),
	})
	run := evaluateDue(t, manager, automation)
	if run.Status != AutomationRunSkippedPrecheck {
		t.Fatalf("timed-out precheck should skip the run: %#v", run)
	}
	result := run.PrecheckResult
	if result == nil || !result.TimedOut || result.ExitCode != nil {
		t.Fatalf("timeout must report timedOut with a null exit code: %#v", result)
	}
	if !strings.Contains(run.Error, "timed out") {
		t.Fatalf("run error should mention the timeout: %q", run.Error)
	}
}

func TestScheduledAutomationPrecheckRunsInWorkingDir(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test precheck command uses POSIX sh")
	}
	manager := newPrecheckTestManager(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "marker"), []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	automation := createPrecheckAutomation(t, manager, &AutomationPrecheck{
		Command:    "test -f marker",
		WorkingDir: dir,
	})
	run := evaluateDue(t, manager, automation)
	if run.Status != AutomationRunCompleted {
		t.Fatalf("precheck should run inside the configured working directory: %#v", run)
	}
}

func TestScheduledAutomationPrecheckUnresolvableCwdSkips(t *testing.T) {
	manager := newPrecheckTestManager(t)
	automation := createPrecheckAutomation(t, manager, &AutomationPrecheck{Command: "exit 0"})
	run := evaluateDue(t, manager, automation)
	if run.Status != AutomationRunSkippedPrecheck {
		t.Fatalf("unresolvable cwd must skip, not crash or pass: %#v", run)
	}
	if run.PrecheckResult == nil || !strings.Contains(run.PrecheckResult.Error, "working directory") {
		t.Fatalf("result should carry the typed cwd resolution error: %#v", run.PrecheckResult)
	}
}

func TestManualTriggerBypassesPrecheck(t *testing.T) {
	manager := newPrecheckTestManager(t)
	automation := createPrecheckAutomation(t, manager, &AutomationPrecheck{
		Command:    "exit 1",
		WorkingDir: t.TempDir(),
	})
	run, err := manager.TriggerAutomation(context.Background(), automation.ID, TriggerAutomationRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != AutomationRunCompleted || run.PrecheckResult != nil {
		t.Fatalf("manual runs must bypass the precheck gate: %#v", run)
	}
}

func TestAutomationPrecheckNormalization(t *testing.T) {
	if normalizeAutomationPrecheck(nil) != nil {
		t.Fatal("nil precheck should stay nil")
	}
	if normalizeAutomationPrecheck(&AutomationPrecheck{Command: "   "}) != nil {
		t.Fatal("blank command should clear the precheck")
	}
	normalized := normalizeAutomationPrecheck(&AutomationPrecheck{Command: " ls ", TimeoutSeconds: 100000})
	if normalized.Command != "ls" || normalized.TimeoutSeconds != maxAutomationPrecheckTimeoutSeconds {
		t.Fatalf("timeout should clamp to the maximum: %#v", normalized)
	}
	normalized = normalizeAutomationPrecheck(&AutomationPrecheck{Command: "ls"})
	if normalized.TimeoutSeconds != defaultAutomationPrecheckTimeoutSeconds {
		t.Fatalf("timeout should default: %#v", normalized)
	}
}

func TestUpdateAutomationClearsPrecheckWithEmptyCommand(t *testing.T) {
	manager := newPrecheckTestManager(t)
	automation := createPrecheckAutomation(t, manager, &AutomationPrecheck{
		Command:    "exit 0",
		WorkingDir: t.TempDir(),
	})
	updated, err := manager.UpdateAutomation(automation.ID, UpdateAutomationRequest{
		Precheck: &AutomationPrecheck{Command: ""},
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Precheck != nil {
		t.Fatalf("empty precheck command should clear the stored precheck: %#v", updated.Precheck)
	}
}

func TestAutomationRendererPayloadKeyIsStrippedForNativeActions(t *testing.T) {
	manager := newPrecheckTestManager(t)
	automation, err := manager.CreateAutomation(CreateAutomationRequest{
		Name:    "renderer authored",
		Enabled: true,
		Schedule: AutomationSchedule{
			Kind: AutomationScheduleManual,
		},
		Action: AutomationAction{
			Kind: AutomationActionCreateTask,
			Payload: map[string]interface{}{
				"title":                      "renderer task",
				AutomationRendererPayloadKey: map[string]interface{}{"prompt": "do the thing"},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err := manager.TriggerAutomation(context.Background(), automation.ID, TriggerAutomationRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != AutomationRunCompleted || run.TaskID == "" {
		t.Fatalf("renderer envelope must not break native action decoding: %#v", run)
	}
}

func TestTriggerEmitsAutomationDispatchRequestedEvent(t *testing.T) {
	manager := newPrecheckTestManager(t)
	automation := createPrecheckAutomation(t, manager, nil)
	id, events := manager.Subscribe(16)
	defer manager.Unsubscribe(id)
	run := evaluateDue(t, manager, automation)

	deadline := time.After(2 * time.Second)
	for {
		select {
		case event := <-events:
			if event.Topic != "automation.dispatch.requested" {
				continue
			}
			payload, ok := event.Payload.(map[string]interface{})
			if !ok {
				t.Fatalf("unexpected dispatch payload: %#v", event.Payload)
			}
			emittedRun, ok := payload["run"].(AutomationRun)
			if !ok || emittedRun.ID != run.ID {
				t.Fatalf("dispatch event should carry the triggered run: %#v", payload["run"])
			}
			return
		case <-deadline:
			t.Fatal("automation.dispatch.requested event was not emitted")
		}
	}
}

func TestFailedPrecheckDoesNotEmitDispatchRequested(t *testing.T) {
	manager := newPrecheckTestManager(t)
	automation := createPrecheckAutomation(t, manager, &AutomationPrecheck{
		Command:    "exit 1",
		WorkingDir: t.TempDir(),
	})
	id, events := manager.Subscribe(16)
	defer manager.Unsubscribe(id)
	run := evaluateDue(t, manager, automation)
	if run.Status != AutomationRunSkippedPrecheck {
		t.Fatalf("expected skipped run: %#v", run)
	}
	for {
		select {
		case event := <-events:
			if event.Topic == "automation.dispatch.requested" {
				t.Fatal("skipped runs must not request renderer dispatch")
			}
		default:
			return
		}
	}
}

func TestRunAutomationSchedulerFiresDueAutomationAndStops(t *testing.T) {
	manager := newPrecheckTestManager(t)
	automation, err := manager.CreateAutomation(CreateAutomationRequest{
		Name:    "scheduler loop",
		Enabled: true,
		Schedule: AutomationSchedule{
			Kind:            AutomationScheduleInterval,
			IntervalSeconds: 1,
		},
		Action: AutomationAction{
			Kind:    AutomationActionCreateTask,
			Payload: map[string]interface{}{"title": "tick"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		manager.RunAutomationScheduler(ctx, 20*time.Millisecond)
		close(done)
	}()

	deadline := time.Now().Add(5 * time.Second)
	for {
		if len(manager.ListAutomationRuns(automation.ID)) > 0 {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("scheduler never fired the due automation")
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("scheduler did not stop on context cancel")
	}
}
