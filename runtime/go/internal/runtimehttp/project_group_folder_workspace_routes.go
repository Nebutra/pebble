package runtimehttp

import (
	"context"
	"net/http"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) handleProjectGroups(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListProjectGroups())
	case http.MethodPost:
		var req runtimecore.CreateProjectGroupRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		group, err := s.manager.CreateProjectGroup(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, group)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleProjectGroupMoveProject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.MoveProjectToGroupRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	project, err := s.manager.MoveProjectToGroup(req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, project)
}

func (s *Server) handleProjectGroupScanNested(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.NestedRepoScanRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	ctx, done := s.beginNestedScan(r.Context(), req.ScanID)
	defer done()
	scan, err := s.manager.ScanNestedRepos(ctx, req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, scan)
}

func (s *Server) handleProjectGroupScanNestedCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		ScanID string `json:"scanId"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"canceled": s.cancelNestedScan(req.ScanID)})
}

func (s *Server) beginNestedScan(parent context.Context, scanID string) (context.Context, func()) {
	scanID = strings.TrimSpace(scanID)
	if scanID == "" {
		return parent, func() {}
	}
	ctx, cancel := context.WithCancel(parent)
	entry := &nestedScanCancellation{cancel: cancel}
	s.nestedScanMu.Lock()
	previous := s.nestedScanCancels[scanID]
	s.nestedScanCancels[scanID] = entry
	s.nestedScanMu.Unlock()
	if previous != nil {
		previous.cancel()
	}
	return ctx, func() {
		s.nestedScanMu.Lock()
		if s.nestedScanCancels[scanID] == entry {
			delete(s.nestedScanCancels, scanID)
		}
		s.nestedScanMu.Unlock()
		cancel()
	}
}

func (s *Server) cancelNestedScan(scanID string) bool {
	scanID = strings.TrimSpace(scanID)
	if scanID == "" {
		return false
	}
	s.nestedScanMu.Lock()
	entry := s.nestedScanCancels[scanID]
	delete(s.nestedScanCancels, scanID)
	s.nestedScanMu.Unlock()
	if entry == nil {
		return false
	}
	entry.cancel()
	return true
}

func (s *Server) handleProjectGroupImportNested(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.ProjectGroupImportNestedRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.ImportNestedRepos(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProjectGroupByID(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/project-groups/"), "/")
	if id == "" {
		writeError(w, http.StatusNotFound, "project group not found")
		return
	}
	switch r.Method {
	case http.MethodPatch:
		var req runtimecore.UpdateProjectGroupRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		group, err := s.manager.UpdateProjectGroup(id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, group)
	case http.MethodDelete:
		deleted, err := s.manager.DeleteProjectGroup(id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"deleted": deleted})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleFolderWorkspaces(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListFolderWorkspaces())
	case http.MethodPost:
		var req runtimecore.CreateFolderWorkspaceRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		workspace, err := s.manager.CreateFolderWorkspace(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, workspace)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleFolderWorkspacePathStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.FolderWorkspacePathStatusRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	writeJSON(w, http.StatusOK, s.manager.GetFolderWorkspacePathStatus(req))
}

func (s *Server) handleFolderWorkspaceByID(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/folder-workspaces/"), "/")
	if id == "" {
		writeError(w, http.StatusNotFound, "folder workspace not found")
		return
	}
	switch r.Method {
	case http.MethodPatch:
		var req runtimecore.UpdateFolderWorkspaceRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		workspace, ok, err := s.manager.UpdateFolderWorkspace(id, req.Updates)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		if !ok {
			writeError(w, http.StatusNotFound, "folder workspace not found")
			return
		}
		writeJSON(w, http.StatusOK, workspace)
	case http.MethodDelete:
		deleted, err := s.manager.DeleteFolderWorkspace(id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"deleted": deleted})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
