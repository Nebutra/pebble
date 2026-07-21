//go:build windows

package runtimecore

import (
	"os/exec"
	"strconv"
)

func configureTextGenerationProcess(_ *exec.Cmd) {}

func killTextGenerationProcess(command *exec.Cmd) {
	if command.Process == nil {
		return
	}
	killer := exec.Command("taskkill", "/pid", strconv.Itoa(command.Process.Pid), "/t", "/f")
	if killer.Run() != nil {
		_ = command.Process.Kill()
	}
}
