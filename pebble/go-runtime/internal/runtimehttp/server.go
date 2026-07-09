package runtimehttp

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

const maxJSONBodyBytes int64 = 16 * 1024 * 1024

type Server struct {
	manager     *runtimecore.Manager
	mux         *http.ServeMux
	bearerToken string
}

type ServerOptions struct {
	BearerToken string
}

func NewServer(manager *runtimecore.Manager) *Server {
	return NewServerWithOptions(manager, ServerOptions{})
}

func NewServerWithOptions(manager *runtimecore.Manager, options ServerOptions) *Server {
	server := &Server{
		manager:     manager,
		mux:         http.NewServeMux(),
		bearerToken: strings.TrimSpace(options.BearerToken),
	}
	server.routes()
	return server
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(r) {
		writeError(w, http.StatusUnauthorized, "missing or invalid bearer token")
		return
	}
	s.mux.ServeHTTP(w, r)
}

func (s *Server) authorize(r *http.Request) bool {
	if s.bearerToken == "" {
		return true
	}
	if r.URL.Path == "/v1/mobile-relay" && isWebSocketUpgrade(r) {
		return true
	}
	token := bearerTokenFromHeader(r.Header.Get("Authorization"))
	if token == "" || len(token) != len(s.bearerToken) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(s.bearerToken)) == 1
}

