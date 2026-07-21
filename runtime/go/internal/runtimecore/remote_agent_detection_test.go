package runtimecore

import (
	"testing"
)

func TestUpdateRemoteAgentDetectionNormalizesAndPersists(t *testing.T) {
	dataDir := t.TempDir()
	manager, err := NewManager(dataDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	detection, err := manager.UpdateRemoteAgentDetection(UpdateRemoteAgentDetectionRequest{
		HostID: " host-1 ",
		Agents: []string{"codex", " claude ", "codex", ""},
	})
	if err != nil {
		t.Fatal(err)
	}
	if detection.HostID != "host-1" {
		t.Fatalf("host id was not trimmed: %q", detection.HostID)
	}
	if len(detection.Agents) != 2 || detection.Agents[0] != "claude" || detection.Agents[1] != "codex" {
		t.Fatalf("agents were not deduped/sorted: %#v", detection.Agents)
	}

	// A fresh manager over the same data dir must see the relay-fed detection,
	// matching how file/source-control snapshots survive runtime restarts.
	reloaded, err := NewManager(dataDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	cached, ok := reloaded.RemoteAgentDetectionForHost("host-1")
	if !ok || len(cached.Agents) != 2 {
		t.Fatalf("detection was not persisted: %#v ok=%v", cached, ok)
	}
}

func TestUpdateRemoteAgentDetectionRequiresHost(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.UpdateRemoteAgentDetection(UpdateRemoteAgentDetectionRequest{Agents: []string{"claude"}}); err == nil {
		t.Fatal("expected missing host id to be rejected")
	}
	if _, ok := manager.RemoteAgentDetectionForHost("missing"); ok {
		t.Fatal("expected no detection for unknown host")
	}
}
