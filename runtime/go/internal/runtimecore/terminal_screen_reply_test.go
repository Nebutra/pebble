package runtimecore

import (
	"context"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Why: the screen emulator answers terminal queries by writing into an internal
// pipe. Nothing read that pipe, so the first query from a full-screen program
// blocked the writer — inside Write, on the goroutine draining the PTY. The
// session then stopped reading its own output and the program never finished
// starting: `claude`, and anything else that asks the terminal a question,
// simply hung with a blank pane.
func TestSessionKeepsReadingAfterATerminalQuery(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a POSIX shell to emit the query")
	}
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}

	// OSC 11 asks for the background colour — the first thing a TUI sends, and
	// the query that deadlocked the reader.
	session, err := manager.StartSession(context.Background(), StartSessionRequest{
		ProjectID: project.ID,
		Cwd:       project.Path,
		Command: []string{
			"/bin/sh",
			"-c",
			`printf '\033]11;?\007'; printf 'AFTER-QUERY\n'; sleep 1`,
		},
		Cols: 80,
		Rows: 24,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = manager.StopSession(session.ID) })

	deadline := time.Now().Add(10 * time.Second)
	for {
		tail, err := manager.TailSession(session.ID, 200)
		if err != nil {
			t.Fatal(err)
		}
		var seen strings.Builder
		for _, chunk := range tail.Chunks {
			seen.WriteString(chunk.Content)
		}
		if strings.Contains(seen.String(), "AFTER-QUERY") {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("output after a terminal query never arrived; the reader is stuck. saw %q", seen.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
}
