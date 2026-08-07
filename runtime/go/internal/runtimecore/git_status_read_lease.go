package runtimecore

import (
	"context"
	"sync"
)

type gitStatusReadResult struct {
	lines []string
	err   error
}

type gitStatusReadEntry struct {
	cancel  context.CancelCauseFunc
	done    chan struct{}
	result  gitStatusReadResult
	leases  int
	settled bool
}

// gitStatusReadLeaseOwner coalesces concurrent `git status` reads for the same
// worktree onto a single subprocess, so a burst of refreshes costs one process
// rather than one per caller. Every caller keeps its own cancellation: the
// shared read is aborted only once the last live lease has gone away.
type gitStatusReadLeaseOwner struct {
	mu      sync.Mutex
	entries map[string]*gitStatusReadEntry
}

func (o *gitStatusReadLeaseOwner) lease(
	ctx context.Context,
	key string,
	load func(context.Context) ([]string, error),
) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	o.mu.Lock()
	if o.entries == nil {
		o.entries = map[string]*gitStatusReadEntry{}
	}
	entry, joined := o.entries[key]
	if !joined {
		// Why: the shared read outlives whichever caller happened to start it, so
		// it runs detached from that caller's cancellation and is instead governed
		// by the lease count below.
		readCtx, cancel := context.WithCancelCause(context.WithoutCancel(ctx))
		entry = &gitStatusReadEntry{cancel: cancel, done: make(chan struct{})}
		o.entries[key] = entry
		go func() {
			defer cancel(nil)
			lines, err := load(readCtx)
			o.settle(key, entry, gitStatusReadResult{lines: lines, err: err})
		}()
	}
	entry.leases++
	o.mu.Unlock()

	select {
	case <-entry.done:
		o.release(key, entry, nil)
		return entry.result.lines, entry.result.err
	case <-ctx.Done():
		o.release(key, entry, context.Cause(ctx))
		return nil, ctx.Err()
	}
}

// invalidate drops the entries a later read could join. In-flight reads still
// finish for the callers already waiting on them; they just stop being handed to
// callers that arrive after a mutation, which would see pre-mutation state.
func (o *gitStatusReadLeaseOwner) invalidate() {
	o.mu.Lock()
	defer o.mu.Unlock()
	clear(o.entries)
}

func (o *gitStatusReadLeaseOwner) settle(key string, entry *gitStatusReadEntry, result gitStatusReadResult) {
	o.mu.Lock()
	entry.result = result
	entry.settled = true
	// Why: invalidate may already have replaced this key, so only evict the entry
	// that this read actually owns.
	if o.entries[key] == entry {
		delete(o.entries, key)
	}
	o.mu.Unlock()
	close(entry.done)
}

func (o *gitStatusReadLeaseOwner) release(key string, entry *gitStatusReadEntry, cause error) {
	o.mu.Lock()
	entry.leases--
	// Why: a read is only wasted work once nobody is left waiting on it, and a
	// settled read has nothing left to cancel.
	abandoned := cause != nil && entry.leases == 0 && !entry.settled
	if abandoned && o.entries[key] == entry {
		delete(o.entries, key)
	}
	o.mu.Unlock()
	if abandoned {
		entry.cancel(cause)
	}
}
