package runtimecore

import (
	"context"
	"testing"
)

// stopSessionForTest stops a session and waits for the process to be reaped.
//
// Why: on Windows a child keeps a handle on its working directory until it is
// torn down, so t.TempDir()'s RemoveAll — which runs right after this cleanup —
// intermittently failed with "The process cannot access the file because it is
// being used by another process". StopSession now returns only once the child
// has been reaped and its PTY closed, so no sleep is needed here; a fixed sleep
// only moved the race rather than closing it.
func stopSessionForTest(t *testing.T, manager *Manager, sessionID string) {
	t.Helper()
	_, _ = manager.StopSession(sessionID)
	timeoutMs := float64(5_000)
	_, _ = manager.WaitSession(context.Background(), sessionID, SessionWaitRequest{
		Condition: "exit",
		TimeoutMs: &timeoutMs,
	})
}
