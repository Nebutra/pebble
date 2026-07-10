package runtimecore

import (
	"context"
	"encoding/json"
	"runtime"
	"testing"
)

// TestSessionTabLayoutPersistsAcrossStoreReload proves saved tab/group/pane
// layout survives a full runtime restart (new Manager over the same data dir).
func TestSessionTabLayoutPersistsAcrossStoreReload(t *testing.T) {
	dataDir := t.TempDir()
	manager, err := NewManager(dataDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := manager.SaveSessionTabLayout("wt-1", SaveSessionTabLayoutRequest{
		ActiveTabID:    "tab-2",
		ActiveGroupID:  "group-1",
		TabGroups:      json.RawMessage(`[{"id":"group-1","tabOrder":["tab-1","tab-2"]}]`),
		TabGroupLayout: json.RawMessage(`{"type":"leaf","groupId":"group-1"}`),
		PaneLayoutByTabID: map[string]json.RawMessage{
			"tab-2": json.RawMessage(`{"root":{"type":"leaf","leafId":"leaf-9"}}`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if saved.SnapshotVersion != 1 {
		t.Fatalf("expected first snapshot version 1, got %#v", saved)
	}

	reloaded, err := NewManager(dataDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	layout, err := reloaded.GetSessionTabLayout("wt-1")
	if err != nil {
		t.Fatalf("expected persisted layout after reload: %v", err)
	}
	if layout.ActiveTabID != "tab-2" || layout.ActiveGroupID != "group-1" {
		t.Fatalf("unexpected reloaded layout: %#v", layout)
	}
	// The store pretty-prints JSON, so compare the payload semantically.
	var pane struct {
		Root struct {
			LeafID string `json:"leafId"`
		} `json:"root"`
	}
	if err := json.Unmarshal(layout.PaneLayoutByTabID["tab-2"], &pane); err != nil {
		t.Fatalf("pane layout payload unparsable after reload: %v", err)
	}
	if pane.Root.LeafID != "leaf-9" {
		t.Fatalf("pane layout payload lost in reload: %#v", layout)
	}

	// A follow-up save must bump the version monotonically after reload.
	resaved, err := reloaded.SaveSessionTabLayout("wt-1", SaveSessionTabLayoutRequest{ActiveTabID: "tab-1"})
	if err != nil {
		t.Fatal(err)
	}
	if resaved.SnapshotVersion != 2 {
		t.Fatalf("expected version 2 after resave, got %#v", resaved)
	}

	if _, err := reloaded.GetSessionTabLayout("missing"); err != ErrSessionTabLayoutNotFound {
		t.Fatalf("expected not-found for unknown worktree, got %v", err)
	}
}

// TestUpdateSessionPlacementMovesLiveSession proves a tab move persists on the
// live session record so `/v1/sessions` snapshots rehydrate the new placement.
func TestUpdateSessionPlacementMovesLiveSession(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("session placement test uses a POSIX shell")
	}
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.StartSession(context.Background(), StartSessionRequest{
		ProjectID: project.ID,
		Command:   []string{"/bin/sh", "-c", "sleep 5"},
		TabID:     "tab-old",
		LeafID:    "leaf-old",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = manager.StopSession(session.ID) })

	tabID := "tab-new"
	leafID := "leaf-new"
	moved, err := manager.UpdateSessionPlacement(session.ID, UpdateSessionPlacementRequest{
		TabID:  &tabID,
		LeafID: &leafID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if moved.TabID != "tab-new" || moved.LeafID != "leaf-new" {
		t.Fatalf("expected moved placement, got %#v", moved)
	}
	listed, ok := findSession(manager.ListSessions(), session.ID)
	if !ok || listed.TabID != "tab-new" || listed.LeafID != "leaf-new" {
		t.Fatalf("list snapshot must carry the moved placement, got %#v", listed)
	}

	// Partial update: only the leaf moves; the tab must be preserved.
	leafOnly := "leaf-split"
	partial, err := manager.UpdateSessionPlacement(session.ID, UpdateSessionPlacementRequest{LeafID: &leafOnly})
	if err != nil {
		t.Fatal(err)
	}
	if partial.TabID != "tab-new" || partial.LeafID != "leaf-split" {
		t.Fatalf("partial update must keep unset fields, got %#v", partial)
	}

	if _, err := manager.UpdateSessionPlacement("sess_missing", UpdateSessionPlacementRequest{TabID: &tabID}); err != ErrSessionNotFound {
		t.Fatalf("expected session not found, got %v", err)
	}
}
