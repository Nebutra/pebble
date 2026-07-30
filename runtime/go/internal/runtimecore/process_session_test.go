package runtimecore

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type recordingSessionInput struct {
	strings.Builder
}

func (*recordingSessionInput) Close() error { return nil }

func testEchoCommand() []string {
	if runtime.GOOS == "windows" {
		return testWindowsShellCommand("/d", "/s", "/c", "echo pebble")
	}
	return []string{"/bin/sh", "-c", "printf 'pebble\n'"}
}

func testSleepCommand() []string {
	if runtime.GOOS == "windows" {
		return testWindowsShellCommand("/d", "/s", "/c", "ping -n 10 127.0.0.1 > NUL")
	}
	return []string{"/bin/sh", "-c", "sleep 10"}
}

func testWindowsShellCommand(arguments ...string) []string {
	// Why: some Windows CI images omit System32 from PATH even though ComSpec
	// still identifies the shell that ConPTY should launch.
	command := strings.TrimSpace(os.Getenv("ComSpec"))
	if command != "" {
		if resolved, err := exec.LookPath(command); err == nil {
			command = resolved
		} else {
			command = ""
		}
	}
	if command == "" {
		if systemRoot := strings.TrimSpace(os.Getenv("SystemRoot")); systemRoot != "" {
			candidate := filepath.Join(systemRoot, "System32", "cmd.exe")
			if _, err := os.Stat(candidate); err == nil {
				command = candidate
			}
		}
	}
	if command == "" {
		if resolved, err := exec.LookPath("cmd.exe"); err == nil {
			command = resolved
		} else {
			command = "cmd.exe"
		}
	}
	return append([]string{command}, arguments...)
}

func TestProcessSessionWaitForExitHandlingHonorsContext(t *testing.T) {
	session := &processSession{exitHandled: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if session.waitForExitHandling(ctx) {
		t.Fatal("exit handling wait ignored its context deadline")
	}
}

func TestProcessSessionWaitForExitHandlingObservesCompletion(t *testing.T) {
	exitHandled := make(chan struct{})
	close(exitHandled)
	session := &processSession{exitHandled: exitHandled}
	if !session.waitForExitHandling(context.Background()) {
		t.Fatal("completed exit handling was not observed")
	}
}

func TestProcessSessionWriteUsesPlatformEnterSequence(t *testing.T) {
	input := &recordingSessionInput{}
	session := &processSession{stdin: input, status: SessionRunning}

	if err := session.write(SessionInputRequest{Text: "echo pebble", AppendNewline: true}); err != nil {
		t.Fatal(err)
	}
	want := "echo pebble\n"
	if runtime.GOOS == "windows" {
		want = "echo pebble\r"
	}
	if got := input.String(); got != want {
		t.Fatalf("session input = %q, want %q", got, want)
	}
}
