package runtimehttp

import "net/http"

func (s *Server) handleStatsSummary(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	summary := s.manager.StatsSummary()
	// Deduplication URLs are persisted runtime state, not part of the public stats contract.
	writeJSON(w, http.StatusOK, map[string]any{
		"totalAgentsSpawned": summary.TotalAgentsSpawned,
		"totalPRsCreated":    summary.TotalPRsCreated,
		"totalAgentTimeMs":   summary.TotalAgentTimeMs,
		"firstEventAt":       summary.FirstEventAt,
	})
}
