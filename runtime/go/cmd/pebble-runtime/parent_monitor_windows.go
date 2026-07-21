//go:build windows

package main

import (
	"context"
	"time"

	"golang.org/x/sys/windows"
)

func waitForDesktopParentExit(ctx context.Context, parentPID int) bool {
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(parentPID))
	if err != nil {
		return true
	}
	defer windows.CloseHandle(handle)
	for {
		status, err := windows.WaitForSingleObject(handle, 250)
		if err != nil || status == windows.WAIT_OBJECT_0 {
			return true
		}
		if status != uint32(windows.WAIT_TIMEOUT) {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(10 * time.Millisecond):
		}
	}
}
