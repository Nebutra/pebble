package runtimecore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const (
	sshAgentHookBootstrapTimeout = 45 * time.Second
	maxAgentHookBootstrapBytes   = 2 << 20
	maxAgentHookBootstrapOutput  = 64 << 10
)

type SshAgentHookBootstrapRequest struct {
	Version int    `json:"version"`
	Script  string `json:"script"`
}

type SshAgentHookBootstrapResult struct {
	Success  bool                        `json:"success"`
	Status   string                      `json:"status"`
	Output   string                      `json:"output,omitempty"`
	Error    string                      `json:"error,omitempty"`
	Statuses []SshAgentHookInstallStatus `json:"statuses,omitempty"`
}

type SshAgentHookInstallStatus struct {
	Agent               string `json:"agent"`
	State               string `json:"state"`
	ConfigPath          string `json:"configPath"`
	ManagedHooksPresent bool   `json:"managedHooksPresent"`
	Detail              string `json:"detail,omitempty"`
}

// BootstrapSshAgentHooks executes only the versioned managed-hook bootstrap
// channel. Keeping this purpose-scoped avoids turning the runtime HTTP API into
// a general remote shell while still replacing Electron's SFTP mutation path.
func (m *Manager) BootstrapSshAgentHooks(ctx context.Context, id string, req SshAgentHookBootstrapRequest) (SshAgentHookBootstrapResult, error) {
	target, ok := m.GetSshTarget(id)
	if !ok {
		return SshAgentHookBootstrapResult{}, ErrNotFound
	}
	if req.Version != 1 {
		return SshAgentHookBootstrapResult{}, errors.New("unsupported agent-hook bootstrap version")
	}
	if strings.TrimSpace(req.Script) == "" {
		return SshAgentHookBootstrapResult{}, errors.New("agent-hook bootstrap script is required")
	}
	if len(req.Script) > maxAgentHookBootstrapBytes {
		return SshAgentHookBootstrapResult{}, errors.New("agent-hook bootstrap exceeds size limit")
	}
	sshPath, found := findSystemSshBinary()
	if !found {
		return SshAgentHookBootstrapResult{Status: "error", Error: "system ssh binary not found"}, nil
	}
	commandCtx, cancel := context.WithTimeout(ctx, sshAgentHookBootstrapTimeout)
	defer cancel()
	deployment, deploymentError := m.deploySshRelayWorker(commandCtx, sshPath, id, target)
	if deploymentError != nil {
		return SshAgentHookBootstrapResult{Status: "error", Error: deploymentError.Error()}, nil
	}
	if deployment.platform.goos == "windows" {
		return m.bootstrapWindowsSshAgentHooks(commandCtx, sshPath, id, target, deployment.path)
	}
	if deployment.path != "" {
		req.Script = "export PEBBLE_RELAY_WORKER=" + quotePosixShell(deployment.path) + "\n" + req.Script
	}
	args := sshCommandArgs(target, "sh -s -- pebble-agent-hooks-v1")
	cmd := exec.CommandContext(commandCtx, sshPath, args...)
	cmd.Stdin = strings.NewReader(req.Script)
	var output cappedBuffer
	output.limit = maxAgentHookBootstrapOutput
	cmd.Stdout = &output
	cmd.Stderr = &output
	cleanup, err := configureSshAskpass(cmd, m, id)
	if err != nil {
		return SshAgentHookBootstrapResult{}, err
	}
	defer cleanup()
	err = cmd.Run()
	if commandCtx.Err() == context.DeadlineExceeded {
		return SshAgentHookBootstrapResult{Status: "error", Error: "agent-hook bootstrap timed out", Output: output.String()}, nil
	}
	if err != nil {
		detail := strings.TrimSpace(output.String())
		if detail == "" {
			detail = err.Error()
		}
		return SshAgentHookBootstrapResult{Status: sshProbeErrorStatus(detail), Error: detail, Output: output.String()}, nil
	}
	return SshAgentHookBootstrapResult{Success: true, Status: "installed", Output: output.String()}, nil
}

