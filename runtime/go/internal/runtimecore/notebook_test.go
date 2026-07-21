package runtimecore

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestNotebookRunsPythonRelativeToFile(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 is unavailable")
	}
	directory := t.TempDir()
	filePath := filepath.Join(directory, "analysis.py")
	if err := os.WriteFile(filePath, []byte("# notebook"), 0o600); err != nil {
		t.Fatal(err)
	}
	manager := &Manager{projects: map[string]Project{
		"project-1": {ID: "project-1", Path: directory, LocationKind: "local"},
	}}
	result, err := manager.RunNotebookPythonCell(context.Background(), NotebookRunPythonCellRequest{
		FilePath: filePath,
		Preamble: "value = 40",
		Code:     "print(value + 2)",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode == nil || *result.ExitCode != 0 || result.Stdout != "42\n" {
		t.Fatalf("unexpected notebook result: %#v", result)
	}
}

func TestNotebookCancellationTerminatesPython(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 is unavailable")
	}
	directory := t.TempDir()
	filePath := filepath.Join(directory, "analysis.py")
	if err := os.WriteFile(filePath, []byte("# notebook"), 0o600); err != nil {
		t.Fatal(err)
	}
	manager := &Manager{projects: map[string]Project{
		"project-1": {ID: "project-1", Path: directory, LocationKind: "local"},
	}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan NotebookRunResult, 1)
	go func() {
		result, _ := manager.RunNotebookPythonCell(ctx, NotebookRunPythonCellRequest{
			FilePath: filePath,
			Code:     "import time; time.sleep(30)",
		})
		done <- result
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case result := <-done:
		if result.Error == "" {
			t.Fatalf("expected canceled notebook result: %#v", result)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("canceled notebook process did not terminate")
	}
}

func TestNotebookRejectsFileOutsideRegisteredWorkspaces(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "analysis.py")
	if err := os.WriteFile(filePath, []byte("# notebook"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := (&Manager{projects: map[string]Project{}}).RunNotebookPythonCell(
		context.Background(),
		NotebookRunPythonCellRequest{FilePath: filePath, Code: "print(1)"},
	)
	if err == nil {
		t.Fatal("expected an authorization error")
	}
}

func TestNotebookRejectsRemoteExecution(t *testing.T) {
	connectionID := "ssh-1"
	result, err := (&Manager{}).RunNotebookPythonCell(context.Background(), NotebookRunPythonCellRequest{
		FilePath:     "/remote/notebook.py",
		Code:         "print(1)",
		ConnectionID: &connectionID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Error == "" {
		t.Fatal("expected an explicit remote execution gap")
	}
}

func TestBoundedNotebookCaptureTruncates(t *testing.T) {
	capture := &boundedNotebookCapture{}
	chunk := make([]byte, notebookCaptureLimit+1)
	if _, err := capture.Write(chunk); err != nil {
		t.Fatal(err)
	}
	if !capture.truncated || len(capture.String()) <= notebookCaptureLimit {
		t.Fatal("expected bounded capture truncation marker")
	}
}
