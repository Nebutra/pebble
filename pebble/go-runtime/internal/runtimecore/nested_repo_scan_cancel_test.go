package runtimecore

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func makeNestedRepoFixture(t *testing.T) (string, []string) {
	t.Helper()
	parent := t.TempDir()
	repos := make([]string, 0, 2)
	for _, name := range []string{"api", "web"} {
		repoPath := filepath.Join(parent, name)
		if err := os.MkdirAll(filepath.Join(repoPath, ".git"), 0o755); err != nil {
			t.Fatal(err)
		}
		repos = append(repos, repoPath)
	}
	return parent, repos
}

// TestScanNestedReposContextCancelProducesStoppedResult proves a cancelled
// request context aborts the walk with the same partial `stopped` result the
// Electron AbortSignal cancel flow produces, instead of an error.
func TestScanNestedReposContextCancelProducesStoppedResult(t *testing.T) {
	parent, _ := makeNestedRepoFixture(t)
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	scan, err := manager.ScanNestedRepos(ctx, NestedRepoScanRequest{Path: parent})
	if err != nil {
		t.Fatalf("expected stopped result, got error: %v", err)
	}
	if !scan.Stopped {
		t.Fatalf("expected stopped=true after ctx cancel, got %#v", scan)
	}
	if scan.TimedOut || scan.Truncated {
		t.Fatalf("cancel must not masquerade as timeout/truncation: %#v", scan)
	}
	if len(scan.Repos) != 0 {
		t.Fatalf("expected no repos after immediate cancel, got %#v", scan.Repos)
	}
}

// TestScanNestedReposUncancelledContextFindsRepos guards the ctx plumbing:
// a live context must not change the existing scan behavior.
func TestScanNestedReposUncancelledContextFindsRepos(t *testing.T) {
	parent, repos := makeNestedRepoFixture(t)
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	scan, err := manager.ScanNestedRepos(context.Background(), NestedRepoScanRequest{Path: parent})
	if err != nil {
		t.Fatal(err)
	}
	if scan.Stopped {
		t.Fatalf("live context must not stop the scan: %#v", scan)
	}
	if len(scan.Repos) != len(repos) {
		t.Fatalf("expected %d repos, got %#v", len(repos), scan.Repos)
	}
}

// TestImportNestedReposContextCancelImportsNothing proves a cancelled request
// aborts the nested import without creating projects or leaving groups behind.
func TestImportNestedReposContextCancelImportsNothing(t *testing.T) {
	parent, repos := makeNestedRepoFixture(t)
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result, err := manager.ImportNestedRepos(ctx, ProjectGroupImportNestedRequest{
		ParentPath:   parent,
		GroupName:    "Platform",
		ProjectPaths: repos,
		Mode:         "group",
	})
	if err != nil {
		t.Fatalf("expected failed-entry result, got error: %v", err)
	}
	if result.ImportedCount != 0 || result.AlreadyKnownCount != 0 {
		t.Fatalf("cancelled import must not import: %#v", result)
	}
	if result.FailedCount != len(repos) {
		t.Fatalf("expected all %d paths failed, got %#v", len(repos), result)
	}
	if len(manager.ListProjects()) != 0 {
		t.Fatalf("cancelled import must not create projects: %#v", manager.ListProjects())
	}
	if len(manager.ListProjectGroups()) != 0 {
		t.Fatalf("cancelled import must not leave groups behind: %#v", manager.ListProjectGroups())
	}
}
