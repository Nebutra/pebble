package runtimecore

import (
	"testing"
	"time"
)

func TestTerminateSshTargetSessionsStopsOnlyOwnedSessions(t *testing.T) {
	manager, _ := newSshTestManager(t)
	target, _ := manager.CreateSshTarget(SshTargetInput{Label: "Remote", Host: "example.invalid"})
	remote, _ := manager.CreateProject(CreateProjectRequest{Name: "remote", Path: "/srv/repo", LocationKind: "ssh", HostID: target.ID})
	localPath := t.TempDir()
	local, _ := manager.CreateProject(CreateProjectRequest{Name: "local", Path: localPath, LocationKind: "local"})
	now := time.Now().UTC()
	manager.mu.Lock()
	manager.sessions["remote-session"] = &processSession{id: "remote-session", projectID: remote.ID, status: SessionRunning, startedAt: now, updatedAt: now, stateChanged: make(chan struct{})}
	manager.sessions["local-session"] = &processSession{id: "local-session", projectID: local.ID, status: SessionRunning, startedAt: now, updatedAt: now, stateChanged: make(chan struct{})}
	manager.mu.Unlock()

	result, err := manager.TerminateSshTargetSessions(target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.TerminatedIDs) != 1 || result.TerminatedIDs[0] != "remote-session" {
		t.Fatalf("result = %#v", result)
	}
	if manager.sessions["remote-session"].status != SessionStopped || manager.sessions["local-session"].status != SessionRunning {
		t.Fatal("session termination crossed target ownership")
	}
}
