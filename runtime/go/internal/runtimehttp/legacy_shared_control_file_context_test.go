package runtimehttp

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestLegacySharedControlFileMethodsForwardConnectionCancellation(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	target, err := manager.CreateSshTarget(runtimecore.SshTargetInput{Host: "legacy-files.example"})
	if err != nil {
		t.Fatal(err)
	}
	remotePath := filepath.Join(t.TempDir(), "remote-worktree")
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{
		Name: "remote", Path: remotePath, LocationKind: "ssh", HostID: target.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := manager.CreateWorktree(context.Background(), runtimecore.CreateWorktreeRequest{
		ProjectID: project.ID, Path: remotePath, Branch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	server := NewServer(manager)

	for _, method := range []string{"files.search", "files.read"} {
		t.Run(method, func(t *testing.T) {
			params, err := json.Marshal(map[string]interface{}{
				"worktree": "id:" + worktree.ID, "relativePath": "README.md", "query": "needle",
			})
			if err != nil {
				t.Fatal(err)
			}
			_, handled, err := server.runLegacySharedControlFileMethod(ctx, method, params)
			if !handled {
				t.Fatal("expected file method to be handled")
			}
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("expected connection cancellation, got %v", err)
			}
		})
	}
}
