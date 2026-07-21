package runtimecore

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestHostGitBaseRefsUsePairedRuntimeRepository(t *testing.T) {
	repo := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	runGitCommand(t, repo, "init", "-b", "main")
	runGitCommand(t, repo, "config", "user.email", "dev@example.test")
	runGitCommand(t, repo, "config", "user.name", "Dev")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("test\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGitCommand(t, repo, "add", "README.md")
	runGitCommand(t, repo, "commit", "-m", "init")
	runGitCommand(t, repo, "branch", "feature/search-me")

	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Path: repo, LocationKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	base, err := manager.HostGitBaseRefDefault(context.Background(), project.ID)
	if err != nil || base.DefaultBaseRef == nil || *base.DefaultBaseRef != "main" {
		t.Fatalf("unexpected base result %#v err=%v", base, err)
	}
	refs, truncated, err := manager.SearchHostGitBaseRefs(context.Background(), project.ID, "search-me", 10)
	if err != nil || truncated || len(refs) != 1 || refs[0].RefName != "feature/search-me" {
		t.Fatalf("unexpected refs %#v truncated=%v err=%v", refs, truncated, err)
	}
}
