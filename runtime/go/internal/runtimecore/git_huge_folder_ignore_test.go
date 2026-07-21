package runtimecore

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func TestGitHugeFolderIgnoreFlow(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	repo := t.TempDir()
	if output, err := exec.Command("git", "-C", repo, "init").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, output)
	}
	for _, name := range []string{"node_modules", "dist"} {
		if err := os.Mkdir(filepath.Join(repo, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(repo, ".gitignore"), []byte("dist/\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: repo})
	if err != nil {
		t.Fatal(err)
	}
	req := GitHugeFolderRequest{ProjectID: project.ID}
	folders, err := manager.GitFindHugeFoldersToIgnore(context.Background(), req)
	if err != nil || len(folders) != 1 || folders[0] != "node_modules" {
		t.Fatalf("unexpected candidates: %v, %v", folders, err)
	}
	written, err := manager.GitAppendHugeFolderToIgnore(context.Background(), GitHugeFolderRequest{ProjectID: project.ID, FolderName: "node_modules"})
	if err != nil || !written {
		t.Fatalf("append failed: written=%v err=%v", written, err)
	}
	written, err = manager.GitAppendHugeFolderToIgnore(context.Background(), GitHugeFolderRequest{ProjectID: project.ID, FolderName: "node_modules"})
	if err != nil || written {
		t.Fatalf("duplicate append should be skipped: written=%v err=%v", written, err)
	}
	if _, err := manager.GitAppendHugeFolderToIgnore(context.Background(), GitHugeFolderRequest{ProjectID: project.ID, FolderName: "node_modules\n.env"}); err == nil {
		t.Fatal("expected injected folder name to be rejected")
	}
}

func TestGitAppendHugeFolderRejectsSymlinkedGitignore(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires privileges on Windows")
	}
	repo := t.TempDir()
	target := filepath.Join(t.TempDir(), "outside")
	if err := os.Symlink(target, filepath.Join(repo, ".gitignore")); err != nil {
		t.Fatal(err)
	}
	manager, _ := NewManager(t.TempDir(), nil)
	project, _ := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: repo})
	if _, err := manager.GitAppendHugeFolderToIgnore(context.Background(), GitHugeFolderRequest{ProjectID: project.ID, FolderName: "target"}); err == nil {
		t.Fatal("expected symlinked .gitignore to be rejected")
	}
}
