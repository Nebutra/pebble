//go:build !windows

package runtimecore

import (
	"fmt"
	"io"
	"syscall"
)

func signalPlatformSessionProcess(pid int, _ io.Writer, signal string) error {
	if pid <= 0 {
		return fmt.Errorf("session process is unavailable")
	}
	signals := map[string]syscall.Signal{
		"SIGHUP":  syscall.SIGHUP,
		"SIGINT":  syscall.SIGINT,
		"SIGQUIT": syscall.SIGQUIT,
		"SIGTERM": syscall.SIGTERM,
		"SIGKILL": syscall.SIGKILL,
		"SIGUSR1": syscall.SIGUSR1,
		"SIGUSR2": syscall.SIGUSR2,
	}
	resolved, ok := signals[signal]
	if !ok {
		return fmt.Errorf("unsupported session signal %q", signal)
	}
	return syscall.Kill(pid, resolved)
}
