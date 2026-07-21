package runtimehttp

import (
	"encoding/json"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) runLegacySharedControlAgentTrustMethod(method string, raw json.RawMessage) (interface{}, bool, error) {
	if method != "agentTrust.markTrusted" {
		return nil, false, nil
	}
	var request runtimecore.AgentTrustRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return nil, true, err
	}
	if err := s.manager.MarkAgentWorkspaceTrusted(request); err != nil {
		return nil, true, err
	}
	return map[string]bool{"trusted": true}, true, nil
}
