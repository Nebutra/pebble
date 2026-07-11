package runtimecore

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
	Success bool   `json:"success"`
	Status  string `json:"status"`
	Output  string `json:"output,omitempty"`
	Error   string `json:"error,omitempty"`
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
	workerPath, deploymentError := m.deployAgentHookRelayWorker(commandCtx, sshPath, id, target)
	if deploymentError != nil {
		return SshAgentHookBootstrapResult{Status: "error", Error: deploymentError.Error()}, nil
	}
	if workerPath != "" {
		req.Script = "export PEBBLE_RELAY_WORKER=" + quotePosixShell(workerPath) + "\n" + req.Script
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
	dir, err := os.MkdirTemp("", "pebble-ssh-askpass-")
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "askpass.sh")
	// Why: the secret stays in the child environment, not argv or generated file.
	if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf '%s\\n' \"$PEBBLE_SSH_ASKPASS_SECRET\"\n"), 0o700); err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	cmd.Env = append(os.Environ(), "SSH_ASKPASS="+path, "SSH_ASKPASS_REQUIRE=force", "DISPLAY=pebble:0", "PEBBLE_SSH_ASKPASS_SECRET="+secret)
	return func() { _ = os.RemoveAll(dir) }, nil
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
