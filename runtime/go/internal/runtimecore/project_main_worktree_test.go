package runtimecore

import (
	"context"
	"os/exec"
	"path/filepath"
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
	if len(worktrees) != 1 || worktrees[0].Path != project.Path || worktrees[0].Branch != "main" || !worktrees[0].IsMainWorktree {
		t.Fatalf("unexpected main worktree: %#v", worktrees)
	}
}

func TestDeleteWorktreeRejectsRepositoryRoot(t *testing.T) {
	repo := t.TempDir()
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProjectWithMainWorktree(context.Background(), CreateProjectRequest{
		Path: repo, LocationKind: "local", Provider: "folder",
	})
	if err != nil {
		t.Fatal(err)
	}
	worktree := manager.ListWorktrees(project.ID)[0]

	if _, err := manager.DeleteWorktree(context.Background(), worktree.ID, DeleteWorktreeRequest{}); err == nil || err.Error() != "main worktree cannot be deleted; remove the project instead" {
		t.Fatalf("expected main-worktree rejection, got %v", err)
	}
	if worktrees := manager.ListWorktrees(project.ID); len(worktrees) != 1 {
		t.Fatalf("main worktree record was removed: %#v", worktrees)
	}
}

func TestCreateProjectWithMainWorktreeIsIdempotentForRepositoryRoot(t *testing.T) {
	repo := t.TempDir()
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	first, err := manager.CreateProjectWithMainWorktree(context.Background(), CreateProjectRequest{
		Path: repo, LocationKind: "local", Provider: "folder",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.CreateProjectWithMainWorktree(context.Background(), CreateProjectRequest{
		Name: "renamed metadata", Path: filepath.Join(repo, "."), LocationKind: "local", Provider: "folder",
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID {
		t.Fatalf("expected project %s, got %s", first.ID, second.ID)
	}
	if projects := manager.ListProjects(); len(projects) != 1 {
		t.Fatalf("expected one project, got %#v", projects)
	}
	if worktrees := manager.ListWorktrees(first.ID); len(worktrees) != 1 {
		t.Fatalf("expected one main worktree, got %#v", worktrees)
	}
}
