package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunProjectCloneJSONClonesAndReturnsStructuredCompletion(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git unavailable")
	}
	source := filepath.Join(t.TempDir(), "source")
	if err := os.MkdirAll(source, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init"}, {"config", "user.email", "test@example.com"}, {"config", "user.name", "Test"}} {
		if output, err := exec.Command("git", append([]string{"-C", source}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v (%s)", args, err, output)
		}
	}
	if err := os.WriteFile(filepath.Join(source, "README.md"), []byte("clone"), 0o644); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command("git", "-C", source, "add", "README.md").CombinedOutput(); err != nil {
		t.Fatal(err, string(output))
	}
	if output, err := exec.Command("git", "-C", source, "commit", "-m", "initial").CombinedOutput(); err != nil {
		t.Fatal(err, string(output))
	}
	destination := t.TempDir()
	var output bytes.Buffer
	if err := runProjectCloneJSON([]string{"--url", source, "--destination", destination}, &output); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	var complete projectCloneEvent
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &complete); err != nil {
		t.Fatal(err)
	}
	if complete.Type != "complete" || complete.Name != "source" || complete.Path != filepath.Join(destination, "source") {
		t.Fatalf("unexpected completion: %#v", complete)
	}
	if _, err := os.Stat(filepath.Join(complete.Path, "README.md")); err != nil {
		t.Fatal(err)
	}
}

func TestParseCloneProgressOutput(t *testing.T) {
	phase, percent, ok := parseCloneProgressOutput("Receiving objects: 42% (42/100)")
	if !ok || phase != "Receiving objects" || percent != 42 {
		t.Fatalf("phase=%q percent=%d ok=%v", phase, percent, ok)
	}
	if _, err := expandCloneDestination("relative/path"); err == nil {
		t.Fatal("expected relative destination rejection")
	}
}
