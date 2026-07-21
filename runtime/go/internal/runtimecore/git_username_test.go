package runtimecore

import (
	"os/exec"
	"testing"
)

func TestProjectGitUsernameUsesExplicitRepositoryConfig(t *testing.T) {
	repo := t.TempDir()
	if err := exec.Command("git", "-C", repo, "init").Run(); err != nil {
		t.Fatal(err)
	}
	if err := exec.Command("git", "-C", repo, "config", "github.user", "12345+pebble-dev@example.test").Run(); err != nil {
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
	username, err := manager.ProjectGitUsername(project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if username != "pebble-dev" {
		t.Fatalf("unexpected username %q", username)
	}
}

func TestNormalizeGitUsername(t *testing.T) {
	for input, expected := range map[string]string{
		" demo ":                  "demo",
		"demo@example.test":       "demo",
		"12345+demo@example.test": "demo",
		"team+demo":               "team+demo",
	} {
		if actual := normalizeGitUsername(input); actual != expected {
			t.Fatalf("normalizeGitUsername(%q) = %q, want %q", input, actual, expected)
		}
	}
}
