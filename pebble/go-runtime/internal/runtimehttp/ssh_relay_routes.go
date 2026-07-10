package runtimehttp

import (
	"net/http"
	"strings"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

// These routes are the runtime-gateway side of the legacy relay-only SSH path:
// pebble-relay-worker executes git/agent probes on the remote host and posts
// the outcomes here, mirroring the file/source-control snapshot routes.

func (s *Server) handleRemoteWorktreeRemovals(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.CompleteRemoteWorktreeRemovalRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.CompleteRemoteWorktreeRemoval(req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleRemotePreservedBranchRemovals(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.CompleteRemotePreservedBranchRemovalRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.CompleteRemotePreservedBranchRemoval(req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleRemoteAgentDetections(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		hostID := strings.TrimSpace(r.URL.Query().Get("hostId"))
		if hostID == "" {
			writeError(w, http.StatusBadRequest, "hostId query parameter is required")
			return
		}
		detection, ok := s.manager.RemoteAgentDetectionForHost(hostID)
		if !ok {
			writeError(w, http.StatusNotFound, "no relay agent detection recorded for host")
			return
		}
		writeJSON(w, http.StatusOK, detection)
	case http.MethodPost:
		var req runtimecore.UpdateRemoteAgentDetectionRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		detection, err := s.manager.UpdateRemoteAgentDetection(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, detection)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
