package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func runRelayTestGit(t *testing.T, repoPath string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", repoPath}, args...)...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %s: %v", args, string(output), err)
	}
}

func initRelayTestRepo(t *testing.T) string {
	t.Helper()
	repoPath := t.TempDir()
	runRelayTestGit(t, repoPath, "init", "-b", "main")
	runRelayTestGit(t, repoPath, "config", "user.email", "pebble@example.test")
	runRelayTestGit(t, repoPath, "config", "user.name", "Pebble Test")
	if err := os.WriteFile(filepath.Join(repoPath, "README.md"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runRelayTestGit(t, repoPath, "add", "README.md")
	runRelayTestGit(t, repoPath, "commit", "-m", "Initialize project")
	return repoPath
}

func TestRunGitTextGenerationContextCommitPrintsStagedDiffJSON(t *testing.T) {
	repoPath := initRelayTestRepo(t)
	if err := os.WriteFile(filepath.Join(repoPath, "README.md"), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runRelayTestGit(t, repoPath, "add", "README.md")

	var output bytes.Buffer
	if err := run([]string{
		"git-text-generation-context",
		"--kind", "commit",
		"--root", repoPath,
	}, &http.Client{}, &output); err != nil {
		t.Fatal(err)
	}

	var result struct {
		Branch        *string `json:"branch"`
		StagedSummary string  `json:"stagedSummary"`
		StagedPatch   string  `json:"stagedPatch"`
	}
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatalf("expected valid JSON stdout, got %q: %v", output.String(), err)
	}
	if result.Branch == nil || *result.Branch != "main" {
		t.Fatalf("expected branch main, got %+v", result.Branch)
	}
	if !strings.Contains(result.StagedPatch, "+two") {
		t.Fatalf("expected staged patch content, got %q", result.StagedPatch)
	}
}

func TestRunGitTextGenerationContextPullRequestPrintsBranchDiffJSON(t *testing.T) {
	repoPath := initRelayTestRepo(t)
	runRelayTestGit(t, repoPath, "checkout", "-b", "feature/x")
	if err := os.WriteFile(filepath.Join(repoPath, "README.md"), []byte("one\nfeature\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runRelayTestGit(t, repoPath, "add", "README.md")
	runRelayTestGit(t, repoPath, "commit", "-m", "Add feature x")

	var output bytes.Buffer
	if err := run([]string{
		"git-text-generation-context",
		"--kind", "pull-request",
		"--root", repoPath,
		"--base", "main",
		"--current-title", "Draft",
	}, &http.Client{}, &output); err != nil {
		t.Fatal(err)
	}

	var result struct {
		Branch        *string `json:"branch"`
		Base          string  `json:"base"`
		CommitSummary string  `json:"commitSummary"`
	}
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatalf("expected valid JSON stdout, got %q: %v", output.String(), err)
	}
	if result.Branch == nil || *result.Branch != "feature/x" {
		t.Fatalf("expected branch feature/x, got %+v", result.Branch)
	}
	if result.Base != "main" {
		t.Fatalf("expected base main, got %q", result.Base)
	}
	if !strings.Contains(result.CommitSummary, "Add feature x") {
		t.Fatalf("expected commit summary content, got %q", result.CommitSummary)
	}
}

func TestRunGitTextGenerationContextPullRequestNoDivergencePrintsNull(t *testing.T) {
	repoPath := initRelayTestRepo(t)

	var output bytes.Buffer
	if err := run([]string{
		"git-text-generation-context",
		"--kind", "pull-request",
		"--root", repoPath,
		"--base", "main",
	}, &http.Client{}, &output); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(output.String()) != "null" {
		t.Fatalf("expected null JSON when branch does not diverge, got %q", output.String())
	}
}

func TestRunGitTextGenerationContextRejectsUnknownKind(t *testing.T) {
	repoPath := initRelayTestRepo(t)
	var output bytes.Buffer
	err := run([]string{
		"git-text-generation-context",
		"--kind", "unknown",
		"--root", repoPath,
	}, &http.Client{}, &output)
	if err == nil {
		t.Fatal("expected error for unknown kind")
	}
}
