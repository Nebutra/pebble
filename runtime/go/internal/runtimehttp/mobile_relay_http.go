package runtimehttp

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) handleMobileRelay(w http.ResponseWriter, r *http.Request) {
	if isWebSocketUpgrade(r) {
		s.handleMobileRelaySocket(w, r)
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.MobileRelayStatus())
}

func (s *Server) handleMobileRelayStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.MobileRelayStatus())
}

func (s *Server) handleMobileRelayPairingCodes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req runtimecore.CreateMobileRelayPairingCodeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	code, err := s.manager.CreateMobileRelayPairingCode(req)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, code)
}

func (s *Server) handleMobileRelayPairings(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.ListMobileRelayPairings())
}

func (s *Server) handleMobileRelayPairingByDeviceID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	deviceID := strings.TrimPrefix(r.URL.Path, "/v1/mobile-relay/pairings/")
	if deviceID == "" || strings.Contains(deviceID, "/") {
		writeError(w, http.StatusBadRequest, "device id is required")
		return
	}
	revoked, err := s.manager.DeleteMobileRelayPairing(deviceID)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"revoked": revoked})
}

func (s *Server) handleMobileRelayProjection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	kinds := projectionKindsFromRequest(r)
	writeJSON(w, http.StatusOK, s.manager.MobileRelaySnapshot(kinds, projectionOutputLimitFromRequest(r)))
}

func projectionKindsFromRequest(r *http.Request) []runtimecore.ProjectionKind {
	values := r.URL.Query()["projection"]
	if raw := strings.TrimSpace(r.URL.Query().Get("projections")); raw != "" {
		values = append(values, strings.Split(raw, ",")...)
	}
	kinds := make([]runtimecore.ProjectionKind, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		kinds = append(kinds, runtimecore.ProjectionKind(value))
	}
	return runtimecore.NormalizeMobileProjectionKinds(kinds)
}

func projectionOutputLimitFromRequest(r *http.Request) int {
	raw := strings.TrimSpace(r.URL.Query().Get("outputLimit"))
	if raw == "" {
		return 200
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit <= 0 {
		return 200
	}
	return limit
}
