package runtimecore

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// runTextGenerationTestGit runs a git command against repoPath, failing the
// test on error (mirrors the Rust test helper's run_git in
// source_control_text_generation.rs).
func runTextGenerationTestGit(t *testing.T, repoPath string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", repoPath}, args...)...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %s: %v", args, string(output), err)
	}
}

func initTextGenerationTestRepo(t *testing.T) string {
	t.Helper()
	repoPath := t.TempDir()
	runTextGenerationTestGit(t, repoPath, "init", "-b", "main")
	runTextGenerationTestGit(t, repoPath, "config", "user.email", "pebble@example.test")
	runTextGenerationTestGit(t, repoPath, "config", "user.name", "Pebble Test")
	if err := os.WriteFile(filepath.Join(repoPath, "README.md"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runTextGenerationTestGit(t, repoPath, "add", "README.md")
	runTextGenerationTestGit(t, repoPath, "commit", "-m", "Initialize project")
	return repoPath
}

func TestBuildGitCommitTextGenerationContextReadsStagedDiff(t *testing.T) {
	repoPath := initTextGenerationTestRepo(t)
	if err := os.WriteFile(filepath.Join(repoPath, "README.md"), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runTextGenerationTestGit(t, repoPath, "add", "README.md")

	result, err := BuildGitCommitTextGenerationContext(context.Background(), repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if result.Branch == nil || *result.Branch != "main" {
		t.Fatalf("expected branch main, got %+v", result.Branch)
	}
	if !strings.Contains(result.StagedSummary, "README.md") {
		t.Fatalf("expected staged summary to mention README.md, got %q", result.StagedSummary)
	}
	if !strings.Contains(result.StagedPatch, "+two") {
		t.Fatalf("expected staged patch to contain +two, got %q", result.StagedPatch)
	}
}

func TestBuildGitCommitTextGenerationContextRequiresRepoPath(t *testing.T) {
	if _, err := BuildGitCommitTextGenerationContext(context.Background(), "  "); err == nil {
		t.Fatal("expected error for empty repo path")
	}
}

func TestBuildGitPullRequestTextGenerationContextReadsBranchDiff(t *testing.T) {
	repoPath := initTextGenerationTestRepo(t)
	runTextGenerationTestGit(t, repoPath, "checkout", "-b", "feature/native-generation")
	if err := os.WriteFile(filepath.Join(repoPath, "README.md"), []byte("one\nfeature\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runTextGenerationTestGit(t, repoPath, "add", "README.md")
	runTextGenerationTestGit(t, repoPath, "commit", "-m", "Add native generation")

	result, err := BuildGitPullRequestTextGenerationContext(
		context.Background(), repoPath, "main", "Draft", "", false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if result == nil {
		t.Fatal("expected a pull request context for a diverged branch")
	}
	if result.Branch == nil || *result.Branch != "feature/native-generation" {
		t.Fatalf("expected branch feature/native-generation, got %+v", result.Branch)
	}
	if result.Base != "main" {
		t.Fatalf("expected base main, got %q", result.Base)
	}
	if !strings.Contains(result.CommitSummary, "Add native generation") {
		t.Fatalf("expected commit summary content, got %q", result.CommitSummary)
	}
	if !strings.Contains(result.ChangeSummary, "README.md") {
		t.Fatalf("expected change summary content, got %q", result.ChangeSummary)
	}
	if !strings.Contains(result.Patch, "+feature") {
		t.Fatalf("expected patch content, got %q", result.Patch)
	}
}

func TestBuildGitPullRequestTextGenerationContextNoDivergenceReturnsNil(t *testing.T) {
	repoPath := initTextGenerationTestRepo(t)
	result, err := BuildGitPullRequestTextGenerationContext(
		context.Background(), repoPath, "main", "", "", false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if result != nil {
		t.Fatalf("expected nil context when branch does not differ from base, got %+v", result)
	}
}

func TestBuildGitPullRequestTextGenerationContextRejectsEmptyBase(t *testing.T) {
	repoPath := initTextGenerationTestRepo(t)
	result, err := BuildGitPullRequestTextGenerationContext(context.Background(), repoPath, "  ", "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if result != nil {
		t.Fatalf("expected nil context for blank base, got %+v", result)
	}
}

func TestResolveGitComparisonBasePrefersQualifiedRemoteBranch(t *testing.T) {
	base, target := resolveGitComparisonBase("origin/main", []string{"origin"}, []string{"origin/main"})
	if base != "origin/main" {
		t.Fatalf("expected origin/main, got %q", base)
	}
	if target == nil || target.Remote != "origin" || target.Branch != "main" {
		t.Fatalf("expected parsed remote branch, got %+v", target)
	}
}

func TestResolveGitComparisonBaseFallsBackToUnqualifiedName(t *testing.T) {
	base, target := resolveGitComparisonBase("nonexistent", nil, nil)
	if base != "nonexistent" {
		t.Fatalf("expected passthrough base, got %q", base)
	}
	if target != nil {
		t.Fatalf("expected no fetch target, got %+v", target)
	}
}
