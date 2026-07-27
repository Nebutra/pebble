//go:build !windows

package runtimecore

import (
	"context"
	"os/exec"
	"syscall"
	"time"
)

func worktreeHookCommand(ctx context.Context, script string) (*exec.Cmd, func(), error) {
	command := exec.CommandContext(ctx, "/bin/bash", "-c", script)
	configureWorktreeHookProcess(command)
	return command, func() {}, nil
}

func configureWorktreeHookProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// Why: shell hooks can leave descendants holding output pipes after the
	// shell exits, so cancellation must own the complete process group.
	command.Cancel = func() error {
		if command.Process != nil {
			_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
	command.WaitDelay = 2 * time.Second
}

func configureAutomationPrecheckProcess(command *exec.Cmd) {
	configureWorktreeHookProcess(command)
}

func automationPrecheckCommand(ctx context.Context, script string) *exec.Cmd {
	command := exec.CommandContext(ctx, "/bin/sh", "-c", script)
	configureAutomationPrecheckProcess(command)
	return command
}
