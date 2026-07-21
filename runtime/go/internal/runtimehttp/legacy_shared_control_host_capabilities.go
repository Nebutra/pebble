package runtimehttp

import (
	"encoding/json"
	"errors"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/hostprobe"
	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) runLegacySharedControlHostCapabilityMethod(method string, raw json.RawMessage) (interface{}, bool, error) {
	switch method {
	case "provider.list", "providers.list", "nativeProvider.list":
		var params struct {
			Subsystem string `json:"subsystem"`
		}
		if json.Unmarshal(raw, &params) != nil {
			return nil, true, errors.New("invalid provider list parameters")
		}
		return map[string]interface{}{"providers": s.manager.ListNativeProviders(params.Subsystem)}, true, nil
	case "provider.status", "subsystem.status":
		var params struct {
			Subsystem string `json:"subsystem"`
			Name      string `json:"name"`
		}
		if json.Unmarshal(raw, &params) != nil {
			return nil, true, errors.New("invalid subsystem status parameters")
		}
		name := firstNonEmpty(strings.TrimSpace(params.Subsystem), strings.TrimSpace(params.Name))
		if name == "" {
			return nil, true, errors.New("subsystem name is required")
		}
		return map[string]interface{}{"status": s.manager.SubsystemStatus(name)}, true, nil
	case "provider.register", "nativeProvider.register":
		var params runtimecore.RegisterNativeProviderRequest
		if json.Unmarshal(raw, &params) != nil {
			return nil, true, errors.New("invalid native provider parameters")
		}
		provider, err := s.manager.RegisterNativeProvider(params)
		return map[string]interface{}{"provider": provider}, true, err
	}
	capabilities := hostprobe.NewProber().Detect()
	switch method {
	case "preflight.detectWindowsTerminalCapabilities":
		// Why: paired desktop clients must inspect the runtime host selected by
		// connectionId, never substitute capabilities from the local shell host.
		return capabilities, true, nil
	case "host.platform":
		return map[string]interface{}{"platform": capabilities.HostPlatform}, true, nil
	case "host.wsl.isAvailable":
		return capabilities.WSLAvailable, true, nil
	case "host.wsl.listDistros":
		return capabilities.WSLDistros, true, nil
	case "host.pwsh.isAvailable":
		return capabilities.PwshAvailable, true, nil
	case "host.gitBash.isAvailable":
		return capabilities.GitBashAvailable, true, nil
	default:
		return nil, false, nil
	}
}
