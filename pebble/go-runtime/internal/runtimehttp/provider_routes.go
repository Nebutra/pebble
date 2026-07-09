package runtimehttp

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/tsekaluk/pebble/go-runtime/internal/providercli"
	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

// Provider routes expose local gh / glab flows so the desktop app gets PR/MR +
// review data without pairing a remote environment. Paths are provider-neutral
// (/v1/providers/<provider>/...) with the provider as a path discriminator.

func (s *Server) handleProviderGitHubPRs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	limit := providerIntQuery(r, "limit", 24)
	items, err := s.manager.ListGitHubPRs(r.Context(), projectID, worktreeID, limit)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"items": items})
}

func (s *Server) handleProviderGitHubPRDetail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	number := providerIntQuery(r, "number", 0)
	if number <= 0 {
		writeError(w, http.StatusBadRequest, "number query parameter is required")
		return
	}
	projectID, worktreeID := providerSelector(r)
	item, err := s.manager.GetGitHubPR(r.Context(), projectID, worktreeID, number)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"item": item})
}

func (s *Server) handleProviderGitHubPRChecks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	number := providerIntQuery(r, "number", 0)
	if number <= 0 {
		writeError(w, http.StatusBadRequest, "number query parameter is required")
		return
	}
	projectID, worktreeID := providerSelector(r)
	checks, err := s.manager.GetGitHubPRChecks(r.Context(), projectID, worktreeID, number)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"checks": checks})
}

func (s *Server) handleProviderGitLabMRs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	state := r.URL.Query().Get("state")
	perPage := providerIntQuery(r, "perPage", 20)
	query := r.URL.Query().Get("query")
	items, err := s.manager.ListGitLabMRs(r.Context(), projectID, worktreeID, state, perPage, query)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"items": items})
}

func providerSelector(r *http.Request) (string, string) {
	return r.URL.Query().Get("projectId"), r.URL.Query().Get("worktreeId")
}

func providerIntQuery(r *http.Request, key string, fallback int) int {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return parsed
}

// writeProviderError maps CLI/selector failures to stable statuses so the TS
// bridge can distinguish "cli missing" and "not authenticated" from a generic
// load failure, matching the surfaces Electron produces.
func writeProviderError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, providercli.ErrCLIMissing):
		writeError(w, http.StatusNotImplemented, err.Error())
	case errors.Is(err, providercli.ErrCLIUnauthenticated):
		writeError(w, http.StatusUnauthorized, err.Error())
	case errors.Is(err, runtimecore.ErrNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, runtimecore.ErrRemoteNeedsRelay):
		writeError(w, http.StatusConflict, err.Error())
	default:
		writeError(w, http.StatusBadGateway, err.Error())
	}
}
