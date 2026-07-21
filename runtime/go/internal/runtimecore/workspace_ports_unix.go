//go:build !windows

package runtimecore

import "syscall"

func terminateWorkspacePortProcess(pid int) error {
	return syscall.Kill(pid, syscall.SIGTERM)
}
