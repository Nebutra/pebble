package runtimecore

import (
	"errors"
	"sort"
	"strings"
	"time"
)

// Relay-fed agent detection mirrors Electron's SSH `detectRemoteAgents`: a
// relay worker probes the remote PATH for the desktop's TUI agent command
// catalog and posts the detected agent ids here, keyed by the SSH host id.
// Desktop callers without a paired runtime environment read this cache instead
// of getting a hard relay-required failure.

type RemoteAgentDetection struct {
	HostID    string    `json:"hostId"`
	Agents    []string  `json:"agents"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type UpdateRemoteAgentDetectionRequest struct {
	HostID string   `json:"hostId"`
	Agents []string `json:"agents"`
}

func (m *Manager) UpdateRemoteAgentDetection(req UpdateRemoteAgentDetectionRequest) (RemoteAgentDetection, error) {
	hostID := strings.TrimSpace(req.HostID)
	if hostID == "" {
		return RemoteAgentDetection{}, errors.New("host id is required")
	}
	seen := make(map[string]bool, len(req.Agents))
	agents := make([]string, 0, len(req.Agents))
	for _, agent := range req.Agents {
		agent = strings.TrimSpace(agent)
		if agent == "" || seen[agent] {
			continue
		}
		seen[agent] = true
		agents = append(agents, agent)
	}
	sort.Strings(agents)
	detection := RemoteAgentDetection{
		HostID:    hostID,
		Agents:    agents,
		UpdatedAt: time.Now().UTC(),
	}
	m.mu.Lock()
	m.remoteAgentDetections[hostID] = detection
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return RemoteAgentDetection{}, err
	}
	m.emit("remote-agents.changed", detection)
	return detection, nil
}

func (m *Manager) RemoteAgentDetectionForHost(hostID string) (RemoteAgentDetection, bool) {
	hostID = strings.TrimSpace(hostID)
	m.mu.RLock()
	defer m.mu.RUnlock()
	detection, ok := m.remoteAgentDetections[hostID]
	return detection, ok
}
