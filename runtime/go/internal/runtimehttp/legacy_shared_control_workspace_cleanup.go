package runtimehttp

import (
	"context"
	"encoding/json"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) runLegacySharedControlWorkspaceCleanupMethod(ctx context.Context, method string, raw json.RawMessage) (interface{}, bool, error) {
	switch method {
	case "workspaceCleanup.scan":
		var request runtimecore.WorkspaceCleanupScanRequest
		if err := json.Unmarshal(raw, &request); err != nil {
			return nil, true, err
		}
		return s.manager.ScanWorkspaceCleanup(ctx, request), true, nil
	case "workspaceCleanup.processes":
		var request runtimecore.WorkspaceCleanupLocalProcessRequest
		if err := json.Unmarshal(raw, &request); err != nil {
			return nil, true, err
		}
		// Why: this handler already runs on the workspace host; forwarding the
		// desktop connection id would incorrectly classify the local PTY as remote.
		request.ConnectionID = nil
		return s.manager.HasWorkspaceCleanupProcesses(request), true, nil
	default:
		return nil, false, nil
	}
}

func (s *Server) handleLegacySharedControlWorkspaceCleanup(ctx context.Context, conn *websocketConn, sharedKey *[32]byte, device runtimecore.LegacySharedControlDevice, request legacySharedControlRequest) {
	if device.Scope == "mobile" && !legacySharedControlMobileMethodAllowed(request.Method) {
		s.writeLegacySharedControlError(conn, sharedKey, request.ID, "forbidden", "Method is not available to mobile clients")
		return
	}
	result, _, err := s.runLegacySharedControlWorkspaceCleanupMethod(ctx, request.Method, request.Params)
	if err != nil {
		s.writeLegacySharedControlError(conn, sharedKey, request.ID, "workspace_cleanup_failed", err.Error())
		return
	}
	_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, result, false)
}