func (s *Server) routes() {
	s.mux.HandleFunc("/v1/status", s.handleStatus)
	s.mux.HandleFunc("/v1/projects", s.handleProjects)
	s.mux.HandleFunc("/v1/projects/clone", s.handleProjectClone)
	s.mux.HandleFunc("/v1/projects/", s.handleProjectByID)
	s.mux.HandleFunc("/v1/project-groups", s.handleProjectGroups)
	s.mux.HandleFunc("/v1/project-groups/move-project", s.handleProjectGroupMoveProject)
	s.mux.HandleFunc("/v1/project-groups/scan-nested", s.handleProjectGroupScanNested)
	s.mux.HandleFunc("/v1/project-groups/import-nested", s.handleProjectGroupImportNested)
	s.mux.HandleFunc("/v1/project-groups/", s.handleProjectGroupByID)
	s.mux.HandleFunc("/v1/folder-workspaces", s.handleFolderWorkspaces)
	s.mux.HandleFunc("/v1/folder-workspaces/path-status", s.handleFolderWorkspacePathStatus)
	s.mux.HandleFunc("/v1/folder-workspaces/", s.handleFolderWorkspaceByID)
	s.mux.HandleFunc("/v1/worktrees", s.handleWorktrees)
	s.mux.HandleFunc("/v1/worktrees/branches/force-delete", s.handleForceDeletePreservedBranch)
	s.mux.HandleFunc("/v1/worktrees/", s.handleWorktreeByID)
	s.mux.HandleFunc("/v1/sessions", s.handleSessions)
	s.mux.HandleFunc("/v1/sessions/", s.handleSessionByID)
	s.mux.HandleFunc("/v1/agents", s.handleAgents)
	s.mux.HandleFunc("/v1/agents/profiles", s.handleAgentProfiles)
	s.mux.HandleFunc("/v1/agents/profiles/", s.handleAgentProfileByID)
	s.mux.HandleFunc("/v1/agents/runs", s.handleAgentRuns)
	s.mux.HandleFunc("/v1/agents/runs/", s.handleAgentRunByID)
	s.mux.HandleFunc("/v1/orchestration/messages", s.handleMessages)
	s.mux.HandleFunc("/v1/orchestration/messages/", s.handleMessageByID)
	s.mux.HandleFunc("/v1/orchestration/tasks", s.handleTasks)
	s.mux.HandleFunc("/v1/orchestration/tasks/", s.handleTaskByID)
	s.mux.HandleFunc("/v1/orchestration/dispatches", s.handleDispatches)
	s.mux.HandleFunc("/v1/orchestration/dispatches/", s.handleDispatchByID)
	s.mux.HandleFunc("/v1/automations", s.handleAutomations)
	s.mux.HandleFunc("/v1/automations/evaluate", s.handleAutomationEvaluate)
	s.mux.HandleFunc("/v1/automations/runs", s.handleAutomationRuns)
	s.mux.HandleFunc("/v1/automations/", s.handleAutomationByID)
	s.mux.HandleFunc("/v1/external-tasks", s.handleExternalTasks)
	s.mux.HandleFunc("/v1/external-tasks/", s.handleExternalTaskByID)
	s.mux.HandleFunc("/v1/files/tree", s.handleFileTree)
	s.mux.HandleFunc("/v1/files/read", s.handleFileRead)
	s.mux.HandleFunc("/v1/files/read-chunk", s.handleFileReadChunk)
	s.mux.HandleFunc("/v1/files/write", s.handleFileWrite)
	s.mux.HandleFunc("/v1/files/write-base64", s.handleFileWriteBase64)
	s.mux.HandleFunc("/v1/files/create-file", s.handleFileCreate)
	s.mux.HandleFunc("/v1/files/create-dir", s.handleFileCreateDir)
	s.mux.HandleFunc("/v1/files/rename", s.handleFileRename)
	s.mux.HandleFunc("/v1/files/copy", s.handleFileCopy)
	s.mux.HandleFunc("/v1/files/delete", s.handleFileDelete)
	s.mux.HandleFunc("/v1/files/stat", s.handleFileStat)
	s.mux.HandleFunc("/v1/files/list", s.handleFileListAll)
	s.mux.HandleFunc("/v1/files/search", s.handleFileSearch)
	s.mux.HandleFunc("/v1/files/markdown", s.handleFileMarkdownDocuments)
	s.mux.HandleFunc("/v1/files/browse-dir", s.handleFileBrowseServerDir)
	s.mux.HandleFunc("/v1/files/tree-snapshots", s.handleFileTreeSnapshots)
	s.mux.HandleFunc("/v1/files/content-snapshots", s.handleFileContentSnapshots)
	s.mux.HandleFunc("/v1/releases", s.handleReleases)
	s.mux.HandleFunc("/v1/releases/", s.handleReleaseByID)
	s.mux.HandleFunc("/v1/settings", s.handleSettings)
	s.mux.HandleFunc("/v1/settings/keybindings", s.handleKeybindings)
	s.mux.HandleFunc("/v1/source-control", s.handleSourceControl)
	s.mux.HandleFunc("/v1/source-control/projections", s.handleSourceControlProjectionUpdates)
	s.mux.HandleFunc("/v1/source-control/diff", s.handleGitDiff)
	s.mux.HandleFunc("/v1/source-control/file-diff", s.handleGitFileDiff)
	s.mux.HandleFunc("/v1/source-control/ref-file-diff", s.handleGitRefFileDiff)
	s.mux.HandleFunc("/v1/source-control/mutate", s.handleGitMutation)
	s.mux.HandleFunc("/v1/source-control/check-ignored", s.handleGitCheckIgnored)
	s.mux.HandleFunc("/v1/source-control/submodule-status", s.handleGitSubmoduleStatus)
	s.mux.HandleFunc("/v1/source-control/remote-file-url", s.handleGitRemoteFileURL)
	s.mux.HandleFunc("/v1/source-control/remote-commit-url", s.handleGitRemoteCommitURL)
	s.mux.HandleFunc("/v1/source-control/fork-sync", s.handleGitForkSync)
	s.mux.HandleFunc("/v1/source-control/branch-compare", s.handleGitBranchCompare)
	s.mux.HandleFunc("/v1/source-control/commit-compare", s.handleGitCommitCompare)
	s.mux.HandleFunc("/v1/source-control/history", s.handleGitHistory)
	s.mux.HandleFunc("/v1/source-control/base-status", s.handleGitBaseStatus)
	s.mux.HandleFunc("/v1/source-control/status", s.handleGitStatus)
	s.mux.HandleFunc("/v1/browser/tabs", s.handleBrowserTabs)
	s.mux.HandleFunc("/v1/browser/tabs/", s.handleBrowserTabByID)
	s.mux.HandleFunc("/v1/browser/profiles", s.handleBrowserProfiles)
	s.mux.HandleFunc("/v1/browser/profiles/", s.handleBrowserProfileByID)
	s.mux.HandleFunc("/v1/browser/permissions", s.handleBrowserPermissions)
	s.mux.HandleFunc("/v1/browser/downloads", s.handleBrowserDownloads)
	s.mux.HandleFunc("/v1/browser/downloads/", s.handleBrowserDownloadByID)
	s.mux.HandleFunc("/v1/browser/status", s.handleSubsystem("browser"))
	s.mux.HandleFunc("/v1/computer/actions", s.handleComputerActions)
	s.mux.HandleFunc("/v1/computer/actions/claim", s.handleComputerActionClaim)
	s.mux.HandleFunc("/v1/computer/actions/", s.handleComputerActionByID)
	s.mux.HandleFunc("/v1/computer/status", s.handleSubsystem("computer"))
	s.mux.HandleFunc("/v1/emulator/devices", s.handleEmulatorDevices)
	s.mux.HandleFunc("/v1/emulator/devices/", s.handleEmulatorDeviceByID)
	s.mux.HandleFunc("/v1/emulator/sessions", s.handleEmulatorSessions)
	s.mux.HandleFunc("/v1/emulator/sessions/", s.handleEmulatorSessionByID)
	s.mux.HandleFunc("/v1/emulator/status", s.handleSubsystem("emulator"))
	s.mux.HandleFunc("/v1/providers", s.handleNativeProviders)
	s.mux.HandleFunc("/v1/providers/github/pulls", s.handleProviderGitHubPRs)
	s.mux.HandleFunc("/v1/providers/github/pulls/detail", s.handleProviderGitHubPRDetail)
	s.mux.HandleFunc("/v1/providers/github/pulls/checks", s.handleProviderGitHubPRChecks)
	s.mux.HandleFunc("/v1/providers/gitlab/merge-requests", s.handleProviderGitLabMRs)
	s.mux.HandleFunc("/v1/mobile-relay/status", s.handleMobileRelayStatus)
	s.mux.HandleFunc("/v1/mobile-relay/pairing-codes", s.handleMobileRelayPairingCodes)
	s.mux.HandleFunc("/v1/mobile-relay/pairings", s.handleMobileRelayPairings)
	s.mux.HandleFunc("/v1/mobile-relay/pairings/", s.handleMobileRelayPairingByDeviceID)
	s.mux.HandleFunc("/v1/mobile-relay/projection", s.handleMobileRelayProjection)
	s.mux.HandleFunc("/v1/mobile-relay", s.handleMobileRelay)
	s.mux.HandleFunc("/v1/events", s.handleEvents)
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.Status())
}

