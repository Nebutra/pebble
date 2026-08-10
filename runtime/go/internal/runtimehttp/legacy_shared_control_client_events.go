package runtimehttp

import (
	"encoding/json"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

// runtime.clientEvents carries the coarse "something you list has changed"
// nudges the renderer uses to refetch repos and worktrees, so a paired client
// does not have to poll the list RPCs.

const legacySharedControlClientEventsKind = "clientEvents"

func (s *Server) startLegacySharedControlClientEvents(conn *websocketConn, sharedKey *[32]byte, request legacySharedControlRequest, subscriptions map[string]legacySharedControlSubscription) {
	subscriptionID := "client-events-" + request.ID
	subscriptions[subscriptionID] = legacySharedControlSubscription{RequestID: request.ID, SubscriptionID: subscriptionID, Kind: legacySharedControlClientEventsKind}
	// The client can only unsubscribe once it knows this id, so it must travel
	// with the ready handshake rather than with the first event.
	_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"type": "ready", "subscriptionId": subscriptionID}, true)
}

func (s *Server) writeLegacySharedControlClientEvent(conn *websocketConn, sharedKey *[32]byte, subscription legacySharedControlSubscription, event runtimecore.RuntimeEvent) {
	switch event.Topic {
	case "project.changed":
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, subscription.RequestID, map[string]interface{}{"type": "reposChanged"}, true)
	case "worktree.changed":
		projectID := legacySharedControlWorktreeEventProjectID(event)
		if projectID == "" {
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, subscription.RequestID, map[string]interface{}{"type": "worktreesChanged", "repoId": projectID}, true)
	}
}

// legacySharedControlWorktreeEventProjectID reads the owning project out of the
// several shapes worktree.changed carries: the worktree itself, a deletion, and
// a relay-reported preserved-branch removal.
func legacySharedControlWorktreeEventProjectID(event runtimecore.RuntimeEvent) string {
	encoded, err := json.Marshal(event.Payload)
	if err != nil {
		return ""
	}
	type projectRef struct {
		ProjectID string `json:"projectId"`
	}
	var payload struct {
		projectRef
		Deleted                      *projectRef `json:"deleted"`
		RemotePreservedBranchRemoval *projectRef `json:"remotePreservedBranchRemoval"`
	}
	if json.Unmarshal(encoded, &payload) != nil {
		return ""
	}
	if payload.ProjectID != "" {
		return payload.ProjectID
	}
	if payload.Deleted != nil && payload.Deleted.ProjectID != "" {
		return payload.Deleted.ProjectID
	}
	if payload.RemotePreservedBranchRemoval != nil {
		return payload.RemotePreservedBranchRemoval.ProjectID
	}
	return ""
}
