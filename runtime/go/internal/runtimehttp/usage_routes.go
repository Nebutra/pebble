package runtimehttp

import "net/http"

func (s *Server) handleClaudeUsage(w http.ResponseWriter, r *http.Request) {
	action := r.URL.Path[len("/v1/usage/claude/"):]
	switch action {
	case "state":
		if r.Method == http.MethodGet {
			state, err := s.manager.ClaudeUsageState()
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, state)
			return
		}
		if r.Method == http.MethodPost {
			var input struct {
				Enabled bool `json:"enabled"`
			}
			if !decodeJSON(w, r, &input) {
				return
			}
			state, err := s.manager.SetClaudeUsageEnabled(input.Enabled)
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, state)
			return
		}
	case "snapshot":
		if r.Method == http.MethodPost {
			var input struct {
				Force bool `json:"force"`
			}
			if !decodeJSON(w, r, &input) {
				return
			}
			snapshot, err := s.manager.RefreshClaudeUsage(r.Context(), input.Force)
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, snapshot)
			return
		}
	}
	writeError(w, http.StatusMethodNotAllowed, "method not allowed")
}

func (s *Server) handleCodexUsage(w http.ResponseWriter, r *http.Request) {
	action := r.URL.Path[len("/v1/usage/codex/"):]
	switch action {
	case "state":
		if r.Method == http.MethodGet {
			state, err := s.manager.CodexUsageState()
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, state)
			return
		}
		if r.Method == http.MethodPost {
			var input struct {
				Enabled bool `json:"enabled"`
			}
			if !decodeJSON(w, r, &input) {
				return
			}
			state, err := s.manager.SetCodexUsageEnabled(input.Enabled)
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, state)
			return
		}
	case "snapshot":
		if r.Method == http.MethodPost {
			var input struct {
				Force bool `json:"force"`
			}
			if !decodeJSON(w, r, &input) {
				return
			}
			snapshot, err := s.manager.RefreshCodexUsage(r.Context(), input.Force)
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, snapshot)
			return
		}
	}
	writeError(w, http.StatusMethodNotAllowed, "method not allowed")
}

func (s *Server) handleOpenCodeUsage(w http.ResponseWriter, r *http.Request) {
	action := r.URL.Path[len("/v1/usage/opencode/"):]
	switch action {
	case "state":
		if r.Method == http.MethodGet {
			state, err := s.manager.OpenCodeUsageState()
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, state)
			return
		}
		if r.Method == http.MethodPost {
			var input struct {
				Enabled bool `json:"enabled"`
			}
			if !decodeJSON(w, r, &input) {
				return
			}
			state, err := s.manager.SetOpenCodeUsageEnabled(input.Enabled)
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, state)
			return
		}
	case "snapshot":
		if r.Method == http.MethodPost {
			var input struct {
				Force bool `json:"force"`
			}
			if !decodeJSON(w, r, &input) {
				return
			}
			snapshot, err := s.manager.RefreshOpenCodeUsage(r.Context(), input.Force)
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, snapshot)
			return
		}
	}
	writeError(w, http.StatusMethodNotAllowed, "method not allowed")
}
