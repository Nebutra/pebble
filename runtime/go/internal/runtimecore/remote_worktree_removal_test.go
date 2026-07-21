package runtimecore

import (
	"context"
	"errors"
	"testing"
)

func newSshProjectWithWorktree(t *testing.T) (*Manager, Project, Worktree) {
	t.Helper()
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{
		Name:         "remote-repo",
		Path:         "/srv/remote-repo",
		LocationKind: "ssh",
		HostID:       "host-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := manager.CreateWorktree(context.Background(), CreateWorktreeRequest{
		ProjectID: project.ID,
		Path:      "/srv/remote-repo-worktrees/feature",
		Branch:    "feature/remote",
	})
	if err != nil {
		t.Fatal(err)
	}
	return manager, project, worktree
}

func TestCompleteRemoteWorktreeRemovalRetiresRecord(t *testing.T) {
	manager, project, worktree := newSshProjectWithWorktree(t)
	preserved := &PreservedWorktreeBranch{BranchName: "feature/remote", Head: "abc123"}
	result, err := manager.CompleteRemoteWorktreeRemoval(CompleteRemoteWorktreeRemovalRequest{
		ProjectID:       project.ID,
		WorktreeID:      worktree.ID,
		PreservedBranch: preserved,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ID != worktree.ID {
		t.Fatalf("unexpected removed worktree: %#v", result.Worktree)
	}
	if result.PreservedBranch == nil || result.PreservedBranch.BranchName != "feature/remote" {
		t.Fatalf("expected preserved branch to round-trip, got %#v", result.PreservedBranch)
	}
	if got := manager.ListWorktrees(project.ID); len(got) != 0 {
		t.Fatalf("worktree record should be gone: %#v", got)
	}
}

func TestCompleteRemoteWorktreeRemovalRejectsLocalProjects(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "local", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := manager.CreateWorktree(context.Background(), CreateWorktreeRequest{
		ProjectID: project.ID,
		Path:      t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.CompleteRemoteWorktreeRemoval(CompleteRemoteWorktreeRemovalRequest{
		ProjectID:  project.ID,
		WorktreeID: worktree.ID,
	}); err == nil {
		t.Fatal("expected local project remote removal to be rejected")
	}
	if got := manager.ListWorktrees(project.ID); len(got) != 1 {
		t.Fatalf("local worktree record must survive: %#v", got)
	}
}

func TestCompleteRemoteWorktreeRemovalRejectsMismatchedProject(t *testing.T) {
	manager, _, worktree := newSshProjectWithWorktree(t)
	other, err := manager.CreateProject(CreateProjectRequest{
		Name:         "other-remote",
		Path:         "/srv/other",
		LocationKind: "ssh",
		HostID:       "host-2",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.CompleteRemoteWorktreeRemoval(CompleteRemoteWorktreeRemovalRequest{
		ProjectID:  other.ID,
		WorktreeID: worktree.ID,
	})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound for mismatched project, got %v", err)
	}
}

func TestCompleteRemotePreservedBranchRemoval(t *testing.T) {
	manager, project, _ := newSshProjectWithWorktree(t)
	removal, err := manager.CompleteRemotePreservedBranchRemoval(CompleteRemotePreservedBranchRemovalRequest{
		ProjectID:  project.ID,
		BranchName: "refs/heads/feature/remote",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !removal.Deleted || removal.BranchName != "feature/remote" {
		t.Fatalf("unexpected removal result: %#v", removal)
	}
	localProject, err := manager.CreateProject(CreateProjectRequest{Name: "local", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.CompleteRemotePreservedBranchRemoval(CompleteRemotePreservedBranchRemovalRequest{
		ProjectID:  localProject.ID,
		BranchName: "feature/remote",
	}); err == nil {
		t.Fatal("expected local project remote branch removal to be rejected")
	}
}
