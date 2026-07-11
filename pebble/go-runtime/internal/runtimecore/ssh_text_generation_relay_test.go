package runtimecore

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// writeFakeSshWithStdout writes a fake ssh binary that ignores its connection
// args and prints the given stdout, exiting with the given code. Used to test
// the relay-worker exec path without a real SSH host or a deployed relay
// worker binary.
func writeFakeSshWithStdout(t *testing.T, exitCode int, stdout string, stderr string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake ssh fixture uses a POSIX shell script")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "ssh")
	script := "#!/bin/sh\n"
	if stdout != "" {
		script += "printf %s " + shellQuote(stdout) + "\n"
	}
	if stderr != "" {
		script += "echo " + shellQuote(stderr) + " 1>&2\n"
	}
	script += "exit " + itoa(exitCode) + "\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestFetchSshGitCommitTextGenerationContextParsesStdout(t *testing.T) {
	manager, _ := newSshTestManager(t)
	created, err := manager.CreateSshTarget(SshTargetInput{Host: "remote.example", Username: "deploy"})
	if err != nil {
		t.Fatal(err)
	}
	stdout := `{"branch":"main","stagedSummary":"M\tREADME.md","stagedPatch":"diff --git a/README.md b/README.md\n+two"}`
	t.Setenv("PEBBLE_SYSTEM_SSH_PATH", writeFakeSshWithStdout(t, 0, stdout, ""))

	result, err := manager.FetchSshGitCommitTextGenerationContext(context.Background(), created.ID, "/remote/repo")
	if err != nil {
		t.Fatal(err)
	}
	if result.Branch == nil || *result.Branch != "main" {
		t.Fatalf("expected branch main, got %+v", result.Branch)
	}
	if !strings.Contains(result.StagedSummary, "README.md") {
		t.Fatalf("expected staged summary to carry README.md, got %q", result.StagedSummary)
	}
	if !strings.Contains(result.StagedPatch, "+two") {
		t.Fatalf("expected staged patch content, got %q", result.StagedPatch)
	}
}

func TestFetchSshGitPullRequestTextGenerationContextParsesStdout(t *testing.T) {
	manager, _ := newSshTestManager(t)
	created, err := manager.CreateSshTarget(SshTargetInput{Host: "remote.example", Username: "deploy"})
	if err != nil {
		t.Fatal(err)
	}
	stdout := `{"branch":"feature/x","base":"main","branchChangedByPreparation":false,"currentTitle":"","currentBody":"","currentDraft":false,"commitSummary":"- Add x","changeSummary":"M\tfile.go","patch":"diff --git a/file.go b/file.go\n+x"}`
	t.Setenv("PEBBLE_SYSTEM_SSH_PATH", writeFakeSshWithStdout(t, 0, stdout, ""))

	result, err := manager.FetchSshGitPullRequestTextGenerationContext(
		context.Background(), created.ID, "/remote/repo", "main", "", "", false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if result == nil {
		t.Fatal("expected non-nil pull request context")
	}
	if result.Base != "main" || result.Branch == nil || *result.Branch != "feature/x" {
		t.Fatalf("unexpected context: %+v", result)
	}
	if !strings.Contains(result.CommitSummary, "Add x") {
		t.Fatalf("expected commit summary content, got %q", result.CommitSummary)
	}
}

func TestFetchSshGitPullRequestTextGenerationContextHandlesNull(t *testing.T) {
	manager, _ := newSshTestManager(t)
	created, err := manager.CreateSshTarget(SshTargetInput{Host: "remote.example"})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PEBBLE_SYSTEM_SSH_PATH", writeFakeSshWithStdout(t, 0, "null", ""))

	result, err := manager.FetchSshGitPullRequestTextGenerationContext(
		context.Background(), created.ID, "/remote/repo", "main", "", "", false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if result != nil {
		t.Fatalf("expected nil context when relay worker reports nothing to summarize, got %+v", result)
	}
}

func TestFetchSshGitCommitTextGenerationContextSurfacesFailure(t *testing.T) {
	manager, _ := newSshTestManager(t)
	created, err := manager.CreateSshTarget(SshTargetInput{Host: "remote.example"})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PEBBLE_SYSTEM_SSH_PATH", writeFakeSshWithStdout(t, 1, "", "repository path is required"))

	if _, err := manager.FetchSshGitCommitTextGenerationContext(context.Background(), created.ID, "/remote/repo"); err == nil {
		t.Fatal("expected error to be surfaced")
	} else if !strings.Contains(err.Error(), "repository path is required") {
		t.Fatalf("expected relay worker stderr detail, got %v", err)
	}
}

func TestFetchSshGitCommitTextGenerationContextUnknownTarget(t *testing.T) {
	manager, _ := newSshTestManager(t)
	if _, err := manager.FetchSshGitCommitTextGenerationContext(context.Background(), "missing", "/repo"); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestQuoteRemoteCommandEscapesSingleQuotes(t *testing.T) {
	quoted := quoteRemoteCommand("pebble-relay-worker", []string{"--current-title", "it's a title"})
	if !strings.Contains(quoted, `'it'\''s a title'`) {
		t.Fatalf("expected escaped single quote in %q", quoted)
	}
}
