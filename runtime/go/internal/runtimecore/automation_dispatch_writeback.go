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
	OutputSnapshot       *AutomationRunOutputSnapshot `json:"outputSnapshot,omitempty"`
	Error                string    `json:"error,omitempty"`
	ReportedAt           time.Time `json:"reportedAt"`
}

type AutomationRunOutputSnapshot struct {
	Format     string `json:"format"`
	Content    string `json:"content"`
	CapturedAt int64  `json:"capturedAt"`
	Truncated  bool   `json:"truncated"`
}

type AutomationDispatchResultRequest struct {
	Status               string `json:"status"`
	WorkspaceID          string `json:"workspaceId,omitempty"`
	WorkspaceDisplayName string `json:"workspaceDisplayName,omitempty"`
	TerminalSessionID    string `json:"terminalSessionId,omitempty"`
	TerminalPaneKey      string `json:"terminalPaneKey,omitempty"`
	TerminalPtyID        string `json:"terminalPtyId,omitempty"`
	OutputSnapshot       *AutomationRunOutputSnapshot `json:"outputSnapshot,omitempty"`
	Error                string `json:"error,omitempty"`
}

var errInvalidDispatchStatus = errors.New(
	"invalid dispatch status; supported: pending, dispatching, dispatched, completed, " +
		"skipped_precheck, skipped_missed, skipped_unavailable, skipped_needs_interactive_auth, dispatch_failed",
)

var errInvalidAutomationOutputSnapshot = errors.New("invalid automation output snapshot")

const maxAutomationOutputSnapshotBytes = 1024 * 1024

// rendererDispatchStatuses is the renderer's AutomationRunStatus union
// (packages/product-core/shared/automations-types.ts). The full renderer status is stored
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
	outputSnapshot, err := normalizeAutomationOutputSnapshot(req.OutputSnapshot)
	if err != nil {
		return AutomationRun{}, err
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
		OutputSnapshot:       outputSnapshot,
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

func normalizeAutomationOutputSnapshot(
	snapshot *AutomationRunOutputSnapshot,
) (*AutomationRunOutputSnapshot, error) {
	if snapshot == nil {
		return nil, nil
	}
	if snapshot.Format != "plain_text" || strings.TrimSpace(snapshot.Content) == "" ||
		len([]byte(snapshot.Content)) > maxAutomationOutputSnapshotBytes || snapshot.CapturedAt <= 0 {
		return nil, errInvalidAutomationOutputSnapshot
	}
	copy := *snapshot
	return &copy, nil
}

func (m *Manager) SnapshotAutomationWorkspaceDisplayName(workspaceID, displayName string) (int, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	displayName = strings.TrimSpace(displayName)
	if workspaceID == "" || displayName == "" {
		return 0, nil
	}
	m.mu.Lock()
	updated := 0
	for id, run := range m.automationRuns {
		if run.DispatchState == nil || run.DispatchState.WorkspaceID != workspaceID || run.DispatchState.WorkspaceDisplayName == displayName {
			continue
		}
		dispatch := *run.DispatchState
		dispatch.WorkspaceDisplayName = displayName
		run.DispatchState = &dispatch
		run.UpdatedAt = time.Now().UTC()
		m.automationRuns[id] = run
		updated++
	}
	if updated == 0 {
		m.mu.Unlock()
		return 0, nil
	}
	err := m.saveLocked()
	m.mu.Unlock()
	return updated, err
}
