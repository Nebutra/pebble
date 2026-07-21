package runtimehttp

import (
	"encoding/json"
	"errors"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) runLegacySharedControlOrchestrationMethod(method string, raw json.RawMessage) (interface{}, bool, error) {
	if method != "orchestration.dispatchShow" {
		return nil, false, nil
	}
	var params struct {
		Task     string `json:"task"`
		Preamble bool   `json:"preamble"`
		From     string `json:"from"`
		DevMode  bool   `json:"devMode"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, true, err
	}
	params.Task = strings.TrimSpace(params.Task)
	if params.Task == "" {
		return nil, true, errors.New("task is required")
	}
	dispatches := s.manager.ListDispatches(params.Task)
	if params.Preamble {
		preamble, err := s.manager.PreviewDispatchPreamble(params.Task, params.From, params.DevMode)
		if err != nil {
			return nil, true, err
		}
		var dispatch interface{}
		if len(dispatches) > 0 {
			dispatch = legacySharedControlDispatchContext(dispatches[len(dispatches)-1])
		}
		return map[string]interface{}{"dispatch": dispatch, "preamble": preamble}, true, nil
	}
	if len(dispatches) == 0 {
		return map[string]interface{}{"dispatch": nil}, true, nil
	}
	return map[string]interface{}{
		"dispatch": legacySharedControlDispatchContext(dispatches[len(dispatches)-1]),
	}, true, nil
}

func legacySharedControlDispatchContext(dispatch runtimecore.Dispatch) map[string]interface{} {
	handle := strings.TrimSpace(dispatch.SessionID)
	if handle == "" {
		handle = strings.TrimSpace(dispatch.Assignee)
	}
	return map[string]interface{}{
		"id":              dispatch.ID,
		"task_id":         dispatch.TaskID,
		"assignee":        dispatch.Assignee,
		"assignee_handle": handle,
		"status":          dispatch.Status,
		"created_at":      dispatch.CreatedAt,
		"updated_at":      dispatch.UpdatedAt,
	}
}
