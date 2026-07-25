//go:build !windows

package runtimecore

import (
	"os/exec"
	"syscall"
	"time"
)

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
