package runtimecore

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func waitForGitStatusLeases(t *testing.T, owner *gitStatusReadLeaseOwner, key string, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		owner.mu.Lock()
		leases := 0
		if entry, ok := owner.entries[key]; ok {
			leases = entry.leases
		}
		owner.mu.Unlock()
		if leases == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d leases on %q, saw %d", want, key, leases)
		}
		time.Sleep(time.Millisecond)
	}
}

func waitForGitStatusReads(t *testing.T, loads *atomic.Int32, want int32) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		seen := loads.Load()
		if seen == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d reads, saw %d", want, seen)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestGitStatusReadLeaseCoalescesConcurrentCallersOntoOneRead(t *testing.T) {
	owner := &gitStatusReadLeaseOwner{}
	var loads atomic.Int32
	release := make(chan struct{})
	load := func(context.Context) ([]string, error) {
		loads.Add(1)
		<-release
		return []string{"## main", " M a.txt"}, nil
	}

	results := make(chan []string, 3)
	for range 3 {
		go func() {
			lines, err := owner.lease(context.Background(), "worktree", load)
			if err != nil {
				t.Errorf("unexpected error: %v", err)
			}
			results <- lines
		}()
	}
	waitForGitStatusLeases(t, owner, "worktree", 3)
	close(release)

	for range 3 {
		if lines := <-results; len(lines) != 2 || lines[1] != " M a.txt" {
			t.Fatalf("unexpected shared lines: %#v", lines)
		}
	}
	if got := loads.Load(); got != 1 {
		t.Fatalf("expected one coalesced read, got %d", got)
	}
}

