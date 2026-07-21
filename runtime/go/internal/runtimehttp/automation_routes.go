package runtimehttp

import (
	"net/http"
	"strings"
	"time"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) handleAutomations(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListAutomations())
	case http.MethodPost:
		var req runtimecore.CreateAutomationRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		automation, err := s.manager.CreateAutomation(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, automation)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleAutomationWorkspaceNameSnapshot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var request struct {
		WorkspaceID string `json:"workspaceId"`
		DisplayName string `json:"displayName"`
	}
	if !decodeJSON(w, r, &request) {
		return
	}
	updated, err := s.manager.SnapshotAutomationWorkspaceDisplayName(request.WorkspaceID, request.DisplayName)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"updated": updated})
}

func (s *Server) handleAutomationRendererReady(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	dispatches, err := s.manager.CatchUpAutomationRendererDispatches()
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, dispatches)
}

func (s *Server) handleAutomationByID(w http.ResponseWriter, r *http.Request) {
	id, action := splitAutomationPath(r.URL.Path)
	if id == "" {
		writeError(w, http.StatusNotFound, "automation not found")
		return
	}
	switch {
	case r.Method == http.MethodPatch && action == "":
		var req runtimecore.UpdateAutomationRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		automation, err := s.manager.UpdateAutomation(id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, automation)
	case r.Method == http.MethodDelete && action == "":
		automation, err := s.manager.DeleteAutomation(id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, automation)
	case r.Method == http.MethodGet && action == "runs":
		writeJSON(w, http.StatusOK, s.manager.ListAutomationRuns(id))
	case r.Method == http.MethodPost && action == "runs":
		var req runtimecore.TriggerAutomationRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		run, err := s.manager.TriggerAutomation(r.Context(), id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, run)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleAutomationRuns(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.ListAutomationRuns(r.URL.Query().Get("automationId")))
}

// handleAutomationRunByID owns /v1/automations/runs/{id}/... — currently the
// renderer dispatch-outcome writeback (Electron markDispatchResult parity).
func (s *Server) handleAutomationRunByID(w http.ResponseWriter, r *http.Request) {
	runID, action := splitAutomationRunPath(r.URL.Path)
	if runID == "" {
		writeError(w, http.StatusNotFound, "automation run not found")
		return
	}
	if r.Method != http.MethodPost || action != "dispatch-result" {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.AutomationDispatchResultRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	run, err := s.manager.RecordAutomationRunDispatchResult(runID, req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, run)
}

func (s *Server) handleAutomationEvaluate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.EvaluateAutomationsRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	now := time.Now().UTC()
	if req.Now != nil {
		now = req.Now.UTC()
	}
	runs, err := s.manager.EvaluateScheduledAutomations(r.Context(), now)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, runs)
}

func splitAutomationRunPath(path string) (string, string) {
	trimmed := strings.TrimPrefix(path, "/v1/automations/runs/")
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		return "", ""
	}
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], strings.Join(parts[1:], "/")
}

func splitAutomationPath(path string) (string, string) {
	trimmed := strings.TrimPrefix(path, "/v1/automations/")
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		return "", ""
	}
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], strings.Join(parts[1:], "/")
}
