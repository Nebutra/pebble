package runtimehttp

import (
	"net/http"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) handleProjectHostSetups(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListProjectHostSetups())
	case http.MethodPost:
		var req runtimecore.CreateProjectHostSetupRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		setup, err := s.manager.CreateProjectHostSetup(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, setup)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleProjectHostSetupByID(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/project-host-setups/"), "/")
	if id == "" {
		writeError(w, http.StatusNotFound, "project host setup not found")
		return
	}
	switch r.Method {
	case http.MethodPatch:
		var req runtimecore.UpdateProjectHostSetupRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		setup, err := s.manager.UpdateProjectHostSetup(id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, setup)
	case http.MethodDelete:
		setup, err := s.manager.DeleteProjectHostSetup(id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, setup)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
