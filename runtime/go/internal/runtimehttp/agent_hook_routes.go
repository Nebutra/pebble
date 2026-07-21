package runtimehttp

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

// handleAgentHookIngest accepts the form-encoded POSTs that the managed agent
// hook scripts already emit against Electron's loopback listener (see
// migration/electron-reference/src/main/agent-hooks): /hook/{source} with an X-Pebble-Agent-Hook-Token
// header. Pointing PEBBLE_AGENT_HOOK_PORT at the Go runtime is the whole
// Tauri-side transport — the scripts themselves stay unchanged.
func (s *Server) handleAgentHookIngest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.authorizeAgentHook(r) {
		writeError(w, http.StatusUnauthorized, "missing or invalid agent hook token")
		return
	}
	source := strings.Trim(strings.TrimPrefix(r.URL.Path, "/hook/"), "/")
	if source == "" {
		writeError(w, http.StatusNotFound, "hook source is required")
		return
	}
	// Hook posts are small form bodies; cap them like JSON bodies.
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodyBytes)
	if err := r.ParseForm(); err != nil {
		writeError(w, http.StatusBadRequest, "invalid form body")
		return
	}
	result := s.manager.IngestAgentHookEvent(runtimecore.AgentHookIngestRequest{
		Source:      source,
		PaneKey:     r.PostFormValue("paneKey"),
		TabID:       r.PostFormValue("tabId"),
		LaunchToken: r.PostFormValue("launchToken"),
		Payload:     r.PostFormValue("payload"),
	})
	// Always 200: hook scripts are fire-and-forget and must never surface
	// transport failures into the agent's own hook execution.
	writeJSON(w, http.StatusOK, result)
}

// authorizeAgentHook mirrors Electron's hook-token check: the scripts send
// X-Pebble-Agent-Hook-Token (not a bearer header), so the ingest route owns
// its own auth instead of the server-wide bearer gate.
func (s *Server) authorizeAgentHook(r *http.Request) bool {
	if s.hookToken == "" {
		return true
	}
	token := strings.TrimSpace(r.Header.Get("X-Pebble-Agent-Hook-Token"))
	if token == "" || len(token) != len(s.hookToken) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(s.hookToken)) == 1
}
