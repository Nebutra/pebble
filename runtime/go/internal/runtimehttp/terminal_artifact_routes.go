package runtimehttp

import (
	"net/http"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) handleTerminalArtifactGrant(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.TerminalArtifactGrantRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.GrantSshTerminalArtifactContext(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleTerminalArtifactRead(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.TerminalArtifactAccessRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.ReadSshTerminalArtifactContext(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleTerminalArtifactPreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.TerminalArtifactAccessRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.PreviewSshTerminalArtifactContext(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleTerminalArtifactWrite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.TerminalArtifactAccessRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := s.manager.WriteSshTerminalArtifactContext(r.Context(), req); err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
