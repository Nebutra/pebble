package runtimehttp

import (
	"net/http"
	"strconv"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) handleAiVaultSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	query := r.URL.Query()
	limit, _ := strconv.Atoi(query.Get("limit"))
	writeJSON(w, http.StatusOK, s.manager.ListAiVaultSessionsByScope(r.Context(), runtimecore.AiVaultListRequest{
		Limit:              limit,
		ExecutionHostScope: query.Get("executionHostScope"),
		ScopePaths:         query["scopePath"],
	}))
}