func (s *Server) handleProjects(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListProjects())
	case http.MethodPost:
		var req runtimecore.CreateProjectRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		project, err := s.manager.CreateProject(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, project)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleProjectClone(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.CloneProjectRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	project, err := s.manager.CloneProject(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, project)
}

func (s *Server) handleProjectByID(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/projects/"), "/")
	if id == "" {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	if id == "reorder" {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req runtimecore.PersistProjectSortOrderRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		if err := s.manager.PersistProjectSortOrder(req.OrderedIDs); err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "applied"})
		return
	}
	switch r.Method {
	case http.MethodPatch:
		var req runtimecore.UpdateProjectRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		project, err := s.manager.UpdateProject(id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, project)
	case http.MethodDelete:
		project, err := s.manager.DeleteProject(id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, project)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleWorktrees(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListWorktrees(r.URL.Query().Get("projectId")))
	case http.MethodPost:
		var req runtimecore.CreateWorktreeRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		worktree, err := s.manager.CreateWorktree(r.Context(), req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, worktree)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleWorktreeByID(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/worktrees/"), "/")
	if id == "" {
		writeError(w, http.StatusNotFound, "worktree not found")
		return
	}
	if id == "sort-order" {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req runtimecore.PersistWorktreeSortOrderRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		if err := s.manager.PersistWorktreeSortOrder(req.OrderedIDs); err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "applied"})
		return
	}
	if id == "lineage" {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		writeJSON(w, http.StatusOK, s.manager.ListWorktreeLineage())
		return
	}
	if r.Method == http.MethodPatch {
		var req runtimecore.UpdateWorktreeRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		worktree, err := s.manager.UpdateWorktree(id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, worktree)
		return
	}
	if r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.DeleteWorktreeRequest
	if r.ContentLength != 0 {
		if !decodeJSON(w, r, &req) {
			return
		}
	}
	worktree, err := s.manager.DeleteWorktree(r.Context(), id, req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, worktree)
}

