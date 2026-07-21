package runtimecore

import (
	_ "embed"
	"strings"
)

//go:embed dispatch_preamble.txt
var dispatchPreambleTemplate string

func buildDispatchPreambleForContext(
	task Task,
	dispatchID string,
	coordinatorHandle string,
	devMode bool,
) string {
	cli := "pebble"
	if devMode {
		cli = "pebble-dev"
	}
	coordinatorHandle = strings.TrimSpace(coordinatorHandle)
	if coordinatorHandle == "" {
		coordinatorHandle = "coordinator"
	}
	taskSpec := strings.TrimSpace(task.Body)
	if taskSpec == "" {
		taskSpec = strings.TrimSpace(task.Title)
	} else if title := strings.TrimSpace(task.Title); title != "" && title != taskSpec {
		taskSpec = title + "\n\n" + taskSpec
	}
	replacer := strings.NewReplacer(
		"{{CLI}}", cli,
		"{{COORDINATOR_HANDLE}}", coordinatorHandle,
		"{{TASK_ID}}", task.ID,
		"{{DISPATCH_ID}}", dispatchID,
		"{{TASK_SPEC}}", taskSpec,
	)
	return replacer.Replace(dispatchPreambleTemplate)
}

// PreviewDispatchPreamble regenerates the same protocol used by an injected
// dispatch without mutating task or dispatch state.
func (m *Manager) PreviewDispatchPreamble(
	taskID string,
	coordinatorHandle string,
	devMode bool,
) (string, error) {
	taskID = strings.TrimSpace(taskID)
	m.mu.RLock()
	task, ok := m.tasks[taskID]
	latestID := "ctx_preview"
	var latest Dispatch
	for _, dispatch := range m.dispatches {
		if dispatch.TaskID != taskID {
			continue
		}
		if latest.ID == "" || dispatch.CreatedAt.After(latest.CreatedAt) {
			latest = dispatch
		}
	}
	m.mu.RUnlock()
	if !ok {
		return "", ErrNotFound
	}
	if latest.ID != "" {
		latestID = latest.ID
	}
	return buildDispatchPreambleForContext(task, latestID, coordinatorHandle, devMode), nil
}
