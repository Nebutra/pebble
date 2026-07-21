package runtimecore

import (
	"strings"
	"testing"
)

func TestDispatchAndPreviewShareCompletePreambleProtocol(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	task, err := manager.CreateTask(CreateTaskRequest{
		Title: "Implement native orchestration",
		Body:  "Replace the unavailable Tauri preview.",
	})
	if err != nil {
		t.Fatal(err)
	}
	dispatch, err := manager.DispatchTask(DispatchTaskRequest{
		TaskID:            task.ID,
		Assignee:          "codex",
		SessionID:         "session-live",
		CoordinatorHandle: "term-coordinator",
		Inject:            true,
		DevMode:           true,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		"pebble-dev orchestration send",
		"--type worker_done",
		"--type heartbeat",
		"pebble-dev orchestration ask",
		"term-coordinator",
		task.ID,
		dispatch.ID,
		"Replace the unavailable Tauri preview.",
	} {
		if !strings.Contains(dispatch.Preamble, expected) {
			t.Fatalf("dispatch preamble missing %q", expected)
		}
	}

	preview, err := manager.PreviewDispatchPreamble(task.ID, "term-coordinator", true)
	if err != nil {
		t.Fatal(err)
	}
	if preview != dispatch.Preamble {
		t.Fatal("preview must regenerate the exact injected dispatch preamble")
	}
}

func TestPreviewDispatchPreambleUsesPlaceholderWithoutDispatch(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	task, err := manager.CreateTask(CreateTaskRequest{Title: "Preview before dispatch"})
	if err != nil {
		t.Fatal(err)
	}
	preview, err := manager.PreviewDispatchPreamble(task.ID, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(preview, "--dispatch-id ctx_preview") ||
		!strings.Contains(preview, "pebble orchestration check") {
		t.Fatalf("unexpected preview: %s", preview)
	}
	if _, err := manager.PreviewDispatchPreamble("missing", "", false); err != ErrNotFound {
		t.Fatalf("missing task error = %v", err)
	}
}
