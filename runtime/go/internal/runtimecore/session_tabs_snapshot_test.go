package runtimecore

import (
	"encoding/json"
	"testing"
	"time"
)

func TestSessionTabsSnapshotUsesPersistedLayoutAndLiveSessionPlacement(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	manager.mu.Lock()
	manager.sessions["session-1"] = &processSession{
		id: "session-1", projectID: "project-1", worktreeID: "wt-1", cwd: "/repo",
		command: []string{"shell"}, agentKind: "Codex", tabID: "tab-1", leafID: "leaf-1",
		status: SessionRunning, startedAt: now, updatedAt: now, stateChanged: make(chan struct{}),
	}
	manager.mu.Unlock()
	_, err = manager.SaveSessionTabLayout("wt-1", SaveSessionTabLayoutRequest{
		ActiveTabID: "tab-1", ActiveGroupID: "group-1",
		TabGroups:      json.RawMessage(`[{"id":"group-1","activeTabId":"tab-1","tabOrder":["tab-1"]}]`),
		TabGroupLayout: json.RawMessage(`{"type":"leaf","groupId":"group-1"}`),
		PaneLayoutByTabID: map[string]json.RawMessage{
			"tab-1": json.RawMessage(`{"root":{"type":"leaf","leafId":"leaf-1"},"expandedLeafId":"leaf-1"}`),
		},
		TabPropsByTabID: map[string]json.RawMessage{
			"tab-1": json.RawMessage(`{"color":"blue","isPinned":true,"viewMode":"chat"}`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := manager.SessionTabsSnapshot("id:wt-1")
	if snapshot["worktree"] != "wt-1" || snapshot["activeTabId"] != "tab-1" || snapshot["activeGroupId"] != "group-1" {
		t.Fatalf("unexpected snapshot identity: %#v", snapshot)
	}
	tabs := snapshot["tabs"].([]map[string]interface{})
	if len(tabs) != 1 || tabs[0]["id"] != "leaf-1" || tabs[0]["terminal"] != "session-1" || tabs[0]["color"] != "blue" || tabs[0]["isPinned"] != true || tabs[0]["viewMode"] != "chat" {
		t.Fatalf("unexpected terminal tab: %#v", tabs)
	}
	if tabs[0]["parentLayout"] == nil {
		t.Fatalf("expected persisted pane layout: %#v", tabs[0])
	}
}
