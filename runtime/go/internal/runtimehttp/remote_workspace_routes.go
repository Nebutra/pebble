package runtimehttp

import (
	"net/http"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

type remoteWorkspaceGetRequest struct {
	TargetID  string `json:"targetId"`
	Namespace string `json:"namespace"`
}

type remoteWorkspacePatchRequest struct {
	TargetID string `json:"targetId"`
	runtimecore.RemoteWorkspacePatchRequest
}

type remoteWorkspacePresenceRequest struct {
	TargetID string `json:"targetId"`
	runtimecore.RemoteWorkspacePresenceRequest
}

type remoteWorkspaceWatchRequest struct {
	TargetID string `json:"targetId"`
	Enabled  bool   `json:"enabled"`
}

func (s *Server) handleRemoteWorkspaceGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req remoteWorkspaceGetRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.TargetID) == "" {
		writeError(w, http.StatusBadRequest, "targetId is required")
		return
	}
	result, err := s.manager.GetSshRemoteWorkspace(r.Context(), req.TargetID, req.Namespace)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleRemoteWorkspacePatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req remoteWorkspacePatchRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.PatchSshRemoteWorkspace(r.Context(), req.TargetID, req.RemoteWorkspacePatchRequest)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleRemoteWorkspacePresence(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req remoteWorkspacePresenceRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.TouchSshRemoteWorkspacePresence(r.Context(), req.TargetID, req.RemoteWorkspacePresenceRequest)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleRemoteWorkspaceWatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req remoteWorkspaceWatchRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.TargetID) == "" {
		writeError(w, http.StatusBadRequest, "targetId is required")
		return
	}
	if req.Enabled {
		s.remoteWorkspaceWatches.retain(req.TargetID)
	} else {
		s.remoteWorkspaceWatches.release(req.TargetID)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"watching": req.Enabled})
}