func (m *Manager) bootstrapWindowsSshAgentHooks(ctx context.Context, sshPath, targetID string, target SshTarget, workerPath string) (SshAgentHookBootstrapResult, error) {
	if !isWindowsAbsolutePath(workerPath) {
		return SshAgentHookBootstrapResult{Status: "error", Error: "Windows relay worker path is invalid"}, nil
	}
	command := windowsPowerShellCommand("& " + quotePowerShellLiteral(workerPath) + " agent-hooks-install --home $env:USERPROFILE")
	output, err := m.runPurposeScopedSsh(ctx, sshPath, targetID, target, command, nil)
	if ctx.Err() == context.DeadlineExceeded {
		return SshAgentHookBootstrapResult{Status: "error", Error: "agent-hook bootstrap timed out", Output: output}, nil
	}
	if err != nil {
		detail := strings.TrimSpace(output)
		if detail == "" {
			detail = err.Error()
		}
		return SshAgentHookBootstrapResult{Status: sshProbeErrorStatus(detail), Error: detail, Output: output}, nil
	}
	var envelope struct {
		Version  int                         `json:"version"`
		Statuses []SshAgentHookInstallStatus `json:"statuses"`
	}
	if decodeErr := json.Unmarshal([]byte(strings.TrimSpace(output)), &envelope); decodeErr != nil || envelope.Version != 1 || len(envelope.Statuses) != 14 {
		return SshAgentHookBootstrapResult{Status: "error", Error: "Windows agent-hook installer returned an invalid status envelope", Output: output}, nil
	}
	overall, success := summarizeAgentHookStatuses(envelope.Statuses)
	return SshAgentHookBootstrapResult{Success: success, Status: overall, Output: output, Statuses: envelope.Statuses}, nil
}

func summarizeAgentHookStatuses(statuses []SshAgentHookInstallStatus) (string, bool) {
	installed := 0
	unsupported := 0
	for _, status := range statuses {
		switch status.State {
		case "installed":
			installed++
		case "unsupported":
			unsupported++
		case "partial", "error", "not_installed":
		default:
			return "error", false
		}
	}
	if installed == len(statuses) {
		return "installed", true
	}
	if unsupported == len(statuses) {
		return "unsupported", false
	}
	return "partial", installed > 0
}

func sshCommandArgs(target SshTarget, remoteCommand string) []string {
	return append(sshTargetArgs(target), remoteCommand)
}

func sshTargetArgs(target SshTarget) []string {
	args := []string{"-o", "ConnectTimeout=12", "-o", "StrictHostKeyChecking=accept-new", "-o", "NumberOfPasswordPrompts=1"}
	if target.Port != 0 && target.Port != 22 {
		args = append(args, "-p", strconv.Itoa(target.Port))
	}
	if target.IdentityFile != "" {
		args = append(args, "-i", target.IdentityFile)
		if target.IdentitiesOnly == nil || *target.IdentitiesOnly {
			args = append(args, "-o", "IdentitiesOnly=yes")
		}
	}
	if target.IdentityAgent != "" {
		args = append(args, "-o", "IdentityAgent="+target.IdentityAgent)
	}
	if target.ProxyCommand != "" {
		args = append(args, "-o", "ProxyCommand="+target.ProxyCommand)
	}
	if target.JumpHost != "" {
		args = append(args, "-J", target.JumpHost)
	}
	destination := target.Host
	if target.ConfigHost != "" && target.Source == "ssh-config" {
		destination = target.ConfigHost
	}
	if target.Username != "" {
		destination = target.Username + "@" + destination
	}
	return append(args, destination)
}

func configureSshAskpass(cmd *exec.Cmd, manager *Manager, targetID string) (func(), error) {
	passphrase, password, cached := manager.CachedSshCredential(targetID)
	secret := passphrase
	if secret == "" {
		secret = password
	}
	if !cached || secret == "" {
		cmd.Env = append(os.Environ(), "SSH_ASKPASS=", "SSH_ASKPASS_REQUIRE=never", "DISPLAY=")
		return func() {}, nil
	}
	askpass, err := os.Executable()
	if err != nil {
		return nil, err
	}
	enableSshCredentialPrompts(cmd.Args)
	cmd.Env = append(os.Environ(),
		"SSH_ASKPASS="+askpass,
		"SSH_ASKPASS_REQUIRE=force",
		"DISPLAY=pebble:0",
		"PEBBLE_SSH_ASKPASS_MODE=1",
		"PEBBLE_SSH_ASKPASS_SECRET="+secret,
	)
	return func() {}, nil
}

func enableSshCredentialPrompts(args []string) {
	for index, value := range args {
		switch value {
		case "BatchMode=yes":
			args[index] = "BatchMode=no"
		case "PasswordAuthentication=no":
			args[index] = "PasswordAuthentication=yes"
		case "NumberOfPasswordPrompts=0":
			args[index] = "NumberOfPasswordPrompts=1"
		}
	}
}

type cappedBuffer struct {
	buffer bytes.Buffer
	limit  int
}

func (b *cappedBuffer) Write(input []byte) (int, error) {
	original := len(input)
	remaining := b.limit - b.buffer.Len()
	if remaining > 0 {
		if len(input) > remaining {
			input = input[:remaining]
		}
		_, _ = b.buffer.Write(input)
	}
	return original, nil
}

func (b *cappedBuffer) String() string {
	value := b.buffer.String()
	if b.buffer.Len() == b.limit {
		return fmt.Sprintf("%s\n...[output truncated]", value)
	}
	return value
}
