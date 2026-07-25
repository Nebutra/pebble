//go:build windows

package runtimecore

import (
	"os/exec"
	"strconv"
	"time"
)

func configureWorktreeHookProcess(command *exec.Cmd) {
	// Why: killing cmd.exe alone leaves hook descendants alive with inherited
	// output handles, so timeout cancellation must terminate the full tree.
	command.Cancel = func() error {
		terminateWorktreeHookProcessTree(command)
		return nil
	}
	command.WaitDelay = 2 * time.Second
}

func terminateWorktreeHookProcessTree(command *exec.Cmd) {
	if command.Process == nil {
		return
	}
	killer := exec.Command(windowsSystemExecutable("taskkill.exe"), "/pid", strconv.Itoa(command.Process.Pid), "/t", "/f")
	if killer.Run() != nil {
		_ = command.Process.Kill()
	}
}
