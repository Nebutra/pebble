package runtimecore

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestProjectConfigurationReadsHooksAndWritesIssueOverride(t *testing.T) {
	repo := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "pebble.yaml"), []byte("scripts:\n  setup: pnpm install\nissueCommand: shared command\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Path: repo, LocationKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	hooks, err := manager.CheckProjectHooks(context.Background(), project.ID)
	if err != nil || !hooks.HasHooks || hooks.Hooks["issueCommand"] != "shared command" {
		t.Fatalf("unexpected hooks %#v err=%v", hooks, err)
	}
	if err := manager.WriteProjectIssueCommand(context.Background(), project.ID, "local command"); err != nil {
		t.Fatal(err)
	}
	resolved, err := manager.ReadProjectIssueCommand(context.Background(), project.ID)
	if err != nil || resolved.Source != "local" || resolved.EffectiveContent == nil || *resolved.EffectiveContent != "local command" {
		t.Fatalf("unexpected issue command %#v err=%v", resolved, err)
	}
	ignored, err := os.ReadFile(filepath.Join(repo, ".gitignore"))
	if err != nil || string(ignored) != ".pebble/\n" {
		t.Fatalf("unexpected gitignore %q err=%v", ignored, err)
	}
}
