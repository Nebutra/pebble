package runtimecore

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// Why: `stop()` used to publish `stopped` right after signalling the kill, so
// the worktree removal gate could see zero live sessions while the child was
// still holding its working directory. On Windows that turns into "the process
// cannot access the file because it is being used by another process" on the
// very next delete. `stopped` now means reaped, and this pins that.
func TestStopWaitsForTheChildToBeReaped(t *testing.T) {
	reaped := make(chan struct{})
	var cleanedUp atomic.Bool
	session := &processSession{
		id:          "session-under-test",
		status:      SessionRunning,
		exitHandled: make(chan struct{}),
		killProcess: func() error { close(reaped); return nil },
		waitProcess: func() error { <-reaped; time.Sleep(30 * time.Millisecond); return nil },
	}
	session.cleanupProcess = func() { cleanedUp.Store(true) }
	go session.wait()

	snapshot, err := session.stop()
	if err != nil {
		t.Fatalf("stop: %v", err)
	}
	if !cleanedUp.Load() {
		t.Fatal("stop returned before the PTY cleanup ran")
	}
	if snapshot.Status != SessionStopped {
		t.Fatalf("status = %q, want %q", snapshot.Status, SessionStopped)
	}
}

// Why: a child that never dies must not wedge teardown — the bounded wait has
// to give up and still report the session stopped.
func TestStopGivesUpOnAChildThatNeverExits(t *testing.T) {
	session := &processSession{
		id:          "wedged-session",
		status:      SessionRunning,
		exitHandled: make(chan struct{}),
		killProcess: func() error { return nil },
		waitProcess: func() error { select {} },
	}
	go session.wait()

	ctx, cancel := context.WithTimeout(context.Background(), sessionStopReapBudget+5*time.Second)
	defer cancel()
	done := make(chan SessionStatus, 1)
	go func() {
		snapshot, _ := session.stop()
		done <- snapshot.Status
	}()
	select {
	case status := <-done:
		if status != SessionStopped {
			t.Fatalf("status = %q, want %q", status, SessionStopped)
		}
	case <-ctx.Done():
		t.Fatal("stop never returned for a child that ignores the kill")
	}
}
