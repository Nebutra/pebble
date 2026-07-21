//go:build !windows

package runtimecore

import (
	"context"
	"encoding/base64"
	"os/exec"
	"strings"
	"syscall"
)

func ephemeralVMShellCommand(ctx context.Context, command string) *exec.Cmd {
	return exec.CommandContext(ctx, "/bin/sh", "-c", command)
}

func ephemeralVMCleanupShellCommand(command string, payload []byte) string {
	encoded := base64.StdEncoding.EncodeToString(payload)
	return "printf %s '" + strings.ReplaceAll(encoded, "'", "'\\''") + "' | base64 -d | " + command
}

func configureEphemeralVMProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error {
		if command.Process == nil {
			return nil
		}
		return syscall.Kill(-command.Process.Pid, syscall.SIGTERM)
	}
}

func killEphemeralVMProcess(command *exec.Cmd) {
	if command.Process != nil {
		_ = syscall.Kill(-command.Process.Pid, syscall.SIGTERM)
	}
}
