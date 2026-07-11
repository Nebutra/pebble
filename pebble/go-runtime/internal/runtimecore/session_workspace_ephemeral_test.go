package runtimecore

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveEphemeralSessionStartRequestUsesHomeDirectory(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}

	resolved, err := resolveEphemeralSessionStartRequest(StartSessionRequest{Ephemeral: true})
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Cwd != filepath.Clean(home) {
		t.Fatalf("expected cwd %q, got %q", filepath.Clean(home), resolved.Cwd)
	}
}

func TestResolveEphemeralSessionStartRequestRejectsProjectBinding(t *testing.T) {
	_, err := resolveEphemeralSessionStartRequest(StartSessionRequest{
		Ephemeral: true,
		ProjectID: "project-1",
	})
	if err == nil {
		t.Fatal("expected project-bound ephemeral session to be rejected")
	}
}

func TestResolveEphemeralSessionStartRequestRejectsCwdOutsideHome(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	outside := filepath.Dir(filepath.Clean(home))
	if outside == filepath.Clean(home) {
		t.Skip("home directory has no parent")
	}

	_, err = resolveEphemeralSessionStartRequest(StartSessionRequest{
		Ephemeral: true,
		Cwd:       outside,
	})
	if err == nil {
		t.Fatal("expected cwd outside home to be rejected")
	}
}
