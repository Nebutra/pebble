package runtimehttp

import (
	"net/http"
	"strings"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

// handleSessionTabLayoutByWorktree persists and serves the durable per-worktree
// session tab/group/pane layout snapshot (PUT to save, GET to read, DELETE to
// drop) so tab moves and pane layouts survive runtime restarts.
func (s *Server) handleSessionTabLayoutByWorktree(w http.ResponseWriter, r *http.Request) {
	worktreeID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/session-tab-layouts/"), "/")
	if worktreeID == "" {
		writeError(w, http.StatusNotFound, "session tab layout not found")
		return
	}
	switch r.Method {
	case http.MethodGet:
		layout, err := s.manager.GetSessionTabLayout(worktreeID)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, layout)
	case http.MethodPut:
		var req runtimecore.SaveSessionTabLayoutRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		layout, err := s.manager.SaveSessionTabLayout(worktreeID, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, layout)
	case http.MethodDelete:
		deleted, err := s.manager.DeleteSessionTabLayout(worktreeID)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"deleted": deleted})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
