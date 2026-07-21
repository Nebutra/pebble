package runtimehttp

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) relayRemoteProviderRequest(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasPrefix(r.URL.Path, "/v1/providers/") {
		return false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxJSONBodyBytes+1))
	if err != nil || int64(len(body)) > maxJSONBodyBytes {
		writeError(w, http.StatusBadRequest, "provider request body is invalid or too large")
		return true
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	projectID, worktreeID := providerRelaySelector(r, body)
	if projectID == "" && worktreeID == "" {
		return false
	}
	remote, shouldRelay, err := s.manager.ResolveRemoteProviderContext(projectID, worktreeID)
	if err != nil {
		if err == runtimecore.ErrNotFound {
			return false
		}
		writeProviderError(w, err)
		return true
	}
	if !shouldRelay {
		return false
	}
	response, err := s.manager.RelayProviderRequest(r.Context(), remote, runtimecore.ProviderRelayRequest{
		Method: r.Method, Path: r.URL.Path, RawQuery: r.URL.RawQuery,
		Headers: map[string]string{"Content-Type": r.Header.Get("Content-Type")}, Body: body,
	})
	if err != nil {
		writeProviderError(w, err)
		return true
	}
	if response.Status < 100 || response.Status > 599 {
		writeError(w, http.StatusBadGateway, "provider relay returned an invalid status")
		return true
	}
	for key, value := range response.Headers {
		w.Header().Set(key, value)
	}
	w.WriteHeader(response.Status)
	_, _ = w.Write(response.Body)
	return true
}

func providerRelaySelector(r *http.Request, body []byte) (string, string) {
	projectID, worktreeID := providerSelector(r)
	if projectID != "" || worktreeID != "" || len(body) == 0 {
		return projectID, worktreeID
	}
	var payload struct {
		ProjectID  string `json:"projectId"`
		WorktreeID string `json:"worktreeId"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return "", ""
	}
	return payload.ProjectID, payload.WorktreeID
}
