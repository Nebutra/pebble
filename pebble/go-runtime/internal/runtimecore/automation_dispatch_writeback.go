package runtimecore

import (
	"errors"
	"strings"
	"time"
)

// AutomationDispatchState mirrors Electron's markDispatchResult persistence:
// the renderer runs the actual agent session for a dispatched automation and
// reports the outcome (status, workspace/session identity, error) back so run
// history survives with the run record instead of only in renderer memory.
type AutomationDispatchState struct {
	Status               string    `json:"status"`
	WorkspaceID          string    `json:"workspaceId,omitempty"`
	WorkspaceDisplayName string    `json:"workspaceDisplayName,omitempty"`
	TerminalSessionID    string    `json:"terminalSessionId,omitempty"`
	TerminalPaneKey      string    `json:"terminalPaneKey,omitempty"`
	TerminalPtyID        string    `json:"terminalPtyId,omitempty"`
	Error                string    `json:"error,omitempty"`
	ReportedAt           time.Time `json:"reportedAt"`
}

type AutomationDispatchResultRequest struct {
	Status               string `json:"status"`
	WorkspaceID          string `json:"workspaceId,omitempty"`
	WorkspaceDisplayName string `json:"workspaceDisplayName,omitempty"`
	TerminalSessionID    string `json:"terminalSessionId,omitempty"`
	TerminalPaneKey      string `json:"terminalPaneKey,omitempty"`
	TerminalPtyID        string `json:"terminalPtyId,omitempty"`
	Error                string `json:"error,omitempty"`
}

var errInvalidDispatchStatus = errors.New(
	"invalid dispatch status; supported: pending, dispatching, dispatched, completed, " +
		"skipped_precheck, skipped_missed, skipped_unavailable, skipped_needs_interactive_auth, dispatch_failed",
)

// rendererDispatchStatuses is the renderer's AutomationRunStatus union
// (src/shared/automations-types.ts). The full renderer status is stored
// verbatim on DispatchState; only statuses with an exact native equivalent
// also fold onto the coarser Go run status, so the runtime never fakes a
// completed/failed native state for in-flight or skipped dispatches.
var rendererDispatchStatuses = map[string]AutomationRunStatus{
	"pending":                        "",
	"dispatching":                    "",
	"dispatched":                     "",
	"completed":                      AutomationRunCompleted,
	"skipped_precheck":               AutomationRunSkippedPrecheck,
	"skipped_missed":                 "",
	"skipped_unavailable":            "",
	"skipped_needs_interactive_auth": "",
	"dispatch_failed":                AutomationRunFailed,
}

// RecordAutomationRunDispatchResult persists the renderer-reported dispatch
// outcome onto the stored automation run and emits automation.changed so other
// listeners (dashboards, headless observers) see the final state.
func (m *Manager) RecordAutomationRunDispatchResult(runID string, req AutomationDispatchResultRequest) (AutomationRun, error) {
	status := strings.TrimSpace(req.Status)
	nativeStatus, known := rendererDispatchStatuses[status]
	if !known {
		return AutomationRun{}, errInvalidDispatchStatus
	}
	m.mu.Lock()
	run, ok := m.automationRuns[runID]
	if !ok {
		m.mu.Unlock()
		return AutomationRun{}, ErrNotFound
	}
	now := time.Now().UTC()
	run.DispatchState = &AutomationDispatchState{
		Status:               status,
		WorkspaceID:          strings.TrimSpace(req.WorkspaceID),
		WorkspaceDisplayName: strings.TrimSpace(req.WorkspaceDisplayName),
		TerminalSessionID:    strings.TrimSpace(req.TerminalSessionID),
		TerminalPaneKey:      strings.TrimSpace(req.TerminalPaneKey),
		TerminalPtyID:        strings.TrimSpace(req.TerminalPtyID),
		Error:                strings.TrimSpace(req.Error),
		ReportedAt:           now,
	}
	if nativeStatus != "" {
		run.Status = nativeStatus
	}
	if run.DispatchState.Error != "" {
		run.Error = run.DispatchState.Error
	}
	run.UpdatedAt = now
	m.automationRuns[runID] = run
	saveErr := m.saveLocked()
	m.mu.Unlock()
	if saveErr != nil {
		return AutomationRun{}, saveErr
	}
	m.emit("automation.changed", run)
	return run, nil
}
