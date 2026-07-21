package runtimecore

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestMissingRelayWorkerErrorDetection(t *testing.T) {
	for _, message := range []string{
		"sh: pebble-relay-worker: command not found",
		"sh: 1: pebble-relay-worker: not found",
		"exit status 127",
	} {
		if !isMissingRelayWorkerError(assertionError(message)) {
			t.Fatalf("expected %q to trigger relay deployment", message)
		}
	}
	if isMissingRelayWorkerError(assertionError("permission denied")) {
		t.Fatal("permission failures must not be mistaken for a missing worker")
	}
}

func TestQuoteRemoteWorkerCommandExpandsManagedHomePath(t *testing.T) {
	got := quoteRemoteWorkerCommand(remoteRelayWorkerPath, []string{"git-text-generation-context", "--root", "/tmp/a b"})
	want := `"$HOME"/'.pebble/bin/pebble-relay-worker' 'git-text-generation-context' '--root' '/tmp/a b'`
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestBoundedRelayOutputCapsBufferedBytes(t *testing.T) {
	output := boundedRelayOutput{limit: 4}
	written, err := output.Write([]byte("abcdef"))
	if err != nil || written != 6 {
		t.Fatalf("write = %d, %v", written, err)
	}
	if output.String() != "abcd" || !output.overflowed {
		t.Fatalf("expected capped overflow, got %q (overflow=%v)", output.String(), output.overflowed)
	}
}

func TestRunSshRelayWorkerCommandReturnsParentCancellation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake ssh fixture uses a POSIX shell script")
	}
	sshPath := filepath.Join(t.TempDir(), "ssh")
	if err := os.WriteFile(sshPath, []byte("#!/bin/sh\nexec sleep 10\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	started := time.Now()

	_, err := runSshRelayWorkerCommand(ctx, sshPath, SshTarget{Host: "example.test"}, sshRelayWorkerDeployment{platform: relayPlatform{goos: "linux"}, path: "worker"}, nil, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context cancellation, got %v", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("cancelled SSH command took %s", elapsed)
	}
}

type assertionError string

func (e assertionError) Error() string { return string(e) }
