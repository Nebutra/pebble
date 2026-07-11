//go:build !windows

package runtimecore

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSshPortForwardLifecycleAndRestore(t *testing.T) {
	capture := filepath.Join(t.TempDir(), "ssh-args")
	fakeSsh := filepath.Join(t.TempDir(), "ssh")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$PEBBLE_TEST_SSH_CAPTURE\"\nwhile :; do sleep 1; done\n"
	if err := os.WriteFile(fakeSsh, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PEBBLE_SYSTEM_SSH_PATH", fakeSsh)
	t.Setenv("PEBBLE_TEST_SSH_CAPTURE", capture)

	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	target, err := manager.CreateSshTarget(SshTargetInput{Host: "example.test", Username: "dev"})
	if err != nil {
		t.Fatal(err)
	}
	entry, err := manager.AddSshPortForward(context.Background(), target.ID, SshPortForwardInput{
		LocalPort: 43110, RemoteHost: "127.0.0.1", RemotePort: 3000, Label: "Web",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = manager.RemoveSshPortForward(target.ID, entry.ID) })

	var contents []byte
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		contents, err = os.ReadFile(capture)
		if err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	if got := string(contents); !strings.Contains(got, "-N -o ExitOnForwardFailure=yes -L 127.0.0.1:43110:127.0.0.1:3000 dev@example.test") {
		t.Fatalf("unexpected ssh arguments: %s", got)
	}
	listed, err := manager.ListSshPortForwards(target.ID)
	if err != nil || len(listed) != 1 || listed[0] != entry {
		t.Fatalf("unexpected persisted forwards: %#v, %v", listed, err)
	}

	restored, err := manager.RestoreSshPortForwards(context.Background(), target.ID)
	if err != nil || len(restored) != 1 {
		t.Fatalf("unexpected restore result: %#v, %v", restored, err)
	}
	time.Sleep(50 * time.Millisecond)
	contents, _ = os.ReadFile(capture)
	if lines := strings.Count(strings.TrimSpace(string(contents)), "\n") + 1; lines != 1 {
		t.Fatalf("restore started a duplicate tunnel: %q", contents)
	}
	terminated, err := manager.TerminateSshPortForwards(target.ID)
	if err != nil || len(terminated) != 1 || terminated[0] != entry.ID {
		t.Fatalf("unexpected target termination: %#v, %v", terminated, err)
	}
	listed, err = manager.ListSshPortForwards(target.ID)
	if err != nil || len(listed) != 1 {
		t.Fatalf("target termination removed durable configuration: %#v, %v", listed, err)
	}
	if _, err := manager.RestoreSshPortForwards(context.Background(), target.ID); err != nil {
		t.Fatal(err)
	}

	removed, err := manager.RemoveSshPortForward(target.ID, entry.ID)
	if err != nil || removed == nil || removed.ID != entry.ID {
		t.Fatalf("unexpected remove result: %#v, %v", removed, err)
	}
	listed, err = manager.ListSshPortForwards(target.ID)
	if err != nil || len(listed) != 0 {
		t.Fatalf("forward remained persisted: %#v, %v", listed, err)
	}
}

func TestSshPortForwardRejectsUnsafeHost(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	target, err := manager.CreateSshTarget(SshTargetInput{Host: "example.test"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.AddSshPortForward(context.Background(), target.ID, SshPortForwardInput{
		LocalPort: 43110, RemoteHost: "localhost\nProxyCommand=bad", RemotePort: 3000,
	})
	if err == nil {
		t.Fatal("expected unsafe host to be rejected")
	}
}

// TestWatchSshPortForwardIgnoresReplacedProcess exercises the exact race an id
// reuse can hit: a stale watcher's exit signal arrives after a NEW process has
// already been registered under the same id (e.g. UpdateSshPortForward stops
// then immediately restarts a forward). The stale watcher must not delete or
// clean up the new, still-running process.
func TestWatchSshPortForwardIgnoresReplacedProcess(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}

	const id = "fwd-1"
	oldCleaned := make(chan struct{}, 1)
	oldProcess := &sshPortForwardProcess{cleanup: func() { oldCleaned <- struct{}{} }}
	newCleaned := make(chan struct{}, 1)
	newProcess := &sshPortForwardProcess{cleanup: func() { newCleaned <- struct{}{} }}

	// Simulate the old process having already been registered, then replaced
	// by a new one under the same id (as UpdateSshPortForward's stop+restart
	// does) before the old watcher's exit signal arrives.
	manager.mu.Lock()
	manager.sshPortForwards[id] = newProcess
	manager.mu.Unlock()

	exited := make(chan error, 1)
	exited <- errWatchTestExit
	manager.watchSshPortForward(id, oldProcess, exited)

	select {
	case <-oldCleaned:
	default:
		t.Fatal("expected the stale watcher to clean up its own (old) process")
	}
	select {
	case <-newCleaned:
		t.Fatal("stale watcher must not clean up the new process it never owned")
	default:
	}

	manager.mu.RLock()
	current := manager.sshPortForwards[id]
	manager.mu.RUnlock()
	if current != newProcess {
		t.Fatal("stale watcher must not delete the new process's map entry")
	}
}

var errWatchTestExit = errors.New("simulated forward exit")
