package runtimehttp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestLegacySharedControlAiVaultScansPairedHostLocally(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{manager: manager}
	raw, _ := json.Marshal(runtimecore.AiVaultListRequest{
		Limit:              7,
		ExecutionHostScope: "all",
		ScopePaths:         []string{"/workspace"},
	})
	value, handled, err := server.runLegacySharedControlAiVaultMethod(context.Background(), "aiVault.listSessions", raw)
	if err != nil || !handled {
		t.Fatalf("unexpected AI Vault dispatch: handled=%v err=%v", handled, err)
	}
	result := value.(runtimecore.AiVaultListResult)
	for _, issue := range result.Issues {
		if issue.ExecutionHostID != "local" {
			t.Fatalf("paired scan escaped local host: %#v", issue)
		}
	}
}

func TestLegacySharedControlAiVaultIgnoresOtherMethods(t *testing.T) {
	server := &Server{}
	if _, handled, err := server.runLegacySharedControlAiVaultMethod(context.Background(), "other.method", nil); handled || err != nil {
		t.Fatalf("unexpected unrelated method handling: handled=%v err=%v", handled, err)
	}
}
