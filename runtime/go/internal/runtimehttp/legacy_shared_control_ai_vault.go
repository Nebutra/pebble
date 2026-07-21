package runtimehttp

import (
	"context"
	"encoding/json"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) runLegacySharedControlAiVaultMethod(ctx context.Context, method string, raw json.RawMessage) (interface{}, bool, error) {
	if method != "aiVault.listSessions" {
		return nil, false, nil
	}
	var request runtimecore.AiVaultListRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return nil, true, err
	}
	// Why: a paired runtime represents one execution host; host aggregation is
	// owned by the requesting desktop so a remote cannot recursively fan out.
	request.ExecutionHostScope = "local"
	return s.manager.ListAiVaultSessionsByScope(ctx, request), true, nil
}

func (s *Server) handleLegacySharedControlAiVault(ctx context.Context, conn *websocketConn, sharedKey *[32]byte, device runtimecore.LegacySharedControlDevice, request legacySharedControlRequest) {
	if device.Scope == "mobile" && !legacySharedControlMobileMethodAllowed(request.Method) {
		s.writeLegacySharedControlError(conn, sharedKey, request.ID, "forbidden", "Method is not available to mobile clients")
		return
	}
	result, _, err := s.runLegacySharedControlAiVaultMethod(ctx, request.Method, request.Params)
	if err != nil {
		s.writeLegacySharedControlError(conn, sharedKey, request.ID, "ai_vault_scan_failed", err.Error())
		return
	}
	_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, result, false)
}
