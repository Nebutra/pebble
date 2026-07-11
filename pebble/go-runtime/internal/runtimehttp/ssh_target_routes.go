package runtimehttp

import (
	"net/http"
	"strings"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

func (s *Server) handleSshTargets(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListSshTargets())
	case http.MethodPost:
		var req runtimecore.SshTargetInput
		if !decodeJSON(w, r, &req) {
			return
		}
		target, err := s.manager.CreateSshTarget(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, target)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleSshTargetImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	targets, err := s.manager.ImportSshTargetsFromConfig()
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, targets)
}

func (s *Server) handleSshTargetByID(w http.ResponseWriter, r *http.Request) {
	id, action := splitSshTargetPath(r.URL.Path)
	if id == "" {
		writeError(w, http.StatusNotFound, "ssh target not found")
		return
	}
	switch {
	case r.Method == http.MethodPatch && action == "":
		var req runtimecore.SshTargetUpdate
		if !decodeJSON(w, r, &req) {
			return
		}
		target, err := s.manager.UpdateSshTarget(id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, target)
	case r.Method == http.MethodDelete && action == "":
		target, err := s.manager.DeleteSshTarget(id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, target)
	case action == "credential":
		s.handleSshTargetCredential(w, r, id)
	case r.Method == http.MethodPost && action == "probe":
		result, err := s.manager.ProbeSshTarget(r.Context(), id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	case r.Method == http.MethodPost && action == "agent-hooks/bootstrap":
		var req runtimecore.SshAgentHookBootstrapRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		result, err := s.manager.BootstrapSshAgentHooks(r.Context(), id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	case r.Method == http.MethodPost && action == "external-automations":
		var req runtimecore.SshExternalAutomationRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		result, err := s.manager.RunSshExternalAutomation(r.Context(), id, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	case r.Method == http.MethodPost && action == "sessions/terminate":
		result, err := s.manager.TerminateSshTargetSessions(id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	case r.Method == http.MethodGet && action == "ports/detected":
		ports, err := s.manager.DetectSshPorts(r.Context(), id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, ports)
	case r.Method == http.MethodPost && action == "browse":
		var input struct {
			Path string `json:"path"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		result, err := s.manager.BrowseSshDirectory(r.Context(), id, input.Path)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	case action == "port-forwards":
		s.handleSshPortForwards(w, r, id)
	case r.Method == http.MethodPost && action == "port-forwards/restore":
		entries, err := s.manager.RestoreSshPortForwards(r.Context(), id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, entries)
	case r.Method == http.MethodPost && action == "port-forwards/terminate":
		ids, err := s.manager.TerminateSshPortForwards(id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"targetId": id, "terminatedIds": ids})
	case strings.HasPrefix(action, "port-forwards/"):
		s.handleSshPortForwardByID(w, r, id, strings.TrimPrefix(action, "port-forwards/"))
	case r.Method == http.MethodPost && action == "git-text-generation-context":
		s.handleSshGitTextGenerationContext(w, r, id)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// sshGitTextGenerationContextRequest is the desktop-authored request body for
// fetching source-control text-generation context from an SSH-remote host.
// Kind selects which of the two local Rust commands' shapes to mirror.
type sshGitTextGenerationContextRequest struct {
	Kind         string `json:"kind"`
	RepoRoot     string `json:"repoRoot"`
	Base         string `json:"base,omitempty"`
	CurrentTitle string `json:"currentTitle,omitempty"`
	CurrentBody  string `json:"currentBody,omitempty"`
	CurrentDraft bool   `json:"currentDraft,omitempty"`
}

// handleSshGitTextGenerationContext fetches staged-diff (commit) or
// base-vs-head diff/log (pull-request) context from an SSH-remote host so the
// desktop can build the same commit-message/PR-field prompt it builds for
// local projects, sourced from the remote git checkout via the relay worker.
func (s *Server) handleSshGitTextGenerationContext(w http.ResponseWriter, r *http.Request, id string) {
	var req sshGitTextGenerationContextRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.RepoRoot) == "" {
		writeError(w, http.StatusBadRequest, "repoRoot is required")
		return
	}
	switch req.Kind {
	case "commit":
		result, err := s.manager.FetchSshGitCommitTextGenerationContext(r.Context(), id, req.RepoRoot)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	case "pull-request":
		result, err := s.manager.FetchSshGitPullRequestTextGenerationContext(
			r.Context(), id, req.RepoRoot, req.Base, req.CurrentTitle, req.CurrentBody, req.CurrentDraft,
		)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	default:
		writeError(w, http.StatusBadRequest, "kind must be \"commit\" or \"pull-request\"")
	}
}

func (s *Server) handleSshPortForwards(w http.ResponseWriter, r *http.Request, targetID string) {
	switch r.Method {
	case http.MethodGet:
		entries, err := s.manager.ListSshPortForwards(targetID)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, entries)
	case http.MethodPost:
		var input runtimecore.SshPortForwardInput
		if !decodeJSON(w, r, &input) {
			return
		}
		entry, err := s.manager.AddSshPortForward(r.Context(), targetID, input)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, entry)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleSshPortForwardByID(w http.ResponseWriter, r *http.Request, targetID, forwardID string) {
	if strings.TrimSpace(forwardID) == "" || strings.Contains(forwardID, "/") {
		writeError(w, http.StatusNotFound, "SSH port forward not found")
		return
	}
	switch r.Method {
	case http.MethodPatch:
		var input runtimecore.SshPortForwardInput
		if !decodeJSON(w, r, &input) {
			return
		}
		entry, err := s.manager.UpdateSshPortForward(r.Context(), targetID, forwardID, input)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, entry)
	case http.MethodDelete:
		entry, err := s.manager.RemoveSshPortForward(targetID, forwardID)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, entry)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// handleSshTargetCredential seeds/clears/reads the memory-only relay credential
// cache. Responses only ever carry booleans — the secret value is never echoed,
// logged, or persisted (see runtimecore/ssh_credential_cache.go).
func (s *Server) handleSshTargetCredential(w http.ResponseWriter, r *http.Request, id string) {
	switch r.Method {
	case http.MethodGet:
		status, err := s.manager.SshCredentialStatus(id)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, status)
	case http.MethodPost:
		var req struct {
			Kind  string `json:"kind"`
			Value string `json:"value"`
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		if req.Kind != runtimecore.SshCredentialKindPassphrase && req.Kind != runtimecore.SshCredentialKindPassword {
			writeError(w, http.StatusBadRequest, "credential kind must be passphrase or password")
			return
		}
		if req.Value == "" {
			writeError(w, http.StatusBadRequest, "credential value is required")
			return
		}
		status, err := s.manager.SeedSshCredential(id, req.Kind, req.Value)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, status)
	case http.MethodDelete:
		writeJSON(w, http.StatusOK, s.manager.ClearSshCredential(id))
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func splitSshTargetPath(path string) (string, string) {
	trimmed := strings.TrimPrefix(path, "/v1/ssh-targets/")
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		return "", ""
	}
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], strings.Join(parts[1:], "/")
}
