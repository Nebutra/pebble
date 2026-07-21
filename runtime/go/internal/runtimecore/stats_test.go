package runtimecore

import (
	"testing"
	"time"
)

func TestStatsPersistAgentLifecycleAndDeduplicateReviews(t *testing.T) {
	dataDir := t.TempDir()
	manager, err := NewManager(dataDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	startedAt := time.UnixMilli(1_700_000_000_000).UTC()
	running := Session{
		ID: "sess-1", AgentKind: "codex", Status: SessionRunning,
		StartedAt: startedAt, UpdatedAt: startedAt,
	}
	manager.recordSessionStats(running)
	manager.recordSessionStats(running)
	exited := running
	exited.Status = SessionExited
	exited.UpdatedAt = startedAt.Add(90 * time.Second)
	manager.recordSessionStats(exited)
	manager.recordCreatedReview("https://example.test/pull/1")
	manager.recordCreatedReview("https://example.test/pull/1")

	summary := manager.StatsSummary()
	if summary.TotalAgentsSpawned != 1 || summary.TotalAgentTimeMs != 90_000 || summary.TotalPRsCreated != 1 {
		t.Fatalf("unexpected summary: %#v", summary)
	}
	if summary.FirstEventAt != startedAt.UnixMilli() {
		t.Fatalf("unexpected first event: %d", summary.FirstEventAt)
	}

	reloaded, err := NewManager(dataDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.StatsSummary(); got.TotalAgentsSpawned != 1 || got.TotalPRsCreated != 1 || got.TotalAgentTimeMs != 90_000 {
		t.Fatalf("stats did not persist: %#v", got)
	}
	reloaded.recordCreatedReview("https://example.test/pull/1")
	if got := reloaded.StatsSummary(); got.TotalPRsCreated != 1 {
		t.Fatalf("review deduplication did not persist: %#v", got)
	}
}
