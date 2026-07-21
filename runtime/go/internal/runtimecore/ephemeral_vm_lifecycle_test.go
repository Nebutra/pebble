//go:build !windows

package runtimecore

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestEphemeralVMLifecyclePersistsProvisionAttachAndCleanup(t *testing.T) {
	storeDir := t.TempDir()
	repo := t.TempDir()
	configuration := `environmentRecipes:
  - id: local
    name: Local test
    create: >-
      printf '{"schemaVersion":1,"connection":{"type":"ssh","target":{"label":"test","host":"127.0.0.1","port":22,"username":"dev"},"projectRoot":"/workspace"}}'
    destroy: cat >/dev/null
`
	if err := os.WriteFile(filepath.Join(repo, "pebble.yaml"), []byte(configuration), 0o600); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(storeDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: repo})
	if err != nil {
		t.Fatal(err)
	}
	result := manager.ProvisionEphemeralVM(context.Background(), EphemeralVMProvisionRequest{RepoID: project.ID, RecipeID: "local", WorkspaceName: "parallel"})
	if !result.OK || result.Runtime == nil || result.ConnectionType != "ssh" {
		t.Fatalf("unexpected provision result: %#v", result)
	}
	attached, err := manager.AttachEphemeralVMWorkspace(result.Runtime.ID, "workspace-1")
	if err != nil || attached.WorkspaceID != "workspace-1" {
		t.Fatalf("attach failed: %#v %v", attached, err)
	}
	cleaned, err := manager.RunEphemeralVMLifecycle(context.Background(), result.Runtime.ID, "destroy")
	if err != nil || cleaned.Status != "cleaned" || cleaned.CleanupStatus != "succeeded" {
		t.Fatalf("cleanup failed: %#v %v", cleaned, err)
	}
	reloaded, err := NewManager(storeDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	runtimes, err := reloaded.ListEphemeralVMRuntimes()
	if err != nil || len(runtimes) != 1 || runtimes[0].Status != "cleaned" {
		t.Fatalf("runtime did not persist: %#v %v", runtimes, err)
	}
}

func TestEphemeralVMProvisionDiagnosticsRedactPairingCode(t *testing.T) {
	input := "connect pebble://pair?code=abc_DEF-123 now"
	if got := redactEphemeralVMText(input); got != "connect pebble://pair?code=[redacted] now" {
		t.Fatalf("pairing code leaked: %q", got)
	}
}
