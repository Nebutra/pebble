//go:build !windows

package main

import (
	"context"
	"os"
	"time"
)

func waitForDesktopParentExit(ctx context.Context, parentPID int) bool {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
			if os.Getppid() != parentPID {
				return true
			}
		}
	}
}
