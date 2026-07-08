package runtimehttp

import (
	"net/http"
	"strconv"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

func (s *Server) handleFileTree(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	maxDepth := 1
	if raw := r.URL.Query().Get("maxDepth"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid maxDepth")
			return
		}
		maxDepth = parsed
	}
	entries, err := s.manager.ListFiles(runtimecore.ListFilesRequest{
		ProjectID:  r.URL.Query().Get("projectId"),
		WorktreeID: r.URL.Query().Get("worktreeId"),
		Path:       r.URL.Query().Get("path"),
		MaxDepth:   maxDepth,
	})
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) handleFileRead(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	maxBytes := int64(0)
	if raw := r.URL.Query().Get("maxBytes"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid maxBytes")
			return
		}
		maxBytes = parsed
	}
	content, err := s.manager.ReadFile(runtimecore.ReadFileRequest{
		ProjectID:  r.URL.Query().Get("projectId"),
		WorktreeID: r.URL.Query().Get("worktreeId"),
		Path:       r.URL.Query().Get("path"),
		MaxBytes:   maxBytes,
	})
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, content)
}

func (s *Server) handleFileWrite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.WriteFileRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	content, err := s.manager.WriteFile(req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, content)
}

func (s *Server) handleFileTreeSnapshots(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.UpdateRemoteFileTreeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	snapshot, err := s.manager.UpdateRemoteFileTree(req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) handleFileContentSnapshots(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.UpdateRemoteFileContentRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	snapshot, err := s.manager.UpdateRemoteFileContent(req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}