func (s *Server) handleForceDeletePreservedBranch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.ForceDeletePreservedBranchRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.ForceDeletePreservedBranch(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListSessions())
	case http.MethodPost:
		var req runtimecore.StartSessionRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		session, err := s.manager.StartSession(r.Context(), req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, session)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleSessionByID(w http.ResponseWriter, r *http.Request) {
	id, action := splitSessionPath(r.URL.Path)
	if id == "" {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	switch {
	case r.Method == http.MethodPost && action == "input":
		var req runtimecore.SessionInputRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		if err := s.manager.WriteSession(id, req); err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "accepted"})
	case r.Method == http.MethodPost && action == "resize":
		var req runtimecore.SessionResizeRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		session, err := s.manager.ResizeSession(id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, session)
	case r.Method == http.MethodGet && action == "tail":
		limit := 200
		if raw := r.URL.Query().Get("limit"); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil {
				limit = parsed
			}
		}
		tail, err := s.manager.TailSession(id, limit)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, tail)
	case r.Method == http.MethodPost && action == "clear-buffer":
		session, err := s.manager.ClearSessionBuffer(id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, session)
	case r.Method == http.MethodDelete && action == "":
		session, err := s.manager.StopSession(id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, session)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleAgents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"profiles": s.manager.ListAgentProfiles(),
		"runs":     s.manager.ListAgentRuns(),
	})
}

