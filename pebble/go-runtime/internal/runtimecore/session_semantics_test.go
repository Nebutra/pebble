package runtimecore

import (
	"context"
	"runtime"
	"testing"
	"time"
)

// findSession returns the current snapshot for id from a list poll.
func findSession(sessions []Session, id string) (Session, bool) {
	for _, s := range sessions {
		if s.ID == id {
			return s, true
		}
	}
	return Session{}, false
}

// TestSessionAltScreenActiveFromStream spawns a shell that emits the smcup
// sequence and stays alive, then asserts the session status reports
// altScreenActive — proving the stream scanner is wired into the snapshot.
func TestSessionAltScreenActiveFromStream(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("alt-screen stream test uses a POSIX shell")
	}
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	// Emit smcup (enter alt screen), then sleep so the process is still running
	// when we read status.
	session, err := manager.StartSession(context.Background(), StartSessionRequest{
		ProjectID: project.ID,
		Command:   []string{"/bin/sh", "-c", "printf '\\033[?1049h'; sleep 5"},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = manager.StopSession(session.ID) })

	if !waitFor(3*time.Second, func() bool {
		s, ok := findSession(manager.ListSessions(), session.ID)
		return ok && s.AltScreenActive
	}) {
		t.Fatal("expected altScreenActive true after smcup emitted")
	}

	// Now emit enter then leave (with a marker newline between so a chunk flushes
	// and we can confirm the stream was consumed) and expect the final state
	// inactive.
	leave, err := manager.StartSession(context.Background(), StartSessionRequest{
		ProjectID: project.ID,
		Command:   []string{"/bin/sh", "-c", "printf '\\033[?1049h\\ndone\\n\\033[?1049l\\n'; sleep 5"},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = manager.StopSession(leave.ID) })

	// Wait until the stream has been consumed and the final rmcup has flipped
	// alt-screen back off. Output now flushes byte-immediate (not line-buffered,
	// see readStream), so a tiny printf can arrive as a single chunk; wait on
	// the actual alt-screen state rather than an output chunk count.
	if !waitFor(3*time.Second, func() bool {
		s, ok := findSession(manager.ListSessions(), leave.ID)
		return ok && s.OutputChunks >= 1 && !s.AltScreenActive
	}) {
		t.Fatal("expected altScreenActive false after rmcup")
	}
}

// TestSessionForegroundProcess spawns a shell that execs a nested command and
// asserts the status read resolves a foreground process name.
func TestSessionForegroundProcess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("foreground process detection is not implemented on Windows")
	}
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	// exec replaces the shell with sleep so the process group's foreground
	// member has a predictable name.
	session, err := manager.StartSession(context.Background(), StartSessionRequest{
		ProjectID: project.ID,
		Command:   []string{"/bin/sh", "-c", "exec sleep 10"},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = manager.StopSession(session.ID) })

	var status Session
	if !waitFor(4*time.Second, func() bool {
		s, err := manager.SessionStatus(session.ID)
		if err != nil {
			return false
		}
		status = s
		return s.ForegroundProcess != nil
	}) {
		t.Fatalf("expected a resolved foreground process, got %+v", status)
	}
	if *status.ForegroundProcess != "sleep" {
		t.Fatalf("foregroundProcess = %q, want sleep", *status.ForegroundProcess)
	}
	if status.ForegroundProcessUnsupportedReason != "" {
		t.Fatalf("unexpected unsupported reason on unix: %q", status.ForegroundProcessUnsupportedReason)
	}
}

// TestSessionStatusListPollStaysCheap confirms ListSessions does not populate
// the foreground field (that probe is reserved for explicit status reads).
func TestSessionStatusListPollStaysCheap(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.StartSession(context.Background(), StartSessionRequest{
		ProjectID: project.ID,
		Command:   testSleepCommand(),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = manager.StopSession(session.ID) })

	s, ok := findSession(manager.ListSessions(), session.ID)
	if !ok {
		t.Fatal("session missing from list")
	}
	if s.ForegroundProcess != nil {
		t.Fatalf("list poll must not resolve foreground process, got %q", *s.ForegroundProcess)
	}
}

func waitFor(timeout time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return cond()
}
