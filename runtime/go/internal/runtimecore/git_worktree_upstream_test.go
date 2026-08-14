package runtimecore

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestGitWorktreeUpstreamStatusReportsNoRemote(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	repo := t.TempDir()
	runGitWorktreeUpstream(t, repo, "init", "--initial-branch=main")
	if err := os.WriteFile(filepath.Join(repo, "README"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGitWorktreeUpstream(t, repo, "add", "README")
	runGitWorktreeUpstream(t, repo, "commit", "-m", "init")

	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: repo})
	if err != nil {
		t.Fatal(err)
	}
	status, err := manager.GitWorktreeUpstreamStatus(context.Background(), GitWorktreeUpstreamStatusRequest{ProjectID: project.ID})
	if err != nil {
		t.Fatal(err)
	}
	if status.HasUpstream || status.Ahead != 0 || status.Behind != 0 || status.UpstreamName != "" {
		t.Fatalf("expected no upstream on a local-only repo, got %#v", status)
	}
}

func TestGitWorktreeUpstreamStatusReadsTrackingBranch(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	repo := t.TempDir()
	runGitWorktreeUpstream(t, repo, "init", "--initial-branch=main")
	if err := os.WriteFile(filepath.Join(repo, "README"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGitWorktreeUpstream(t, repo, "add", "README")
	runGitWorktreeUpstream(t, repo, "commit", "-m", "init")
	// Why: a local bare remote is enough to prove we read git's
	// ## branch...upstream line instead of inventing one.
	origin := t.TempDir()
	runGitWorktreeUpstream(t, origin, "init", "--bare", "--initial-branch=main")
	runGitWorktreeUpstream(t, repo, "remote", "add", "origin", origin)
	runGitWorktreeUpstream(t, repo, "push", "-u", "origin", "main")

	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: repo})
	if err != nil {
		t.Fatal(err)
	}
	status, err := manager.GitWorktreeUpstreamStatus(context.Background(), GitWorktreeUpstreamStatusRequest{ProjectID: project.ID})
	if err != nil {
		t.Fatal(err)
	}
	if !status.HasUpstream || status.UpstreamName != "origin/main" {
		t.Fatalf("expected origin/main tracking, got %#v", status)
	}
}

func TestGitUpstreamNameFromStatusLines(t *testing.T) {
	if got := gitUpstreamNameFromStatusLines([]string{"## main...origin/main [ahead 1, behind 2]"}); got != "origin/main" {
		t.Fatalf("got %q", got)
	}
	if got := gitUpstreamNameFromStatusLines([]string{"## main"}); got != "" {
		t.Fatalf("local branch should have no upstream, got %q", got)
	}
}

func runGitWorktreeUpstream(t *testing.T, dir string, args ...string) {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	command.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com",
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, output)
	}
}
