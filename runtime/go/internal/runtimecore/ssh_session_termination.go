package runtimecore

import "strings"

type SshSessionTerminationResult struct {
	TargetID      string   `json:"targetId"`
	TerminatedIDs []string `json:"terminatedIds"`
	FailedIDs     []string `json:"failedIds"`
}

func (m *Manager) TerminateSshTargetSessions(targetID string) (SshSessionTerminationResult, error) {
	targetID = strings.TrimSpace(targetID)
	if _, ok := m.GetSshTarget(targetID); !ok {
		return SshSessionTerminationResult{}, ErrNotFound
	}
	m.mu.RLock()
	ids := make([]string, 0)
	for id, session := range m.sessions {
		project, ok := m.projects[session.projectID]
		if ok && project.LocationKind == "ssh" && project.HostID == targetID {
			ids = append(ids, id)
		}
	}
	m.mu.RUnlock()
	result := SshSessionTerminationResult{TargetID: targetID, TerminatedIDs: []string{}, FailedIDs: []string{}}
	for _, id := range ids {
		if _, err := m.StopSession(id); err != nil && err != ErrSessionNotFound {
			result.FailedIDs = append(result.FailedIDs, id)
			continue
		}
		result.TerminatedIDs = append(result.TerminatedIDs, id)
	}
	return result, nil
}
