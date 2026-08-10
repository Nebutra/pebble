package runtimehttp

import (
	"context"
	"testing"
	"time"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestRemoteWorkspaceWatchRetryDelayIsBounded(t *testing.T) {
	tests := []struct {
		attempt int
		want    time.Duration
	}{
		{attempt: 0, want: 1 * time.Second},
		{attempt: 1, want: 2 * time.Second},
		{attempt: 4, want: 16 * time.Second},
		{attempt: 5, want: remoteWorkspaceWatchRetryMax},
		// A long outage must never grow past the cap or overflow the shift.
		{attempt: 64, want: remoteWorkspaceWatchRetryMax},
		{attempt: -1, want: remoteWorkspaceWatchRetryMax},
	}
	for _, test := range tests {
		if got := remoteWorkspaceWatchRetryDelay(test.attempt); got != test.want {
			t.Fatalf("attempt %d: expected %s, got %s", test.attempt, test.want, got)
		}
	}
}

func TestSleepWithContextStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	started := time.Now()
	if sleepWithContext(ctx, time.Minute) {
		t.Fatal("expected a cancelled context to abandon the wait")
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("expected an immediate return, waited %s", elapsed)
	}
}

func TestSleepWithContextReportsACompletedWait(t *testing.T) {
	if !sleepWithContext(context.Background(), time.Millisecond) {
		t.Fatal("expected an uncancelled wait to complete")
	}
}

// Why: the stream goroutine used to delete the watch whenever the transport
// errored, so a network drop reset the ref count. A later retain started at one
// and a single release cancelled a watch other subscribers still needed.
func TestRemoteWorkspaceWatchSurvivesAFailedStream(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	registry := newRemoteWorkspaceWatchRegistry(manager)

	// An unknown target fails the stream immediately, standing in for a drop.
	registry.retain("missing-target")
	registry.retain("missing-target")
	requireStableWatchRefs(t, registry, "missing-target", 2)

	registry.release("missing-target")
	if refs := watchRefs(registry, "missing-target"); refs != 1 {
		t.Fatalf("expected the second subscriber to keep the watch, got refs %d", refs)
	}

	registry.release("missing-target")
	if refs := watchRefs(registry, "missing-target"); refs != 0 {
		t.Fatalf("expected the last release to drop the watch, got refs %d", refs)
	}
}

// requireStableWatchRefs spans the goroutine's first failed stream — the moment
// the old code forgot the watch — and asserts the ref count never moved.
func requireStableWatchRefs(
	t *testing.T,
	registry *remoteWorkspaceWatchRegistry,
	targetID string,
	want int,
) {
	t.Helper()
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if refs := watchRefs(registry, targetID); refs != want {
			t.Fatalf("expected %d refs to survive a failed stream, got %d", want, refs)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func watchRefs(registry *remoteWorkspaceWatchRegistry, targetID string) int {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	watch := registry.watches[targetID]
	if watch == nil {
		return 0
	}
	return watch.refs
}
