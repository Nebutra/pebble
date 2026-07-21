//go:build windows

package runtimecore

import (
	"os/exec"
	"strconv"
)

func configureNotebookProcess(_ *exec.Cmd) {}

func terminateNotebookProcessTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	killer := exec.Command("taskkill", "/pid", strconv.Itoa(cmd.Process.Pid), "/t", "/f")
	if killer.Run() != nil {
		_ = cmd.Process.Kill()
	}
}
