//go:build windows

package runtimecore

import (
	"context"
	"encoding/base64"
	"os/exec"
	"strconv"
	"strings"
)

func ephemeralVMShellCommand(ctx context.Context, command string) *exec.Cmd {
	return exec.CommandContext(ctx, "cmd.exe", "/d", "/s", "/c", command)
}

func ephemeralVMCleanupShellCommand(command string, payload []byte) string {
	encoded := base64.StdEncoding.EncodeToString(payload)
	script := "$b=[Convert]::FromBase64String('" + encoded + "');[Console]::OpenStandardOutput().Write($b,0,$b.Length)"
	return "powershell.exe -NoProfile -Command \"" + strings.ReplaceAll(script, "\"", "\\\"") + "\" | " + command
}

func configureEphemeralVMProcess(command *exec.Cmd) {
	command.Cancel = func() error {
		killEphemeralVMProcess(command)
		return nil
	}
}

func killEphemeralVMProcess(command *exec.Cmd) {
	if command.Process == nil {
		return
	}
	killer := exec.Command("taskkill", "/pid", strconv.Itoa(command.Process.Pid), "/t", "/f")
	if killer.Run() != nil {
		_ = command.Process.Kill()
	}
}
