package runtimecore

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestSetupScriptImportsDetectAllProjectFormats(t *testing.T) {
	repo := filepath.Join(t.TempDir(), "repo")
	for _, directory := range []string{".git", ".superset", ".codex/environments", ".cmux"} {
		if err := os.MkdirAll(filepath.Join(repo, directory), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		".superset/config.json":                `{"setup":"superset setup"}`,
		"conductor.json":                       `{"scripts":{"setup":"conductor setup"}}`,
		".codex/environments/environment.toml": "[setup]\nscript = \"codex setup\"\n",
		".cmux/cmux.json":                      `{"commands":[{"name":"setup","command":"cmux setup"}]}`,
		"package.json":                         `{"packageManager":"pnpm@10"}`,
	}
	for path, content := range files {
		if err := os.WriteFile(filepath.Join(repo, filepath.FromSlash(path)), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Path: repo, LocationKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	candidates, err := manager.InspectProjectSetupScriptImports(context.Background(), project.ID)
	if err != nil || len(candidates) != 5 {
		t.Fatalf("unexpected candidates %#v err=%v", candidates, err)
	}
}
