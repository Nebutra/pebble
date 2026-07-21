//go:build windows

package runtimecore

import (
	"fmt"
	"io"
	"os/exec"
	"strconv"
)

func signalPlatformSessionProcess(pid int, terminal io.Writer, signal string) error {
	if pid <= 0 {
		return fmt.Errorf("session process is unavailable")
	}
	switch signal {
	case "SIGINT":
		return writeWindowsTerminalControl(terminal, 0x03, signal)
	case "SIGQUIT":
		return writeWindowsTerminalControl(terminal, 0x1c, signal)
	case "SIGHUP":
		return writeWindowsTerminalControl(terminal, 0x04, signal)
	case "SIGTERM":
		return runWindowsTaskkill(pid, false)
	case "SIGKILL":
		return runWindowsTaskkill(pid, true)
	default:
		return fmt.Errorf("unsupported session signal %q on Windows", signal)
	}
}

func writeWindowsTerminalControl(terminal io.Writer, control byte, signal string) error {
	if terminal == nil {
		return fmt.Errorf("cannot deliver %s: session terminal is unavailable", signal)
	}
	_, err := terminal.Write([]byte{control})
	return err
}

func runWindowsTaskkill(pid int, force bool) error {
	args := []string{"/pid", strconv.Itoa(pid), "/t"}
	if force {
		args = append(args, "/f")
	}
	// Why: ConPTY owns a process tree, while Process.Kill only guarantees the
	// shell process. taskkill preserves terminal stop semantics for descendants.
	output, err := exec.Command("taskkill", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("taskkill failed: %w: %s", err, string(output))
	}
	return nil
}
