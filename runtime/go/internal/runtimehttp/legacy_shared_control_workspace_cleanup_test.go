package runtimehttp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestLegacySharedControlWorkspaceCleanupDispatch(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{manager: manager}

	scanRaw, _ := json.Marshal(runtimecore.WorkspaceCleanupScanRequest{ScanID: "remote-scan"})
	value, handled, err := server.runLegacySharedControlWorkspaceCleanupMethod(context.Background(), "workspaceCleanup.scan", scanRaw)
	if err != nil || !handled {
		t.Fatalf("unexpected scan dispatch: handled=%v err=%v", handled, err)
	}
	if value.(runtimecore.WorkspaceCleanupScanResult).Candidates == nil {
		t.Fatal("expected canonical empty candidate list")
	}

	connectionID := "desktop-connection-must-not-loop"
	processRaw, _ := json.Marshal(runtimecore.WorkspaceCleanupLocalProcessRequest{WorktreeID: "wt-1", ConnectionID: &connectionID})
	_, handled, err = server.runLegacySharedControlWorkspaceCleanupMethod(context.Background(), "workspaceCleanup.processes", processRaw)
	if err != nil || !handled {
		t.Fatalf("unexpected process dispatch: handled=%v err=%v", handled, err)
	}
}

func TestLegacySharedControlWorkspaceCleanupIgnoresOtherMethods(t *testing.T) {
	server := &Server{}
	if _, handled, err := server.runLegacySharedControlWorkspaceCleanupMethod(context.Background(), "other.method", nil); handled || err != nil {
		t.Fatalf("unexpected unrelated method handling: handled=%v err=%v", handled, err)
	}
}
