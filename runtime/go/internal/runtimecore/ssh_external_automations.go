package runtimecore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const sshExternalAutomationTimeout = 45 * time.Second

type SshExternalAutomationRequest struct {
	Version   int    `json:"version"`
	Operation string `json:"operation"`
	Provider  string `json:"provider"`
	JobID     string `json:"jobId,omitempty"`
	Action    string `json:"action,omitempty"`
	Name      string `json:"name,omitempty"`
	Prompt    string `json:"prompt,omitempty"`
	Schedule  string `json:"schedule,omitempty"`
	Workdir   string `json:"workdir,omitempty"`
	Page      int    `json:"page,omitempty"`
	PageSize  int    `json:"pageSize,omitempty"`
}

func (m *Manager) RunSshExternalAutomation(ctx context.Context, targetID string, request SshExternalAutomationRequest) (any, error) {
	target, ok := m.GetSshTarget(targetID)
	if !ok {
		return nil, ErrNotFound
	}
	if request.Version != 1 {
		return nil, errors.New("unsupported external automation request version")
	}
	if request.Provider != "hermes" && request.Provider != "openclaw" {
		return nil, errors.New("unsupported external automation provider")
	}
	if request.Operation != "list" && request.Operation != "runs" && request.Operation != "create" && request.Operation != "update" && request.Operation != "action" {
		return nil, errors.New("unsupported external automation operation")
	}
	sshPath, found := findSystemSshBinary()
	if !found {
		return nil, errors.New("system ssh binary not found")
	}
	commandContext, cancel := context.WithTimeout(ctx, sshExternalAutomationTimeout)
	defer cancel()
	deployment, err := m.deploySshRelayWorker(commandContext, sshPath, targetID, target)
	if err != nil {
		return nil, err
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	command := remoteWorkerCommand(deployment, []string{"external-automations", "--request", string(payload)})
	output, err := m.runPurposeScopedSsh(commandContext, sshPath, targetID, target, command, nil)
	if commandContext.Err() == context.DeadlineExceeded {
		return nil, errors.New("remote external automation request timed out")
	}
	if err != nil {
		detail := strings.TrimSpace(output)
		if detail == "" {
			detail = err.Error()
		}
		return nil, fmt.Errorf("remote external automation request failed: %s", detail)
	}
	var result any
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		return nil, errors.New("remote external automation response was not valid JSON")
	}
	return result, nil
}
