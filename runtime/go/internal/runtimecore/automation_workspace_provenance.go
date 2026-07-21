package runtimecore

import (
	"errors"
	"strings"
	"time"
)

type AutomationWorkspaceProvenanceRequest struct {
	AutomationID    string `json:"automationId"`
	AutomationRunID string `json:"automationRunId"`
	DispatchToken   string `json:"dispatchToken"`
	CreateRequestID string `json:"createRequestId"`
}

type AutomationWorkspaceProvenance struct {
	Kind                       string `json:"kind"`
	AutomationID               string `json:"automationId"`
	AutomationNameSnapshot     string `json:"automationNameSnapshot"`
	AutomationRunID            string `json:"automationRunId"`
	AutomationRunTitleSnapshot string `json:"automationRunTitleSnapshot"`
	CreatedAt                  int64  `json:"createdAt"`
	ExecutionTargetType        string `json:"executionTargetType"`
	ExecutionTargetID          string `json:"executionTargetId"`
	ProjectID                  string `json:"projectId"`
	RepoID                     string `json:"repoId,omitempty"`
	HostID                     string `json:"hostId,omitempty"`
}

var errInvalidAutomationProvenance = errors.New("invalid automation provenance request")

func (m *Manager) BeginAutomationWorkspaceProvenance(
	req AutomationWorkspaceProvenanceRequest,
	repoID string,
) (AutomationWorkspaceProvenance, error) {
	now := time.Now().UTC()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneAutomationDispatchTokensLocked(now)
	record, ok := m.automationDispatchTokens[req.DispatchToken]
	if !ok || record.AutomationID != req.AutomationID || record.RunID != req.AutomationRunID ||
		record.InFlight || (record.ReservedBy != "" && record.ReservedBy != req.CreateRequestID) {
		return AutomationWorkspaceProvenance{}, errInvalidAutomationProvenance
	}
	automation, automationOK := m.automations[req.AutomationID]
	run, runOK := m.automationRuns[req.AutomationRunID]
	snapshot, snapshotOK := rendererAutomationSnapshot(run.Payload)
	expectedRepoID := nestedString(snapshot, "runContext", "repoId")
	if expectedRepoID == "" {
		expectedRepoID = stringValue(snapshot["projectId"])
	}
	if !automationOK || !runOK || run.AutomationID != automation.ID || !snapshotOK ||
		stringValue(snapshot["workspaceMode"]) != "new_per_run" || expectedRepoID != repoID ||
		req.CreateRequestID == "" {
		return AutomationWorkspaceProvenance{}, errInvalidAutomationProvenance
	}
	record.ReservedBy = req.CreateRequestID
	record.InFlight = true
	m.automationDispatchTokens[req.DispatchToken] = record
	projectID := nestedString(snapshot, "runContext", "projectId")
	if projectID == "" {
		projectID = stringValue(snapshot["projectId"])
	}
	return AutomationWorkspaceProvenance{
		Kind: "created-by-automation", AutomationID: automation.ID,
		AutomationNameSnapshot: automation.Name, AutomationRunID: run.ID,
		AutomationRunTitleSnapshot: automation.Name + " run", CreatedAt: now.UnixMilli(),
		ExecutionTargetType: stringValue(snapshot["executionTargetType"]),
		ExecutionTargetID:   stringValue(snapshot["executionTargetId"]), ProjectID: projectID,
		RepoID: expectedRepoID, HostID: nestedString(snapshot, "runContext", "hostId"),
	}, nil
}

func (m *Manager) ReleaseAutomationWorkspaceProvenance(req AutomationWorkspaceProvenanceRequest) {
	m.mu.Lock()
	defer m.mu.Unlock()
	record, ok := m.automationDispatchTokens[req.DispatchToken]
	if ok && record.ReservedBy == req.CreateRequestID {
		record.InFlight = false
		m.automationDispatchTokens[req.DispatchToken] = record
	}
}

func (m *Manager) FinishAutomationWorkspaceProvenance(req AutomationWorkspaceProvenanceRequest) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if record, ok := m.automationDispatchTokens[req.DispatchToken]; ok && record.ReservedBy == req.CreateRequestID {
		delete(m.automationDispatchTokens, req.DispatchToken)
	}
}

func rendererAutomationSnapshot(payload map[string]interface{}) (map[string]interface{}, bool) {
	snapshot, ok := payload[AutomationRendererPayloadKey].(map[string]interface{})
	return snapshot, ok
}

func nestedString(values map[string]interface{}, objectKey, valueKey string) string {
	nested, ok := values[objectKey].(map[string]interface{})
	if !ok {
		return ""
	}
	return stringValue(nested[valueKey])
}

func stringValue(value interface{}) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}
