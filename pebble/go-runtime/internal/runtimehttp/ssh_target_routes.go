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
	case action == "credential":
		s.handleSshTargetCredential(w, r, id)
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

// handleSshTargetCredential seeds/clears/reads the memory-only relay credential
// cache. Responses only ever carry booleans — the secret value is never echoed,
// logged, or persisted (see runtimecore/ssh_credential_cache.go).
func (s *Server) handleSshTargetCredential(w http.ResponseWriter, r *http.Request, id string) {
	switch r.Method {
	case http.MethodGet:
		status, err := s.manager.SshCredentialStatus(id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, status)
	case http.MethodPost:
		var req struct {
			Kind  string `json:"kind"`
			Value string `json:"value"`
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		if req.Kind != runtimecore.SshCredentialKindPassphrase && req.Kind != runtimecore.SshCredentialKindPassword {
			writeError(w, http.StatusBadRequest, "credential kind must be passphrase or password")
			return
		}
		if req.Value == "" {
			writeError(w, http.StatusBadRequest, "credential value is required")
			return
		}
		status, err := s.manager.SeedSshCredential(id, req.Kind, req.Value)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, status)
	case http.MethodDelete:
		writeJSON(w, http.StatusOK, s.manager.ClearSshCredential(id))
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
