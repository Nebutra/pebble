package runtimehttp

import (
	"net/http"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) handleSkillDiscovery(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.SkillDiscoveryRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	writeJSON(w, http.StatusOK, s.manager.DiscoverSkills(req))
}
