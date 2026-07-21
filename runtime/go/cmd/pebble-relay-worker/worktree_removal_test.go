package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func initTestRepo(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	if _, err := exec.Command("git", "-C", repo, "init").CombinedOutput(); err != nil {
		t.Skipf("git unavailable: %v", err)
	}
	runRepoGit(t, repo, "config", "user.email", "dev@example.test")
	runRepoGit(t, repo, "config", "user.name", "Dev")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runRepoGit(t, repo, "add", "README.md")
	runRepoGit(t, repo, "commit", "-m", "init")
	return repo
}

func runRepoGit(t *testing.T, repo string, args ...string) {
	t.Helper()
	fullArgs := append([]string{"-C", repo}, args...)
	if output, err := exec.Command("git", fullArgs...).CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, output)
	}
}

func TestRunWorktreeRemovePostsCompletion(t *testing.T) {
	repo := initTestRepo(t)
	worktreePath := filepath.Join(t.TempDir(), "feature-worktree")
	runRepoGit(t, repo, "worktree", "add", "-b", "feature/relay", worktreePath, "HEAD")

	var gotPath string
	var got runtimecore.CompleteRemoteWorktreeRemovalRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	var output bytes.Buffer
	err := run([]string{
		"worktree-remove",
		"--endpoint", server.URL,
		"--project", "proj_remote",
		"--worktree", "wt_remote",
		"--repo", repo,
		"--path", worktreePath,
		"--branch", "feature/relay",
	}, server.Client(), &output)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/worktrees/remote-removals" {
		t.Fatalf("unexpected path %q", gotPath)
	}
	if got.ProjectID != "proj_remote" || got.WorktreeID != "wt_remote" {
		t.Fatalf("unexpected completion payload: %#v", got)
	}
	// The branch was created off HEAD with no extra commits, so safe delete
	// succeeds and nothing is preserved.
	if got.PreservedBranch != nil {
		t.Fatalf("expected no preserved branch, got %#v", got.PreservedBranch)
	}
	if _, err := os.Stat(worktreePath); !os.IsNotExist(err) {
		t.Fatalf("expected worktree directory to be removed, got %v", err)
	}
}

func TestRunWorktreeRemoveReportsPreservedBranch(t *testing.T) {
	repo := initTestRepo(t)
	worktreePath := filepath.Join(t.TempDir(), "unmerged-worktree")
	runRepoGit(t, repo, "worktree", "add", "-b", "feature/unmerged", worktreePath, "HEAD")
	if err := os.WriteFile(filepath.Join(worktreePath, "work.txt"), []byte("wip\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runRepoGit(t, worktreePath, "add", "work.txt")
	runRepoGit(t, worktreePath, "commit", "-m", "wip")

	var got runtimecore.CompleteRemoteWorktreeRemovalRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	var output bytes.Buffer
	err := run([]string{
		"worktree-remove",
		"--endpoint", server.URL,
		"--project", "proj_remote",
		"--worktree", "wt_remote",
		"--repo", repo,
		"--path", worktreePath,
		"--branch", "feature/unmerged",
	}, server.Client(), &output)
	if err != nil {
		t.Fatal(err)
	}
	if got.PreservedBranch == nil || got.PreservedBranch.BranchName != "feature/unmerged" || got.PreservedBranch.Head == "" {
		t.Fatalf("expected unmerged branch to be preserved with its head, got %#v", got.PreservedBranch)
	}
}

func TestRunWorktreeRemoveRefusesRepoRoot(t *testing.T) {
	repo := initTestRepo(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("no completion must be posted when removal is refused")
	}))
	defer server.Close()
	err := run([]string{
		"worktree-remove",
		"--endpoint", server.URL,
		"--project", "proj_remote",
		"--worktree", "wt_remote",
		"--repo", repo,
		"--path", repo,
	}, server.Client(), io.Discard)
	if err == nil {
		t.Fatal("expected removing the repo root to be refused")
	}
}

func TestRunBranchDeletePostsCompletion(t *testing.T) {
	repo := initTestRepo(t)
	runRepoGit(t, repo, "branch", "preserved/branch")

	var gotPath string
	var got runtimecore.CompleteRemotePreservedBranchRemovalRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	var output bytes.Buffer
	err := run([]string{
		"branch-delete",
		"--endpoint", server.URL,
		"--project", "proj_remote",
		"--repo", repo,
		"--branch", "preserved/branch",
	}, server.Client(), &output)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/worktrees/branches/remote-removals" {
		t.Fatalf("unexpected path %q", gotPath)
	}
	if got.ProjectID != "proj_remote" || got.BranchName != "preserved/branch" {
		t.Fatalf("unexpected payload: %#v", got)
	}
}

func TestRunBranchDeleteRejectsStaleHead(t *testing.T) {
	repo := initTestRepo(t)
	runRepoGit(t, repo, "branch", "keep/me")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("no completion must be posted for a rejected delete")
	}))
	defer server.Close()
	err := run([]string{
		"branch-delete",
		"--endpoint", server.URL,
		"--project", "proj_remote",
		"--repo", repo,
		"--branch", "keep/me",
		"--expected-head", "1111111111111111111111111111111111111111",
	}, server.Client(), io.Discard)
	if err == nil {
		t.Fatal("expected stale-head delete to be rejected")
	}
}
