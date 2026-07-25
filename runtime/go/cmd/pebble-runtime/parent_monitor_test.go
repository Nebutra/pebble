package main

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"
)

func TestMonitorDesktopParentIgnoresInvalidPID(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	monitorDesktopParent(ctx, cancel, "invalid")
	select {
	case <-ctx.Done():
		t.Fatal("invalid parent PID should not cancel the runtime")
	case <-time.After(10 * time.Millisecond):
	}
	cancel()
}

func TestMonitorDesktopParentCancelsAfterParentChanges(t *testing.T) {
	process := exec.Command(os.Args[0], "-test.run=^$")
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	parentPID := process.Process.Pid
	if err := process.Wait(); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	monitorDesktopParent(ctx, cancel, strconv.Itoa(parentPID))
	select {
	case <-ctx.Done():
	case <-time.After(1500 * time.Millisecond):
		t.Fatal("changed parent PID did not cancel the runtime")
	}
}
