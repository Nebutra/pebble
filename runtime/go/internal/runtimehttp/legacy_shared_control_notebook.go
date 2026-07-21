package runtimehttp

import (
	"context"
	"encoding/json"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) runLegacySharedControlNotebookMethod(ctx context.Context, method string, raw json.RawMessage) (interface{}, bool, error) {
	if method != "notebook.runPythonCell" {
		return nil, false, nil
	}
	var request runtimecore.NotebookRunPythonCellRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return nil, true, err
	}
	// Why: the encrypted RPC is already executing on the workspace host; a
	// forwarded connection id would incorrectly send the request back remote.
	request.ConnectionID = nil
	result, err := s.manager.RunNotebookPythonCell(ctx, request)
	return result, true, err
}

func (s *Server) handleLegacySharedControlNotebook(ctx context.Context, conn *websocketConn, sharedKey *[32]byte, device runtimecore.LegacySharedControlDevice, request legacySharedControlRequest) {
	if device.Scope == "mobile" && !legacySharedControlMobileMethodAllowed(request.Method) {
		s.writeLegacySharedControlError(conn, sharedKey, request.ID, "forbidden", "Method is not available to mobile clients")
		return
	}
	result, _, err := s.runLegacySharedControlNotebookMethod(ctx, request.Method, request.Params)
	if err != nil {
		s.writeLegacySharedControlError(conn, sharedKey, request.ID, "notebook_execution_failed", err.Error())
		return
	}
	_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, result, false)
}
