package runtimecore

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestWorkspaceCleanupClassifiesCleanAndDirtyWorktrees(t *testing.T) {
	repo, worktree := createCleanupGitFixture(t)
	old := time.Now().Add(-45 * 24 * time.Hour).UnixMilli()
	manager := &Manager{
		projects: map[string]Project{"repo-1": {ID: "repo-1", Name: "Pebble", Path: repo, LocationKind: "local"}},
		worktrees: map[string]Worktree{
			"wt-1": {ID: "wt-1", ProjectID: "repo-1", Path: worktree, Branch: "feature", DisplayName: "Feature", LastActivityAt: old, CreatedAt: time.Now()},
		},
		sessions:    map[string]*processSession{},
		subscribers: map[uint64]chan RuntimeEvent{},
	}
	result := manager.ScanWorkspaceCleanup(context.Background(), WorkspaceCleanupScanRequest{})
	if len(result.Candidates) != 1 {
		t.Fatalf("expected one candidate, got %#v", result)
	}
	candidate := result.Candidates[0]
	if candidate.Tier != "ready" || !candidate.SelectedByDefault || candidate.Git.Clean == nil || !*candidate.Git.Clean {
		t.Fatalf("expected ready clean candidate, got %#v", candidate)
	}

	if err := os.WriteFile(filepath.Join(worktree, "dirty.txt"), []byte("dirty"), 0o600); err != nil {
		t.Fatal(err)
	}
	dirty := manager.ScanWorkspaceCleanup(context.Background(), WorkspaceCleanupScanRequest{})
	if dirty.Candidates[0].Tier != "protected" || !containsCleanupValue(dirty.Candidates[0].Blockers, "dirty-files") {
		t.Fatalf("expected dirty protection, got %#v", dirty.Candidates[0])
	}
}

func TestWorkspaceCleanupProcessLiveness(t *testing.T) {
	manager := &Manager{sessions: map[string]*processSession{
		"session-1": {worktreeID: "wt-1"},
	}}
	result := manager.HasWorkspaceCleanupProcesses(WorkspaceCleanupLocalProcessRequest{WorktreeID: "wt-1"})
	if result.HasKillableProcesses == nil || !*result.HasKillableProcesses {
		t.Fatalf("expected running process, got %#v", result)
	}
}

func TestWorkspaceCleanupEmitsIncrementalProgress(t *testing.T) {
	repo, worktree := createCleanupGitFixture(t)
	manager := &Manager{
		projects:  map[string]Project{"repo-1": {ID: "repo-1", Name: "Pebble", Path: repo, LocationKind: "local"}},
		worktrees: map[string]Worktree{"wt-1": {ID: "wt-1", ProjectID: "repo-1", Path: worktree, Branch: "feature", LastActivityAt: time.Now().Add(-45 * 24 * time.Hour).UnixMilli(), CreatedAt: time.Now()}},
		sessions:  map[string]*processSession{}, subscribers: map[uint64]chan RuntimeEvent{},
	}
	_, events := manager.Subscribe(8)
	manager.ScanWorkspaceCleanup(context.Background(), WorkspaceCleanupScanRequest{ScanID: "scan-1"})
	first := <-events
	second := <-events
	if first.Topic != "workspace-cleanup.progress" || second.Topic != "workspace-cleanup.progress" {
		t.Fatalf("unexpected progress topics: %q %q", first.Topic, second.Topic)
	}
	progress, ok := second.Payload.(WorkspaceCleanupScanProgress)
	if !ok || progress.ScannedWorktreeCount != 1 || len(progress.Candidates) != 1 {
		t.Fatalf("expected incremental candidate progress, got %#v", second.Payload)
	}
}

func createCleanupGitFixture(t *testing.T) (string, string) {
	t.Helper()
	repo := filepath.Join(t.TempDir(), "repo")
	worktree := filepath.Join(t.TempDir(), "worktree")
	runCleanupGit(t, "init", repo)
	runCleanupGit(t, "-C", repo, "config", "user.email", "pebble@example.com")
	runCleanupGit(t, "-C", repo, "config", "user.name", "Pebble")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("Pebble"), 0o600); err != nil {
		t.Fatal(err)
	}
	runCleanupGit(t, "-C", repo, "add", "README.md")
	runCleanupGit(t, "-C", repo, "commit", "-m", "Initial")
	runCleanupGit(t, "-C", repo, "branch", "feature")
	runCleanupGit(t, "-C", repo, "update-ref", "refs/remotes/origin/feature", "feature")
	runCleanupGit(t, "-C", repo, "worktree", "add", worktree, "feature")
	return repo, worktree
}

func runCleanupGit(t *testing.T, args ...string) {
	t.Helper()
	if output, err := exec.Command("git", args...).CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, output)
	}
}

func containsCleanupValue(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
