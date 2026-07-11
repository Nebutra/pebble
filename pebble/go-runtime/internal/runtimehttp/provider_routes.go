package runtimehttp

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/tsekaluk/pebble/go-runtime/internal/providercli"
	"github.com/tsekaluk/pebble/go-runtime/internal/providerrest"
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

// handleReviewWorkItems serves the REST-backed providers (bitbucket,
// azure-devops, gitea) whose PR lists come from their HTTP APIs rather than a
// local CLI. Routes stay parallel to the github/gitlab ones.
func (s *Server) handleReviewWorkItems(provider string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		projectID, worktreeID := providerSelector(r)
		state := r.URL.Query().Get("state")
		limit := providerIntQuery(r, "limit", 24)
		items, err := s.manager.ListReviewWorkItems(r.Context(), projectID, worktreeID, provider, state, limit)
		if err != nil {
			writeProviderError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"items": items})
	}
}

func (s *Server) handleProviderReviewCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		ProjectID   string `json:"projectId"`
		WorktreeID  string `json:"worktreeId"`
		Provider    string `json:"provider"`
		Base        string `json:"base"`
		Head        string `json:"head"`
		Title       string `json:"title"`
		Body        string `json:"body"`
		Draft       bool   `json:"draft"`
		UseTemplate bool   `json:"useTemplate"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.CreateHostedReview(
		r.Context(),
		req.ProjectID,
		req.WorktreeID,
		providercli.CreateReviewRequest{
			Provider: req.Provider, Base: req.Base, Head: req.Head, Title: req.Title,
			Body: req.Body, Draft: req.Draft, UseTemplate: req.UseTemplate,
		},
	)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderReviewUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		ProjectID       string   `json:"projectId"`
		WorktreeID      string   `json:"worktreeId"`
		Provider        string   `json:"provider"`
		Number          int      `json:"number"`
		Title           *string  `json:"title"`
		Body            *string  `json:"body"`
		State           string   `json:"state"`
		AddReviewers    []string `json:"addReviewers"`
		RemoveReviewers []string `json:"removeReviewers"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.UpdateHostedReview(
		r.Context(),
		req.ProjectID,
		req.WorktreeID,
		providercli.UpdateReviewRequest{
			Provider: req.Provider, Number: req.Number, Title: req.Title, Body: req.Body,
			State: req.State, AddReviewers: req.AddReviewers, RemoveReviewers: req.RemoveReviewers,
		},
	)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderReviewCapabilities(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	capabilities, err := s.manager.HostedReviewCapabilities(r.Context(), projectID, worktreeID)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, capabilities)
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
	case errors.Is(err, providercli.ErrCLIUnauthenticated),
		errors.Is(err, providerrest.ErrUnauthenticated):
		writeError(w, http.StatusUnauthorized, err.Error())
	case errors.Is(err, providerrest.ErrRemoteMismatch),
		errors.Is(err, providerrest.ErrProviderUnsupported):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, runtimecore.ErrNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, runtimecore.ErrRemoteNeedsRelay):
		writeError(w, http.StatusConflict, err.Error())
	default:
		writeError(w, http.StatusBadGateway, err.Error())
	}
}
