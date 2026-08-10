package runtimecore

import (
	"context"
	"runtime"
	"testing"
	"time"
)

// Why: these tests need any long-lived process to hold a PTY, not a POSIX shell
// specifically. Skipping on Windows would drop worktree-teardown coverage from
// the platform whose process-tree kill path differs most from the others.
func ptyStopTestCommand() []string {
	if runtime.GOOS == "windows" {
		return []string{"cmd.exe"}
	}
	return []string{"/bin/sh"}
}

func TestStopSessionsForWorktreeStopsLiveSessions(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	repoPath := t.TempDir()
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: repoPath})
	if err != nil {
		t.Fatal(err)
	}
	worktreeID := "wt-test-pty-stop"
	childPath := t.TempDir()
	manager.mu.Lock()
	manager.worktrees[worktreeID] = Worktree{
		ID: worktreeID, ProjectID: project.ID, Path: childPath, Branch: "feature",
		CreatedAt: time.Now().UTC(),
	}
	manager.mu.Unlock()

	session, err := manager.StartSession(context.Background(), StartSessionRequest{
		ProjectID: project.ID, WorktreeID: worktreeID, Cwd: childPath, Command: ptyStopTestCommand(),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = manager.StopSession(session.ID) })

	if err := manager.StopSessionsForWorktree(context.Background(), worktreeID, false); err != nil {
		t.Fatalf("expected sessions to stop cleanly: %v", err)
	}
	if live := manager.listLiveSessionsForWorktree(worktreeID); len(live) != 0 {
		t.Fatalf("expected no live sessions, got %#v", live)
	}
}

func TestStopSessionsForWorktreeTreatsMissingSessionAsExited(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	// No sessions — should be a no-op.
	if err := manager.StopSessionsForWorktree(context.Background(), "missing-wt", false); err != nil {
		t.Fatalf("empty worktree should not error: %v", err)
	}
}

func TestStopSessionsForWorktreeForceWaivesUnverifiedHold(t *testing.T) {
	// Force path must not permanently wedge when inventory is empty after stop errors.
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.StopSessionsForWorktree(context.Background(), "wt-force", true); err != nil {
		t.Fatalf("force waive on empty worktree: %v", err)
	}
}

func TestIsUnstoppedPtyRemovalError(t *testing.T) {
	if !IsUnstoppedPtyRemovalError(UnstoppedPtyRemovalPrefix + " wt-1 — still live: s1") {
		t.Fatal("expected prefix match")
	}
	if IsUnstoppedPtyRemovalError("Worktree has uncommitted changes") {
		t.Fatal("dirty message must not match")
	}
}

func TestDeleteWorktreeStopsSessionsBeforeGit(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	repoPath := t.TempDir()
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: repoPath})
	if err != nil {
		t.Fatal(err)
	}
	// Inject a non-main worktree without git so ExecuteGit can be false.
	worktreeID := "wt-delete-pty"
	childPath := t.TempDir()
	manager.mu.Lock()
	manager.worktrees[worktreeID] = Worktree{
		ID: worktreeID, ProjectID: project.ID, Path: childPath, Branch: "feature",
		CreatedAt: time.Now().UTC(),
	}
	manager.mu.Unlock()

	session, err := manager.StartSession(context.Background(), StartSessionRequest{
		ProjectID: project.ID, WorktreeID: worktreeID, Cwd: childPath, Command: ptyStopTestCommand(),
	})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := manager.DeleteWorktree(context.Background(), worktreeID, DeleteWorktreeRequest{
		ExecuteGit: false, Force: false,
	}); err != nil {
		t.Fatalf("delete should stop sessions and remove metadata: %v", err)
	}
	_ = session
	if live := manager.listLiveSessionsForWorktree(worktreeID); len(live) != 0 {
		t.Fatalf("sessions should be stopped after delete: %#v", live)
	}
	manager.mu.RLock()
	_, ok := manager.worktrees[worktreeID]
	manager.mu.RUnlock()
	if ok {
		t.Fatal("worktree metadata should be removed")
	}
}
