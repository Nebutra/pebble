package runtimehttp

import (
	"net/http"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) handleNotificationDispatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var event runtimecore.NotificationEvent
	if !decodeJSON(w, r, &event) {
		return
	}
	if err := s.manager.PublishNotification(event); err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"published": true})
}
