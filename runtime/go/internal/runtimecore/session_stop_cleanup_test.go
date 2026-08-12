package runtimecore

import (
	"context"
	"testing"
	"time"
)

// stopSessionForTest stops a session and waits for the process to be reaped.
//
// Why: StopSession returns once the kill is issued, not once the OS has torn
// the child down. On Windows the child keeps a handle on its working directory
// after that, so t.TempDir()'s RemoveAll — which runs right after this cleanup —
// intermittently failed with "The process cannot access the file because it is
// being used by another process".
func stopSessionForTest(t *testing.T, manager *Manager, sessionID string) {
	t.Helper()
	_, _ = manager.StopSession(sessionID)
	timeoutMs := float64(5_000)
	_, _ = manager.WaitSession(context.Background(), sessionID, SessionWaitRequest{
		Condition: "exit",
		TimeoutMs: &timeoutMs,
	})
	// A reaped process can still be releasing its handles, so give the OS a
	// moment before the directory it ran in is removed.
	time.Sleep(20 * time.Millisecond)
}
