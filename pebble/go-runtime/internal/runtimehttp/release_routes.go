package runtimehttp

import (
	"net/http"
	"strings"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

func (s *Server) handleReleases(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListReleasePlans())
	case http.MethodPost:
		var req runtimecore.CreateReleasePlanRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		plan, err := s.manager.CreateReleasePlan(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, plan)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleReleaseByID(w http.ResponseWriter, r *http.Request) {
	id, action := splitReleasePath(r.URL.Path)
	if id == "" {
		writeError(w, http.StatusNotFound, "release not found")
		return
	}
	switch {
	case r.Method == http.MethodGet && action == "manifest":
		manifest, err := s.manager.GetReleaseUpdateManifest(id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, manifest)
	case r.Method == http.MethodPatch && action == "":
		var req runtimecore.UpdateReleasePlanRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		plan, err := s.manager.UpdateReleasePlan(id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, plan)
	case r.Method == http.MethodPost && action == "artifacts":
		var req runtimecore.UpsertReleaseArtifactRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		plan, err := s.manager.UpsertReleaseArtifact(id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, plan)
	case r.Method == http.MethodPost && action == "checks":
		var req runtimecore.UpdateReleaseCheckRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		plan, err := s.manager.UpdateReleaseCheck(id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, plan)
	case r.Method == http.MethodPost && action == "publish":
		var req runtimecore.PublishReleasePlanRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		plan, err := s.manager.PublishReleasePlan(id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, plan)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func splitReleasePath(path string) (string, string) {
	trimmed := strings.TrimPrefix(path, "/v1/releases/")
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		return "", ""
	}
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], strings.Join(parts[1:], "/")
}
