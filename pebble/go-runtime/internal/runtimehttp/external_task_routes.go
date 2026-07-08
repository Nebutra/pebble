package runtimehttp

import (
	"net/http"
	"strings"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

func (s *Server) handleExternalTasks(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		filter := runtimecore.ExternalWorkItemFilter{
			Provider:     r.URL.Query().Get("provider"),
			Kind:         runtimecore.ExternalWorkItemKind(r.URL.Query().Get("kind")),
			ProjectID:    r.URL.Query().Get("projectId"),
			TaskID:       r.URL.Query().Get("taskId"),
			RepositoryID: r.URL.Query().Get("repositoryId"),
			WorkspaceID:  r.URL.Query().Get("workspaceId"),
		}
		writeJSON(w, http.StatusOK, s.manager.ListExternalWorkItems(filter))
	case http.MethodPost:
		var req runtimecore.UpsertExternalWorkItemRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		item, err := s.manager.UpsertExternalWorkItem(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, item)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleExternalTaskByID(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/external-tasks/"), "/")
	if id == "" {
		writeError(w, http.StatusNotFound, "external task not found")
		return
	}
	switch r.Method {
	case http.MethodPatch:
		var req runtimecore.UpdateExternalWorkItemRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		item, err := s.manager.UpdateExternalWorkItem(id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, item)
	case http.MethodDelete:
		item, err := s.manager.DeleteExternalWorkItem(id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, item)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
