package runtimehttp

import (
	"net/http"
	"strconv"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) handleSshClipboardImage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.SshClipboardImageRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.WriteSshClipboardImageContext(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

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
	entries, err := s.manager.ListFilesContext(r.Context(), runtimecore.ListFilesRequest{
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
	content, err := s.manager.ReadFileContext(r.Context(), runtimecore.ReadFileRequest{
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

func (s *Server) handleFileWatchSnapshot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	entries, err := s.manager.FileWatchSnapshotContext(r.Context(), runtimecore.ListFilesRequest{
		ProjectID: r.URL.Query().Get("projectId"), WorktreeID: r.URL.Query().Get("worktreeId"),
	})
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) handleFileReadChunk(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.ReadFileChunkRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	chunk, err := s.manager.ReadFileChunkContext(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, chunk)
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
	content, err := s.manager.WriteFileContext(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, content)
}

func (s *Server) handleFileWriteBase64(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.WriteFileBase64Request
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := s.manager.WriteFileBase64Context(r.Context(), req); err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleFileCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.FileMutationRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := s.manager.CreateFileContext(r.Context(), req); err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleFileCreateDir(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.FileMutationRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := s.manager.CreateDirectoryContext(r.Context(), req); err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleFileRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.FileRenameRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := s.manager.RenamePathContext(r.Context(), req); err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleFileCopy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.FileRenameRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := s.manager.CopyPathContext(r.Context(), req); err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleFileCommitUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.FileRenameRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := s.manager.CommitUploadContext(r.Context(), req); err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleFileDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.FileMutationRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := s.manager.DeletePathContext(r.Context(), req); err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleFileStat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	stat, err := s.manager.StatFileContext(r.Context(), runtimecore.ReadFileRequest{
		ProjectID:  r.URL.Query().Get("projectId"),
		WorktreeID: r.URL.Query().Get("worktreeId"),
		Path:       r.URL.Query().Get("path"),
	})
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, stat)
}

func (s *Server) handleFileListAll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.ListAllFilesRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.ListAllFilesContext(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleFileSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.FileSearchRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	// Why: the Tauri transport has a request deadline. Carry its cancellation to
	// the SSH process so a closed search does not keep scanning the remote host.
	result, err := s.manager.SearchFilesContext(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleFileMarkdownDocuments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	documents, err := s.manager.ListMarkdownDocuments(runtimecore.ListAllFilesRequest{
		ProjectID:  r.URL.Query().Get("projectId"),
		WorktreeID: r.URL.Query().Get("worktreeId"),
	})
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, documents)
}

func (s *Server) handleFileBrowseServerDir(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	result, err := s.manager.BrowseServerDirectory(runtimecore.ServerDirectoryBrowseRequest{
		Path: r.URL.Query().Get("path"),
	})
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
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
