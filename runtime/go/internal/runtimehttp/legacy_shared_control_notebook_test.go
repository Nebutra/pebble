package runtimehttp

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestLegacySharedControlNotebookExecutesOnRuntimeHost(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 is unavailable")
	}
	root := t.TempDir()
	notebook := filepath.Join(root, "notebook.ipynb")
	if err := os.WriteFile(notebook, []byte(`{"cells":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "Remote", Path: root, LocationKind: "local"}); err != nil {
		t.Fatal(err)
	}
	server := &Server{manager: manager}
	connectionID := "desktop-connection-must-not-loop"
	raw, _ := json.Marshal(runtimecore.NotebookRunPythonCellRequest{
		FilePath: notebook, Preamble: "value = 40", Code: "print(value + 2)", ConnectionID: &connectionID,
	})
	value, handled, err := server.runLegacySharedControlNotebookMethod(context.Background(), "notebook.runPythonCell", raw)
	if err != nil || !handled {
		t.Fatalf("unexpected notebook dispatch: handled=%v err=%v", handled, err)
	}
	result := value.(runtimecore.NotebookRunResult)
	if result.ExitCode == nil || *result.ExitCode != 0 || result.Stdout != "42\n" {
		t.Fatalf("unexpected notebook result: %#v", result)
	}
}

func TestLegacySharedControlNotebookIgnoresOtherMethods(t *testing.T) {
	server := &Server{}
	if _, handled, err := server.runLegacySharedControlNotebookMethod(context.Background(), "other.method", nil); handled || err != nil {
		t.Fatalf("unexpected unrelated method handling: handled=%v err=%v", handled, err)
	}
}
