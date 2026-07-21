package runtimehttp

import (
	"context"
	"sync"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
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

	go func() {
		connected := false
		err := r.manager.StreamSshRemoteWorkspace(ctx, targetID, func(snapshot runtimecore.RemoteWorkspaceSnapshot) {
			if !connected {
				connected = true
				r.manager.PublishRemoteWorkspaceEvent("workspace.watch-status", map[string]interface{}{"targetId": targetID, "connected": true})
			}
			r.manager.PublishRemoteWorkspaceEvent("workspace.changed", map[string]interface{}{"targetId": targetID, "snapshot": snapshot})
		})
		if err != nil && ctx.Err() == nil {
			r.manager.PublishRemoteWorkspaceEvent("workspace.watch-status", map[string]interface{}{"targetId": targetID, "connected": false, "message": err.Error()})
		}
		r.mu.Lock()
		if r.watches[targetID] == watch {
			delete(r.watches, targetID)
		}
		r.mu.Unlock()
	}()
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
