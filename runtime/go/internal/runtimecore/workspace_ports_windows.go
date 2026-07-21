//go:build windows

package runtimecore

import "os"

func terminateWorkspacePortProcess(pid int) error {
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return process.Kill()
}