func (s *Server) handleAgentProfiles(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListAgentProfiles())
	case http.MethodPost:
		var req runtimecore.CreateAgentProfileRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		profile, err := s.manager.CreateAgentProfile(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, profile)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleAgentProfileByID(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/agents/profiles/"), "/")
	if id == "" {
		writeError(w, http.StatusNotFound, "agent profile not found")
		return
	}
	switch r.Method {
	case http.MethodPatch:
		var req runtimecore.UpdateAgentProfileRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		profile, err := s.manager.UpdateAgentProfile(id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, profile)
	case http.MethodDelete:
		profile, err := s.manager.DeleteAgentProfile(id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, profile)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleAgentRuns(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListAgentRuns())
	case http.MethodPost:
		var req runtimecore.StartAgentRunRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		run, err := s.manager.StartAgentRun(r.Context(), req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, run)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleAgentRunByID(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/agents/runs/"), "/")
	if id == "" {
		writeError(w, http.StatusNotFound, "agent run not found")
		return
	}
	if r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	run, err := s.manager.StopAgentRun(id)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, run)
}

func (s *Server) handleTasks(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListTasks())
	case http.MethodPost:
		var req runtimecore.CreateTaskRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		task, err := s.manager.CreateTask(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, task)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleTaskByID(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/orchestration/tasks/"), "/")
	if id == "" {
		writeError(w, http.StatusNotFound, "task not found")
		return
	}
	if r.Method != http.MethodPatch {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.UpdateTaskRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	task, err := s.manager.UpdateTask(id, req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, task)
}

func (s *Server) handleMessages(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListMessages(
			r.URL.Query().Get("to"),
			r.URL.Query().Get("unread") == "true",
		))
	case http.MethodPost:
		var req runtimecore.SendMessageRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		message, err := s.manager.SendMessage(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, message)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleMessageByID(w http.ResponseWriter, r *http.Request) {
	id, action := splitOrchestrationPath(r.URL.Path, "/v1/orchestration/messages/")
	if id == "" {
		writeError(w, http.StatusNotFound, "message not found")
		return
	}
	if r.Method != http.MethodPost || action != "reply" {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.SendMessageRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	message, err := s.manager.ReplyMessage(id, req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, message)
}

func (s *Server) handleDispatches(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListDispatches(r.URL.Query().Get("taskId")))
	case http.MethodPost:
		var req runtimecore.DispatchTaskRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		dispatch, err := s.manager.DispatchTask(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, dispatch)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleDispatchByID(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/orchestration/dispatches/"), "/")
	if id == "" {
		writeError(w, http.StatusNotFound, "dispatch not found")
		return
	}
	if r.Method != http.MethodPatch {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.UpdateDispatchRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	dispatch, err := s.manager.UpdateDispatch(id, req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, dispatch)
}

func (s *Server) handleSourceControl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projections := s.manager.ListSourceControlProjections(runtimecore.SourceControlProjectionFilter{
		ProjectID:   r.URL.Query().Get("projectId"),
		WorkspaceID: r.URL.Query().Get("workspaceId"),
	})
	writeJSON(w, http.StatusOK, projections)
}

func (s *Server) handleSourceControlProjectionUpdates(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.UpdateSourceControlProjectionRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	projection, err := s.manager.UpdateSourceControlProjection(req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, projection)
}

func (s *Server) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID := r.URL.Query().Get("projectId")
	status, err := s.manager.GitStatus(r.Context(), projectID)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) handleGitDiff(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	diff, err := s.manager.GitDiff(
		r.Context(),
		r.URL.Query().Get("projectId"),
		r.URL.Query().Get("path"),
		r.URL.Query().Get("cached") == "true",
	)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, diff)
}

func (s *Server) handleGitFileDiff(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.GitFileDiffRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	diff, err := s.manager.GitFileDiff(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, diff)
}

func (s *Server) handleGitRefFileDiff(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.GitRefFileDiffRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	diff, err := s.manager.GitRefFileDiff(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, diff)
}

func (s *Server) handleGitMutation(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.GitMutationRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.MutateGit(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleGitBaseStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.GitBaseStatusRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.GitBaseStatus(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleGitCheckIgnored(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.GitCheckIgnoredRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.GitCheckIgnored(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleGitSubmoduleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.GitSubmoduleStatusRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.GitSubmoduleStatus(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleGitRemoteFileURL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.GitRemoteFileURLRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.GitRemoteFileURL(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleGitRemoteCommitURL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.GitRemoteCommitURLRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.GitRemoteCommitURL(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleGitForkSync(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.GitForkSyncRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.GitForkSync(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleGitBranchCompare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.GitBranchCompareRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.GitBranchCompare(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleGitCommitCompare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.GitCommitCompareRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.GitCommitCompare(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleGitHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.GitHistoryRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.GitHistory(r.Context(), req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleBrowserTabs(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListBrowserTabs())
	case http.MethodPost:
		var req runtimecore.CreateBrowserTabRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		tab, err := s.manager.CreateBrowserTab(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, tab)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleBrowserTabByID(w http.ResponseWriter, r *http.Request) {
	id, action := splitBrowserTabPath(r.URL.Path)
	if id == "" {
		writeError(w, http.StatusNotFound, "browser tab not found")
		return
	}
	switch r.Method {
	case http.MethodPatch:
		if action != "" {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req runtimecore.UpdateBrowserTabRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		tab, err := s.manager.UpdateBrowserTab(id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, tab)
	case http.MethodDelete:
		if action != "" {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		tab, err := s.manager.DeleteBrowserTab(id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, tab)
	case http.MethodPost:
		if action != "commands" {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req runtimecore.BrowserCommandRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		computerAction, err := s.manager.QueueBrowserCommand(id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, computerAction)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleBrowserProfiles(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListBrowserProfiles())
	case http.MethodPost:
		var req runtimecore.CreateBrowserProfileRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		profile, err := s.manager.CreateBrowserProfile(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, profile)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleBrowserProfileByID(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/browser/profiles/"), "/")
	if id == "" {
		writeError(w, http.StatusNotFound, "browser profile not found")
		return
	}
	if r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	profile, err := s.manager.DeleteBrowserProfile(id)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, profile)
}

func (s *Server) handleBrowserPermissions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListBrowserPermissions(
			r.URL.Query().Get("profileId"),
			r.URL.Query().Get("origin"),
		))
	case http.MethodPost:
		var req runtimecore.SetBrowserPermissionRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		permission, err := s.manager.SetBrowserPermission(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, permission)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleBrowserDownloads(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListBrowserDownloads(r.URL.Query().Get("tabId")))
	case http.MethodPost:
		var req runtimecore.CreateBrowserDownloadRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		download, err := s.manager.CreateBrowserDownload(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, download)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleBrowserDownloadByID(w http.ResponseWriter, r *http.Request) {
	id, action := splitBrowserDownloadPath(r.URL.Path)
	if id == "" {
		writeError(w, http.StatusNotFound, "browser download not found")
		return
	}
	switch r.Method {
	case http.MethodPatch:
		if action != "" {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req runtimecore.UpdateBrowserDownloadRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		download, err := s.manager.UpdateBrowserDownload(id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, download)
	case http.MethodPost:
		if action != "commands/start" {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		computerAction, err := s.manager.QueueBrowserDownload(id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, computerAction)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleComputerActions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		status := runtimecore.ComputerActionStatus(r.URL.Query().Get("status"))
		if status != "" && !isHTTPComputerActionStatus(status) {
			writeError(w, http.StatusBadRequest, "invalid computer action status")
			return
		}
		writeJSON(w, http.StatusOK, s.manager.ListComputerActions(
			status,
			r.URL.Query().Get("kindPrefix"),
		))
	case http.MethodPost:
		var req runtimecore.CreateComputerActionRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		action, err := s.manager.CreateComputerAction(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, action)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func isHTTPComputerActionStatus(status runtimecore.ComputerActionStatus) bool {
	switch status {
	case runtimecore.ComputerActionQueued, runtimecore.ComputerActionRunning, runtimecore.ComputerActionCompleted, runtimecore.ComputerActionFailed:
		return true
	default:
		return false
	}
}

func (s *Server) handleComputerActionClaim(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.ClaimComputerActionsRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	actions, err := s.manager.ClaimComputerActions(req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, actions)
}

func (s *Server) handleComputerActionByID(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/computer/actions/"), "/")
	if id == "" {
		writeError(w, http.StatusNotFound, "computer action not found")
		return
	}
	if r.Method != http.MethodPatch {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.UpdateComputerActionRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	action, err := s.manager.UpdateComputerAction(id, req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, action)
}

func (s *Server) handleEmulatorDevices(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListEmulatorDevices())
	case http.MethodPost:
		var req runtimecore.RegisterEmulatorDeviceRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		device, err := s.manager.RegisterEmulatorDevice(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, device)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleEmulatorDeviceByID(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/emulator/devices/"), "/")
	if id == "" {
		writeError(w, http.StatusNotFound, "emulator device not found")
		return
	}
	if r.Method != http.MethodPatch {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.UpdateEmulatorDeviceRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	device, err := s.manager.UpdateEmulatorDevice(id, req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, device)
}

func (s *Server) handleEmulatorSessions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListEmulatorSessions())
	case http.MethodPost:
		var req runtimecore.AttachEmulatorRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		session, err := s.manager.AttachEmulator(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, session)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleEmulatorSessionByID(w http.ResponseWriter, r *http.Request) {
	id, action := splitEmulatorSessionPath(r.URL.Path)
	if id == "" {
		writeError(w, http.StatusNotFound, "emulator session not found")
		return
	}
	if r.Method == http.MethodPost && action == "commands" {
		var req runtimecore.EmulatorCommandRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		computerAction, err := s.manager.QueueEmulatorCommand(id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, computerAction)
		return
	}
	if r.Method != http.MethodDelete || action != "" {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	session, err := s.manager.DetachEmulatorSession(id)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, session)
}

func (s *Server) handleSubsystem(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		writeJSON(w, http.StatusOK, s.manager.SubsystemStatus(name))
	}
}

func (s *Server) handleNativeProviders(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListNativeProviders(r.URL.Query().Get("subsystem")))
	case http.MethodPost:
		var req runtimecore.RegisterNativeProviderRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		provider, err := s.manager.RegisterNativeProvider(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, provider)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	topicFilter := strings.TrimSpace(r.URL.Query().Get("topic"))
	id, ch := s.manager.Subscribe(128)
	defer s.manager.Unsubscribe(id)
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	for {
		select {
		case <-r.Context().Done():
			return
		case event, ok := <-ch:
			if !ok {
				return
			}
			if topicFilter != "" && event.Topic != topicFilter {
				continue
			}
			content, err := json.Marshal(event)
			if err != nil {
				continue
			}
			_, _ = fmt.Fprintf(w, "id: %s\n", event.ID)
			_, _ = fmt.Fprintf(w, "event: %s\n", event.Topic)
			_, _ = fmt.Fprintf(w, "data: %s\n\n", content)
			flusher.Flush()
		}
	}
}

func splitSessionPath(path string) (string, string) {
	trimmed := strings.TrimPrefix(path, "/v1/sessions/")
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		return "", ""
	}
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], strings.Join(parts[1:], "/")
}

func splitBrowserTabPath(path string) (string, string) {
	trimmed := strings.TrimPrefix(path, "/v1/browser/tabs/")
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		return "", ""
	}
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], strings.Join(parts[1:], "/")
}

func splitBrowserDownloadPath(path string) (string, string) {
	trimmed := strings.TrimPrefix(path, "/v1/browser/downloads/")
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		return "", ""
	}
	if len(parts) == 3 && parts[1] == "commands" {
		return parts[0], "commands/" + parts[2]
	}
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], strings.Join(parts[1:], "/")
}

func splitEmulatorSessionPath(path string) (string, string) {
	trimmed := strings.TrimPrefix(path, "/v1/emulator/sessions/")
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		return "", ""
	}
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], strings.Join(parts[1:], "/")
}

func splitOrchestrationPath(path string, prefix string) (string, string) {
	trimmed := strings.TrimPrefix(path, prefix)
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		return "", ""
	}
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], strings.Join(parts[1:], "/")
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target interface{}) bool {
	defer r.Body.Close()
	// Runtime writes can carry file contents; cap JSON bodies without making file edits unusable.
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxJSONBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return false
	}
	var trailing interface{}
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "request body must contain a single JSON value")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeRuntimeError(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	if errors.Is(err, runtimecore.ErrNotFound) ||
		errors.Is(err, runtimecore.ErrSessionNotFound) ||
		errors.Is(err, runtimecore.ErrBranchNotFound) {
		status = http.StatusNotFound
	}
	writeError(w, status, err.Error())
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func bearerTokenFromHeader(value string) string {
	const prefix = "Bearer "
	if !strings.HasPrefix(value, prefix) {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(value, prefix))
}

func Start(ctx context.Context, listen string, manager *runtimecore.Manager) error {
	return StartWithOptions(ctx, listen, manager, ServerOptions{})
}

func StartWithOptions(ctx context.Context, listen string, manager *runtimecore.Manager, options ServerOptions) error {
	server := &http.Server{Addr: listen, Handler: NewServerWithOptions(manager, options)}
	errCh := make(chan error, 1)
	go func() {
		errCh <- server.ListenAndServe()
	}()
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
		return ctx.Err()
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}
