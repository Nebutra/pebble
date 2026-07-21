package runtimecore

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestCreateProjectOnHostInitializesRepository(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is required")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	for _, args := range [][]string{{"config", "--global", "user.name", "Pebble Test"}, {"config", "--global", "user.email", "pebble@example.test"}} {
		if output, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git config failed: %s: %v", output, err)
		}
	}
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	parent := filepath.Join(t.TempDir(), "projects")
	project, err := manager.CreateProjectOnHost(context.Background(), parent, "created", "git")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(project.Path, ".git")); err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command("git", "-C", project.Path, "log", "-1", "--format=%s").Output()
	if err != nil || string(output) != "Initial commit\n" {
		t.Fatalf("unexpected initial commit %q err=%v", output, err)
	}
}
