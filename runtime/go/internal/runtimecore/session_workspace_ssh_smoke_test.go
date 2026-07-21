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

func TestStartSessionRunsSshProjectThroughSystemSshPty(t *testing.T) {
	directory := t.TempDir()
	fakeSsh := filepath.Join(directory, "ssh")
	if err := os.WriteFile(fakeSsh, []byte("#!/bin/sh\ncase \"$*\" in *'uname -s'*) printf 'Linux\\nx86_64\\n';; *) printf 'remote-ssh-argv:%s\\n' \"$*\";; esac\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PEBBLE_SYSTEM_SSH_PATH", fakeSsh)
	manager, _ := newSshTestManager(t)
	target, _ := manager.CreateSshTarget(SshTargetInput{Label: "Remote", Host: "example.invalid", Username: "dev"})
	project, _ := manager.CreateProject(CreateProjectRequest{Name: "remote", Path: "/path/that/does/not/exist/locally", LocationKind: "ssh", HostID: target.ID})
	session, err := manager.StartSession(context.Background(), StartSessionRequest{ProjectID: project.ID, Command: []string{"printf", "hello"}})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		status, statusErr := manager.SessionStatus(session.ID)
		if statusErr != nil {
			t.Fatal(statusErr)
		}
		if status.Status == SessionExited {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	chunks, err := manager.TailSession(session.ID, 20)
	if err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	for _, chunk := range chunks.Chunks {
		output.WriteString(chunk.Content)
	}
	if !strings.Contains(output.String(), "remote-ssh-argv:") || !strings.Contains(output.String(), "cd --") {
		t.Fatalf("remote session output = %q", output.String())
	}
}