func TestGitStatusReadLeaseDoesNotHandOutASettledRead(t *testing.T) {
	owner := &gitStatusReadLeaseOwner{}
	var loads atomic.Int32
	load := func(context.Context) ([]string, error) {
		loads.Add(1)
		return []string{"## main"}, nil
	}

	for range 2 {
		if _, err := owner.lease(context.Background(), "worktree", load); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	// Why: coalescing must never turn into caching — a later refresh has to see
	// working-tree changes made since the previous read finished.
	if got := loads.Load(); got != 2 {
		t.Fatalf("expected each sequential caller to read afresh, got %d", got)
	}
}

func TestGitStatusReadLeaseRejectsAPreAbortedCallerWithoutReading(t *testing.T) {
	owner := &gitStatusReadLeaseOwner{}
	started := make(chan struct{}, 1)
	load := func(context.Context) ([]string, error) {
		started <- struct{}{}
		return nil, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	lines, err := owner.lease(ctx, "worktree", load)
	if !errors.Is(err, context.Canceled) || lines != nil {
		t.Fatalf("expected a cancelled result, got %#v / %v", lines, err)
	}
	// Why: the caller is already gone, so spawning git for it is pure waste. A
	// bounded wait is enough — the read would otherwise start on its own
	// goroutine straight away.
	select {
	case <-started:
		t.Fatal("an already-cancelled caller still started a read")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestGitStatusReadLeaseKeepsTheSharedReadAliveWhileAnyLeaseRemains(t *testing.T) {
	owner := &gitStatusReadLeaseOwner{}
	readCtx := make(chan context.Context, 1)
	release := make(chan struct{})
	load := func(ctx context.Context) ([]string, error) {
		readCtx <- ctx
		<-release
		return []string{"## main"}, nil
	}

	leaving, cancelLeaving := context.WithCancel(context.Background())
	go func() { _, _ = owner.lease(leaving, "worktree", load) }()
	staying := make(chan []string, 1)
	go func() {
		lines, err := owner.lease(context.Background(), "worktree", load)
		if err != nil {
			t.Errorf("unexpected error for the surviving caller: %v", err)
		}
		staying <- lines
	}()
	waitForGitStatusLeases(t, owner, "worktree", 2)
	shared := <-readCtx

	cancelLeaving()
	waitForGitStatusLeases(t, owner, "worktree", 1)
	if err := shared.Err(); err != nil {
		t.Fatalf("shared read was aborted while a lease was still live: %v", err)
	}

	close(release)
	if lines := <-staying; len(lines) != 1 {
		t.Fatalf("surviving caller got %#v", lines)
	}
}

func TestGitStatusReadLeaseAbortsTheSharedReadWhenTheLastLeaseLeaves(t *testing.T) {
	owner := &gitStatusReadLeaseOwner{}
	readCtx := make(chan context.Context, 1)
	load := func(ctx context.Context) ([]string, error) {
		readCtx <- ctx
		<-ctx.Done()
		return nil, ctx.Err()
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := owner.lease(ctx, "worktree", load)
		done <- err
	}()
	waitForGitStatusLeases(t, owner, "worktree", 1)
	shared := <-readCtx

	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("expected the caller to see cancellation, got %v", err)
	}
	select {
	case <-shared.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("abandoned read was never aborted")
	}
	if cause := context.Cause(shared); !errors.Is(cause, context.Canceled) {
		t.Fatalf("unexpected abort cause: %v", cause)
	}
	owner.mu.Lock()
	_, lingering := owner.entries["worktree"]
	owner.mu.Unlock()
	if lingering {
		t.Fatal("abandoned entry was left behind for a later caller to join")
	}
}

func TestGitStatusReadLeaseDeliversFailuresAndEvictsTheEntry(t *testing.T) {
	owner := &gitStatusReadLeaseOwner{}
	failure := errors.New("git status failed")
	var loads atomic.Int32
	release := make(chan struct{})
	load := func(context.Context) ([]string, error) {
		loads.Add(1)
		<-release
		return nil, failure
	}

	errs := make(chan error, 2)
	for range 2 {
		go func() {
			_, err := owner.lease(context.Background(), "worktree", load)
			errs <- err
		}()
	}
	waitForGitStatusLeases(t, owner, "worktree", 2)
	close(release)
	for range 2 {
		if err := <-errs; !errors.Is(err, failure) {
			t.Fatalf("expected the shared failure, got %v", err)
		}
	}

	// Why: a failed read must not be retained, or a transient git failure would
	// be replayed to the caller that arrives next.
	owner.mu.Lock()
	_, lingering := owner.entries["worktree"]
	owner.mu.Unlock()
	if lingering {
		t.Fatal("failed entry was left behind")
	}
}

func TestGitStatusReadLeaseInvalidationStopsLaterCallersJoiningAnInFlightRead(t *testing.T) {
	owner := &gitStatusReadLeaseOwner{}
	var loads atomic.Int32
	release := make(chan struct{})
	load := func(context.Context) ([]string, error) {
		loads.Add(1)
		<-release
		return []string{"## main"}, nil
	}

	first := make(chan error, 1)
	go func() {
		_, err := owner.lease(context.Background(), "worktree", load)
		first <- err
	}()
	waitForGitStatusReads(t, &loads, 1)

	owner.invalidate()
	second := make(chan error, 1)
	go func() {
		_, err := owner.lease(context.Background(), "worktree", load)
		second <- err
	}()
	// Why: waiting on the second read rather than on lease counts is what pins
	// invalidation — the first read is still blocked here, so a caller that could
	// still join it would never start one.
	waitForGitStatusReads(t, &loads, 2)

	close(release)
	if err := <-first; err != nil {
		t.Fatalf("the in-flight caller lost its result: %v", err)
	}
	if err := <-second; err != nil {
		t.Fatalf("the post-invalidation caller failed: %v", err)
	}
}

func TestGitStatusReadLeaseKeepsDistinctWorktreesApart(t *testing.T) {
	owner := &gitStatusReadLeaseOwner{}
	release := make(chan struct{})
	lines := make(chan []string, 2)
	for _, key := range []string{"alpha", "beta"} {
		go func() {
			result, err := owner.lease(context.Background(), key, func(context.Context) ([]string, error) {
				<-release
				return []string{key}, nil
			})
			if err != nil {
				t.Errorf("unexpected error for %q: %v", key, err)
			}
			lines <- result
		}()
	}
	waitForGitStatusLeases(t, owner, "alpha", 1)
	waitForGitStatusLeases(t, owner, "beta", 1)
	close(release)

	seen := map[string]bool{}
	for range 2 {
		result := <-lines
		if len(result) != 1 {
			t.Fatalf("unexpected result: %#v", result)
		}
		seen[result[0]] = true
	}
	if !seen["alpha"] || !seen["beta"] {
		t.Fatalf("distinct worktrees shared a read: %#v", seen)
	}
}
