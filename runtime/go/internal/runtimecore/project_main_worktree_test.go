package runtimecore

import (
	"context"
	"os/exec"
	"testing"
)

func TestCreateProjectWithMainWorktreeRegistersRepositoryRoot(t *testing.T) {
	repo := t.TempDir()
	if output, err := exec.Command("git", "-C", repo, "init", "-b", "main").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, output)
	}
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProjectWithMainWorktree(context.Background(), CreateProjectRequest{
		Path: repo, LocationKind: "local", Provider: "git",
	})
	if err != nil {
		t.Fatal(err)
	}
	worktrees := manager.ListWorktrees(project.ID)
	if len(worktrees) != 1 || worktrees[0].Path != project.Path || worktrees[0].Branch != "main" {
		t.Fatalf("unexpected main worktree: %#v", worktrees)
	}
}
