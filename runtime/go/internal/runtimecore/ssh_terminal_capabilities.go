package runtimecore

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/nebutra/pebble/runtime/go/internal/hostprobe"
)

// DetectSshTerminalCapabilities runs on the selected SSH host. The relay
// command is read-only and cannot be redirected to an arbitrary shell command.
func (m *Manager) DetectSshTerminalCapabilities(ctx context.Context, targetID string) (hostprobe.TerminalCapabilities, error) {
	output, err := m.runSshRelayWorker(ctx, targetID, []string{"terminal-capabilities-json"})
	if err != nil {
		return hostprobe.TerminalCapabilities{}, err
	}
	var capabilities hostprobe.TerminalCapabilities
	if err := json.Unmarshal(output, &capabilities); err != nil {
		return hostprobe.TerminalCapabilities{}, errors.New("relay worker returned malformed terminal capabilities")
	}
	if capabilities.WSLDistros == nil {
		capabilities.WSLDistros = []string{}
	}
	return capabilities, nil
}
