package runtimehttp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

const legacyEmulatorActionTimeout = 30 * time.Second

const (
	legacyEmulatorExecMaxPayloadBytes = 32 * 1024
	legacyEmulatorExecMaxArgCount     = 64
	legacyEmulatorExecMaxArgBytes     = 4 * 1024
	legacyEmulatorExecMaxArgvBytes    = 16 * 1024
	legacyEmulatorExecDefaultTimeout  = 10_000
	legacyEmulatorExecMinTimeout      = 100
	legacyEmulatorExecMaxTimeout      = 30_000
)

func (s *Server) runLegacySharedControlEmulatorMethod(ctx context.Context, method string, raw json.RawMessage) (interface{}, bool, error) {
	if !strings.HasPrefix(method, "emulator.") {
		return nil, false, nil
	}
	if method == "emulator.exec" && len(raw) > legacyEmulatorExecMaxPayloadBytes {
		return nil, true, errors.New("emulator.exec parameters exceed the 32 KiB limit")
	}
	var params map[string]interface{}
	if len(raw) > 0 && json.Unmarshal(raw, &params) != nil {
		return nil, true, errors.New("invalid emulator parameters")
	}
	if params == nil {
		params = map[string]interface{}{}
	}
	switch method {
	case "emulator.list":
		return s.manager.ListEmulatorSessions(), true, nil
	case "emulator.listDevices":
		return s.manager.ListEmulatorDevices(), true, nil
	case "emulator.listSimulators":
		devices := s.manager.ListEmulatorDevices()
		result := make([]runtimecore.EmulatorDevice, 0, len(devices))
		for _, device := range devices {
			if device.Platform == "ios" {
				result = append(result, device)
			}
		}
		return result, true, nil
	case "emulator.availability":
		devices := s.manager.ListEmulatorDevices()
		return map[string]interface{}{"available": len(devices) > 0, "devices": devices}, true, nil
	case "emulator.attach":
		deviceID := firstNonEmpty(mapString(params, "device"), mapString(params, "emulator"))
		if deviceID == "" {
			devices := s.manager.ListEmulatorDevices()
			if len(devices) > 0 {
				deviceID = devices[0].ID
			}
		}
		if deviceID == "" {
			return nil, true, errors.New("no emulator device is available")
		}
		session, err := s.manager.AttachEmulator(runtimecore.AttachEmulatorRequest{
			DeviceID: deviceID, WorktreeID: mapString(params, "worktree"),
		})
		return map[string]interface{}{"attached": err == nil, "info": session}, true, err
	case "emulator.tap", "emulator.gesture", "emulator.type", "emulator.button",
		"emulator.rotate", "emulator.install", "emulator.launch", "emulator.logcat", "emulator.ax", "emulator.exec":
		if method == "emulator.exec" {
			if err := validateLegacyEmulatorExec(raw, params); err != nil {
				return nil, true, err
			}
		}
		session, err := s.resolveLegacySharedControlEmulatorSession(params)
		if err != nil {
			return nil, true, err
		}
		command := strings.TrimPrefix(method, "emulator.")
		switch command {
		case "gesture":
			command = "gesture"
		case "button":
			command = "button"
		case "logcat":
			command = "logs"
		}
		action, err := s.manager.QueueEmulatorCommand(session.ID, runtimecore.EmulatorCommandRequest{
			Command: command, Payload: params,
		})
		if err != nil {
			return nil, true, err
		}
		result, err := s.waitLegacyEmulatorAction(ctx, action.ID)
		return result, true, err
	default:
		return nil, true, errors.New("emulator method is not supported by the native provider")
	}
}

type legacyEmulatorExecParams struct {
	Argv      []string `json:"argv"`
	TimeoutMs *int     `json:"timeoutMs"`
}

func validateLegacyEmulatorExec(raw json.RawMessage, params map[string]interface{}) error {
	var input legacyEmulatorExecParams
	if json.Unmarshal(raw, &input) != nil {
		return errors.New("invalid emulator.exec parameters")
	}
	if len(input.Argv) == 0 || len(input.Argv) > legacyEmulatorExecMaxArgCount {
		return errors.New("emulator.exec argv must contain 1 to 64 arguments")
	}
	totalBytes := 0
	for index, argument := range input.Argv {
		if strings.IndexByte(argument, 0) >= 0 {
			return errors.New("emulator.exec argv entries must not contain NUL bytes")
		}
		if len(argument) > legacyEmulatorExecMaxArgBytes {
			return errors.New("emulator.exec argv entries must not exceed 4096 bytes")
		}
		totalBytes += len(argument)
		if totalBytes > legacyEmulatorExecMaxArgvBytes {
			return errors.New("emulator.exec argv must not exceed 16384 bytes")
		}
		if index == 0 && argument == "" {
			return errors.New("emulator.exec argv[0] must name a device command")
		}
	}
	timeoutMs := legacyEmulatorExecDefaultTimeout
	if input.TimeoutMs != nil {
		timeoutMs = *input.TimeoutMs
	}
	if timeoutMs < legacyEmulatorExecMinTimeout || timeoutMs > legacyEmulatorExecMaxTimeout {
		return errors.New("emulator.exec timeoutMs must be an integer from 100 to 30000")
	}
	// Why: normalize the default into the queued action so the native provider
	// executes the exact bounded contract validated at this trust boundary.
	params["timeoutMs"] = timeoutMs
	return nil
}

func (s *Server) resolveLegacySharedControlEmulatorSession(params map[string]interface{}) (runtimecore.EmulatorSession, error) {
	sessionSelector := mapString(params, "emulator")
	deviceSelector := mapString(params, "device")
	worktreeSelector := mapString(params, "worktree")
	for _, session := range s.manager.ListEmulatorSessions() {
		if !session.Active {
			continue
		}
		if (sessionSelector != "" && session.ID == sessionSelector) ||
			deviceSelector != "" && session.DeviceID == deviceSelector ||
			worktreeSelector != "" && session.WorktreeID == worktreeSelector ||
			sessionSelector == "" && deviceSelector == "" && worktreeSelector == "" {
			return session, nil
		}
	}
	return runtimecore.EmulatorSession{}, errors.New("no matching active emulator session")
}

func (s *Server) waitLegacyEmulatorAction(parent context.Context, actionID string) (interface{}, error) {
	ctx, cancel := context.WithTimeout(parent, legacyEmulatorActionTimeout)
	defer cancel()
	for {
		action, err := s.manager.GetComputerAction(actionID)
		if err != nil {
			return nil, err
		}
		switch action.Status {
		case runtimecore.ComputerActionCompleted:
			if len(action.Result) == 0 {
				return map[string]bool{"ok": true}, nil
			}
			return action.Result, nil
		case runtimecore.ComputerActionFailed:
			return nil, errors.New(firstNonEmpty(action.Error, "emulator command failed"))
		}
		select {
		case <-ctx.Done():
			s.cancelLegacyEmulatorAction(actionID, ctx.Err())
			return nil, ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}

func (s *Server) cancelLegacyEmulatorAction(actionID string, cause error) {
	action, err := s.manager.GetComputerAction(actionID)
	if err != nil || action.Status == runtimecore.ComputerActionCompleted || action.Status == runtimecore.ComputerActionFailed {
		return
	}
	_, _ = s.manager.UpdateComputerAction(actionID, runtimecore.UpdateComputerActionRequest{
		Status: runtimecore.ComputerActionFailed,
		Error:  "emulator command canceled: " + cause.Error(),
	})
}

func mapString(values map[string]interface{}, key string) string {
	value, _ := values[key].(string)
	return strings.TrimSpace(value)
}
