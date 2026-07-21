package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestGitWorktreeCreateRecordsRemoteCreatedBaseSHA(t *testing.T) {
	repo, createdSHA := createRelayGitRepository(t)
	worktreePath := filepath.Join(t.TempDir(), "feature")
	var output bytes.Buffer
	if err := runGitWorktreeCreateJSON([]string{
		"--root", repo, "--path", worktreePath, "--branch", "feature", "--base", "main",
	}, &output); err != nil {
		t.Fatal(err)
	}
	var result gitWorktreeCreateResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.CreatedBaseSHA != createdSHA {
		t.Fatalf("created base SHA = %q, want %q", result.CreatedBaseSHA, createdSHA)
	}
	if got := relayGitOutput(t, worktreePath, "branch", "--show-current"); got != "feature" {
		t.Fatalf("created branch = %q", got)
	}
}

func TestGitBaseStatusRunsAgainstRelayWorkspace(t *testing.T) {
	repo, createdSHA := createRelayGitRepository(t)
	if err := os.WriteFile(filepath.Join(repo, "second.txt"), []byte("second\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	relayGit(t, repo, "add", "second.txt")
	relayGit(t, repo, "commit", "-m", "second")
	input, err := json.Marshal(runtimecore.GitBaseStatusRequest{
		BaseRef: "main", CreatedBaseSHA: createdSHA, BranchName: "feature",
	})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := runGitBaseStatusJSON([]string{"--root", repo}, bytes.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	var result runtimecore.GitBaseStatusResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Status != "drift" || result.Behind != 1 {
		t.Fatalf("unexpected relay base status: %#v", result)
	}
	if len(result.RecentSubjects) != 1 || result.RecentSubjects[0] != "second" {
		t.Fatalf("unexpected subjects: %#v", result.RecentSubjects)
	}
}

func createRelayGitRepository(t *testing.T) (string, string) {
	t.Helper()
	repo := t.TempDir()
	relayGit(t, repo, "init", "-b", "main")
	relayGit(t, repo, "config", "user.email", "dev@example.test")
	relayGit(t, repo, "config", "user.name", "Dev")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("first\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	relayGit(t, repo, "add", "README.md")
	relayGit(t, repo, "commit", "-m", "first")
	return repo, relayGitOutput(t, repo, "rev-parse", "HEAD")
}

func relayGit(t *testing.T, repo string, args ...string) {
	t.Helper()
	_ = relayGitOutput(t, repo, args...)
}

func relayGitOutput(t *testing.T, repo string, args ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", repo}, args...)...)
	command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, output)
	}
	return string(bytes.TrimSpace(output))
}
