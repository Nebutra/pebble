//go:build windows

package runtimecore

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"time"
)

func worktreeHookCommand(ctx context.Context, script string) (*exec.Cmd, func(), error) {
	file, err := os.CreateTemp("", "pebble-worktree-hook-*.cmd")
	if err != nil {
		return nil, func() {}, err
	}
	path := file.Name()
	cleanup := func() { _ = os.Remove(path) }
	contents := "@echo off\r\n" + script + "\r\nexit /b %errorlevel%\r\n"
	if _, err := file.WriteString(contents); err != nil {
		_ = file.Close()
		cleanup()
		return nil, func() {}, err
	}
	if err := file.Close(); err != nil {
		cleanup()
		return nil, func() {}, err
	}
	// Why: Go's generic Windows argv quoting is not compatible with cmd.exe
	// when an inline hook contains quoted paths; a temporary .cmd preserves it.
	command := exec.CommandContext(ctx, windowsSystemExecutable("cmd.exe"), "/d", "/s", "/c", path)
	configureWorktreeHookProcess(command)
	return command, cleanup, nil
}

func configureWorktreeHookProcess(command *exec.Cmd) {
	// Why: killing cmd.exe alone leaves hook descendants alive with inherited
	// output handles, so timeout cancellation must terminate the full tree.
	command.Cancel = func() error {
		terminateWorktreeHookProcessTree(command)
		return nil
	}
	command.WaitDelay = 2 * time.Second
}

func configureAutomationPrecheckProcess(command *exec.Cmd) {
	configureWorktreeHookProcess(command)
}

func automationPrecheckCommand(ctx context.Context, script string) *exec.Cmd {
	command := exec.CommandContext(ctx, windowsSystemExecutable("cmd.exe"), "/d", "/s", "/c", script)
	configureAutomationPrecheckProcess(command)
	return command
}

func terminateWorktreeHookProcessTree(command *exec.Cmd) {
	if command.Process == nil {
		return
	}
	killer := exec.Command(windowsSystemExecutable("taskkill.exe"), "/pid", strconv.Itoa(command.Process.Pid), "/t", "/f")
	if killer.Run() != nil {
		if err := command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			return
		}
	}
}
