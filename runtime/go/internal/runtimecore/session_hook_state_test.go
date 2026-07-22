package runtimecore

import (
	"context"
	"runtime"
	"testing"
	"time"
)

func startHookStateTestSession(t *testing.T, command string, launchToken string) (*Manager, Session) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("hook state test uses a POSIX shell")
	}
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.StartSession(context.Background(), StartSessionRequest{
		ProjectID:   project.ID,
		Command:     []string{"/bin/sh", "-c", command},
		LaunchToken: launchToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = manager.StopSession(session.ID) })
	return manager, session
}

// TestSessionHookStateTransitionsGateWait proves hook-reported idle (not
// working or permission) is what satisfies a tui-idle wait, preserving the
// persisted session readiness contract.
func TestSessionHookStateTransitionsGateWait(t *testing.T) {
	manager, session := startHookStateTestSession(t, "sleep 30", "")

	working, err := manager.ReportSessionHookStatus(session.ID, SessionHookStatusRequest{State: "working"})
	if err != nil {
		t.Fatal(err)
	}
	if working.HookAgentState != SessionHookWorking || working.HookAgentStateAt == nil {
		t.Fatalf("expected working hook state, got %#v", working)
	}

	timeoutMs := float64(150)
	wait, err := manager.WaitSession(context.Background(), session.ID, SessionWaitRequest{
		Condition: "tui-idle",
		TimeoutMs: &timeoutMs,
	})
	if err != nil {
		t.Fatal(err)
	}
	if wait.Satisfied || !wait.TimedOut {
		t.Fatalf("working state must not satisfy tui-idle, got %#v", wait)
	}

	// Electron reports permission prompts as state=waiting; permission means
	// blocked on the user and must not satisfy tui-idle either.
	permission, err := manager.ReportSessionHookStatus(session.ID, SessionHookStatusRequest{
		State:         "waiting",
		HookEventName: "PermissionRequest",
	})
	if err != nil {
		t.Fatal(err)
	}
	if permission.HookAgentState != SessionHookPermission {
		t.Fatalf("expected waiting to normalize to permission, got %#v", permission)
	}
	wait, err = manager.WaitSession(context.Background(), session.ID, SessionWaitRequest{
		Condition: "tui-idle",
		TimeoutMs: &timeoutMs,
	})
	if err != nil {
		t.Fatal(err)
	}
	if wait.Satisfied || wait.HookAgentState != SessionHookPermission {
		t.Fatalf("permission state must not satisfy tui-idle, got %#v", wait)
	}

	// A waiter already blocked must wake on the idle transition, not poll.
	go func() {
		time.Sleep(100 * time.Millisecond)
		_, _ = manager.ReportSessionHookStatus(session.ID, SessionHookStatusRequest{State: "idle"})
	}()
	idleTimeoutMs := float64(3000)
	wait, err = manager.WaitSession(context.Background(), session.ID, SessionWaitRequest{
		Condition: "tui-idle",
		TimeoutMs: &idleTimeoutMs,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !wait.Satisfied || wait.TimedOut || wait.HookAgentState != SessionHookIdle {
		t.Fatalf("idle transition must satisfy tui-idle wait, got %#v", wait)
	}
}

// TestSessionWaitExitResolvesOnProcessExit proves exit waits wake on the
// process exit transition and report the exit code.
func TestSessionWaitExitResolvesOnProcessExit(t *testing.T) {
	manager, session := startHookStateTestSession(t, "sleep 0.2", "")
	timeoutMs := float64(5000)
	wait, err := manager.WaitSession(context.Background(), session.ID, SessionWaitRequest{
		Condition: "exit",
		TimeoutMs: &timeoutMs,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !wait.Satisfied || wait.TimedOut {
		t.Fatalf("expected exit wait to resolve, got %#v", wait)
	}
	if wait.Status != SessionExited || wait.ExitCode == nil || *wait.ExitCode != 0 {
		t.Fatalf("expected clean exit, got %#v", wait)
	}
}

// TestReportSessionHookStatusResolvesLaunchToken proves hook scripts can
// report by the launch token stamped into their PTY env instead of the
// runtime session id, which they never see.
func TestReportSessionHookStatusResolvesLaunchToken(t *testing.T) {
	manager, session := startHookStateTestSession(t, "sleep 5", "lt-hook-test")
	reported, err := manager.ReportSessionHookStatus("lt-hook-test", SessionHookStatusRequest{State: "idle"})
	if err != nil {
		t.Fatal(err)
	}
	if reported.ID != session.ID || reported.HookAgentState != SessionHookIdle {
		t.Fatalf("expected launch-token lookup to hit the session, got %#v", reported)
	}
	if _, err := manager.ReportSessionHookStatus("lt-unknown", SessionHookStatusRequest{State: "idle"}); err != ErrSessionNotFound {
		t.Fatalf("expected session not found for unknown token, got %v", err)
	}
	if _, err := manager.ReportSessionHookStatus(session.ID, SessionHookStatusRequest{State: "bogus"}); err == nil {
		t.Fatal("expected invalid hook state to error")
	}
}
