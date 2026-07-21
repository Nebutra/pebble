package runtimecore

import "time"

type StatsSummary struct {
	TotalAgentsSpawned int64    `json:"totalAgentsSpawned"`
	TotalPRsCreated    int64    `json:"totalPRsCreated"`
	TotalAgentTimeMs   int64    `json:"totalAgentTimeMs"`
	FirstEventAt       int64    `json:"firstEventAt,omitempty"`
	CountedPRURLs      []string `json:"countedPRUrls,omitempty"`
}

func (m *Manager) StatsSummary() StatsSummary {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.stats
}

func (m *Manager) recordSessionStats(event Session) {
	if event.AgentKind == "" {
		return
	}
	m.mu.Lock()
	changed := false
	if event.Status == SessionRunning {
		if _, seen := m.liveAgentStats[event.ID]; !seen {
			m.liveAgentStats[event.ID] = event.StartedAt
			m.stats.TotalAgentsSpawned++
			m.setStatsFirstEventLocked(event.StartedAt)
			changed = true
		}
	} else if event.Status == SessionExited || event.Status == SessionFailed || event.Status == SessionStopped {
		if startedAt, seen := m.liveAgentStats[event.ID]; seen {
			delete(m.liveAgentStats, event.ID)
			m.stats.TotalAgentTimeMs += max(0, event.UpdatedAt.Sub(startedAt).Milliseconds())
			changed = true
		}
	}
	if changed {
		_ = m.saveLocked()
	}
	m.mu.Unlock()
}

func (m *Manager) recordCreatedReview(url string) {
	if url == "" {
		return
	}
	m.mu.Lock()
	for _, counted := range m.stats.CountedPRURLs {
		if counted == url {
			m.mu.Unlock()
			return
		}
	}
	m.stats.TotalPRsCreated++
	m.stats.CountedPRURLs = append(m.stats.CountedPRURLs, url)
	if len(m.stats.CountedPRURLs) > 2000 {
		m.stats.CountedPRURLs = m.stats.CountedPRURLs[len(m.stats.CountedPRURLs)-2000:]
	}
	m.setStatsFirstEventLocked(time.Now().UTC())
	_ = m.saveLocked()
	m.mu.Unlock()
}

func (m *Manager) setStatsFirstEventLocked(at time.Time) {
	if m.stats.FirstEventAt == 0 {
		m.stats.FirstEventAt = at.UnixMilli()
	}
}
