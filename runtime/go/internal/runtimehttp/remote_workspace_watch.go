package runtimehttp

import (
	"context"
	"sync"
	"time"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

const (
	remoteWorkspaceWatchRetryBase = 1 * time.Second
	remoteWorkspaceWatchRetryMax  = 30 * time.Second
	// Shifting the base past this overflows a Duration long before it matters.
	remoteWorkspaceWatchRetryShiftCap = 5
)

type remoteWorkspaceWatch struct {
	cancel context.CancelFunc
	refs   int
}

type remoteWorkspaceWatchRegistry struct {
	manager *runtimecore.Manager
	mu      sync.Mutex
	watches map[string]*remoteWorkspaceWatch
}

func newRemoteWorkspaceWatchRegistry(manager *runtimecore.Manager) *remoteWorkspaceWatchRegistry {
	return &remoteWorkspaceWatchRegistry{manager: manager, watches: make(map[string]*remoteWorkspaceWatch)}
}

func (r *remoteWorkspaceWatchRegistry) retain(targetID string) {
	r.mu.Lock()
	if watch := r.watches[targetID]; watch != nil {
		watch.refs++
		r.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	watch := &remoteWorkspaceWatch{cancel: cancel, refs: 1}
	r.watches[targetID] = watch
	r.mu.Unlock()

	go r.streamUntilReleased(ctx, targetID, watch)
}

// Why: a dropped SSH transport ends the stream with an error while subscribers
// still hold refs. Forgetting the watch there lost the count — the next retain
// started again at one, so a single release cancelled a watch other subscribers
// needed — and nothing restarted the stream, leaving the workspace dark until a
// subscriber happened to retain again. Only release() may forget a watch.
func (r *remoteWorkspaceWatchRegistry) streamUntilReleased(
	ctx context.Context,
	targetID string,
	watch *remoteWorkspaceWatch,
) {
	attempt := 0
	for ctx.Err() == nil {
		connected := false
		err := r.manager.StreamSshRemoteWorkspace(ctx, targetID, func(snapshot runtimecore.RemoteWorkspaceSnapshot) {
			if !connected {
				connected = true
				r.publishWatchStatus(targetID, true, "")
			}
			r.manager.PublishRemoteWorkspaceEvent("workspace.changed", map[string]interface{}{"targetId": targetID, "snapshot": snapshot})
		})
		if ctx.Err() != nil {
			break
		}
		if err != nil {
			r.publishWatchStatus(targetID, false, err.Error())
		}
		// A stream that delivered a snapshot proves the host is reachable, so the
		// next outage starts from the floor instead of the previous long delay.
		if connected {
			attempt = 0
		}
		if !sleepWithContext(ctx, remoteWorkspaceWatchRetryDelay(attempt)) {
			break
		}
		attempt++
	}
	r.forget(targetID, watch)
}

func (r *remoteWorkspaceWatchRegistry) publishWatchStatus(targetID string, connected bool, message string) {
	payload := map[string]interface{}{"targetId": targetID, "connected": connected}
	if message != "" {
		payload["message"] = message
	}
	r.manager.PublishRemoteWorkspaceEvent("workspace.watch-status", payload)
}

func (r *remoteWorkspaceWatchRegistry) forget(targetID string, watch *remoteWorkspaceWatch) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.watches[targetID] == watch {
		delete(r.watches, targetID)
	}
}

func (r *remoteWorkspaceWatchRegistry) release(targetID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	watch := r.watches[targetID]
	if watch == nil {
		return
	}
	watch.refs--
	if watch.refs > 0 {
		return
	}
	delete(r.watches, targetID)
	watch.cancel()
}

// remoteWorkspaceWatchRetryDelay bounds reconnect fan-out: each watched target
// backs off on its own capped schedule rather than reconnecting every second
// against a host that is down.
func remoteWorkspaceWatchRetryDelay(attempt int) time.Duration {
	if attempt < 0 || attempt > remoteWorkspaceWatchRetryShiftCap {
		return remoteWorkspaceWatchRetryMax
	}
	if delay := remoteWorkspaceWatchRetryBase << attempt; delay < remoteWorkspaceWatchRetryMax {
		return delay
	}
	return remoteWorkspaceWatchRetryMax
}

// sleepWithContext reports whether the wait finished; a cancelled watch returns
// false so the caller stops retrying instead of sleeping out the full delay.
func sleepWithContext(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
