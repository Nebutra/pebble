package runtimehttp

import (
	"net/http"
	"strings"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

func (s *Server) handleSshTargets(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListSshTargets())
	case http.MethodPost:
		var req runtimecore.SshTargetInput
		if !decodeJSON(w, r, &req) {
			return
		}
		target, err := s.manager.CreateSshTarget(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, target)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleSshTargetImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	targets, err := s.manager.ImportSshTargetsFromConfig()
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, targets)
}

func (s *Server) handleSshTargetByID(w http.ResponseWriter, r *http.Request) {
	id, action := splitSshTargetPath(r.URL.Path)
	if id == "" {
		writeError(w, http.StatusNotFound, "ssh target not found")
		return
	}
	switch {
	case r.Method == http.MethodPatch && action == "":
		var req runtimecore.SshTargetUpdate
		if !decodeJSON(w, r, &req) {
			return
		}
		target, err := s.manager.UpdateSshTarget(id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, target)
	case r.Method == http.MethodDelete && action == "":
		target, err := s.manager.DeleteSshTarget(id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, target)
	case r.Method == http.MethodPost && action == "probe":
		result, err := s.manager.ProbeSshTarget(r.Context(), id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func splitSshTargetPath(path string) (string, string) {
	trimmed := strings.TrimPrefix(path, "/v1/ssh-targets/")
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		return "", ""
	}
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], strings.Join(parts[1:], "/")
}
