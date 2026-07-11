//go:build !windows

package runtimecore

import (
	"context"
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
