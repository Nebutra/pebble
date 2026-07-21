package runtimehttp

import (
	"net/http"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) handleProviderTextGenerationExecute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input runtimecore.ProviderTextGenerationPlan
	if !decodeJSON(w, r, &input) {
		return
	}
	writeJSON(w, http.StatusOK, s.manager.ExecuteProviderTextGeneration(r.Context(), input))
}

type providerTextGenerationCancelRequest struct {
	LaneKey string `json:"laneKey"`
}

func (s *Server) handleProviderTextGenerationCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input providerTextGenerationCancelRequest
	if !decodeJSON(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.LaneKey) == "" {
		writeError(w, http.StatusBadRequest, "lane key is required")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"canceled": s.manager.CancelProviderTextGeneration(input.LaneKey)})
}
