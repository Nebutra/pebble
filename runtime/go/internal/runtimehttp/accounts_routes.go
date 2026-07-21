package runtimehttp

import (
	"net/http"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) handleAccountsSnapshot(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		snapshot := s.manager.GetAccountsSnapshot()
		if len(snapshot) == 0 {
			writeJSON(w, http.StatusOK, map[string]interface{}{})
			return
		}
		writeJSON(w, http.StatusOK, snapshot)
	case http.MethodPut:
		var request runtimecore.AccountsSnapshot
		if !decodeJSON(w, r, &request) {
			return
		}
		snapshot, err := s.manager.SetAccountsSnapshot(request)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, snapshot)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
