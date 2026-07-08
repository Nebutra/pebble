package runtimehttp

import (
	"net/http"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListRuntimeSettings(runtimecore.RuntimeSettingFilter{
			Scope:       runtimecore.RuntimeSettingScope(r.URL.Query().Get("scope")),
			ProjectID:   r.URL.Query().Get("projectId"),
			WorkspaceID: r.URL.Query().Get("workspaceId"),
			Key:         r.URL.Query().Get("key"),
		}))
	case http.MethodPost:
		var req runtimecore.SetRuntimeSettingRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		setting, err := s.manager.SetRuntimeSetting(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, setting)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleKeybindings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.manager.ListKeybindings(runtimecore.KeybindingFilter{
			Platform: r.URL.Query().Get("platform"),
			Context:  r.URL.Query().Get("context"),
			Command:  r.URL.Query().Get("command"),
		}))
	case http.MethodPost:
		var req runtimecore.SetKeybindingRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		keybinding, err := s.manager.SetKeybinding(req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, keybinding)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
