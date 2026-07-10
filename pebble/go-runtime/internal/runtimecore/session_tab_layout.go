package runtimecore

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// UpdateSessionPlacementRequest moves a live session to a different tab/leaf,
// mirroring what the renderer reports on tab move so `/v1/sessions` snapshots
// rehydrate the moved placement after a shell reload.
type UpdateSessionPlacementRequest struct {
	TabID  *string `json:"tabId,omitempty"`
	LeafID *string `json:"leafId,omitempty"`
}

// SessionTabLayout is the durable per-worktree tab/group/pane layout snapshot.
// Layout payloads stay opaque (json.RawMessage): the runtime persists what the
// desktop shell's tab mirror reports without owning renderer node shapes.
type SessionTabLayout struct {
	WorktreeID        string                     `json:"worktreeId"`
	ActiveTabID       string                     `json:"activeTabId,omitempty"`
	ActiveGroupID     string                     `json:"activeGroupId,omitempty"`
	TabGroups         json.RawMessage            `json:"tabGroups,omitempty"`
	TabGroupLayout    json.RawMessage            `json:"tabGroupLayout,omitempty"`
	PaneLayoutByTabID map[string]json.RawMessage `json:"paneLayoutByTabId,omitempty"`
	TabPropsByTabID   map[string]json.RawMessage `json:"tabPropsByTabId,omitempty"`
	SnapshotVersion   int64                      `json:"snapshotVersion"`
	UpdatedAt         time.Time                  `json:"updatedAt"`
}

type SaveSessionTabLayoutRequest struct {
	ActiveTabID       string                     `json:"activeTabId,omitempty"`
	ActiveGroupID     string                     `json:"activeGroupId,omitempty"`
	TabGroups         json.RawMessage            `json:"tabGroups,omitempty"`
	TabGroupLayout    json.RawMessage            `json:"tabGroupLayout,omitempty"`
	PaneLayoutByTabID map[string]json.RawMessage `json:"paneLayoutByTabId,omitempty"`
	TabPropsByTabID   map[string]json.RawMessage `json:"tabPropsByTabId,omitempty"`
}

var ErrSessionTabLayoutNotFound = errors.New("session tab layout not found")

// UpdateSessionPlacement persists a tab move/split for a live session by
// updating the session record itself, so the placement survives desktop shell
// reloads for as long as the runtime (and PTY) stay up.
func (m *Manager) UpdateSessionPlacement(id string, req UpdateSessionPlacementRequest) (Session, error) {
	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()
	if !ok {
		return Session{}, ErrSessionNotFound
	}
	snapshot := session.updatePlacement(req.TabID, req.LeafID)
	m.emit("session.status", snapshot)
	return snapshot, nil
}

// SaveSessionTabLayout stores the worktree's tab/group/pane layout in the
// runtime state file so layout survives full runtime restarts, not just shell
// reloads.
func (m *Manager) SaveSessionTabLayout(worktreeID string, req SaveSessionTabLayoutRequest) (SessionTabLayout, error) {
	worktreeID = strings.TrimSpace(worktreeID)
	if worktreeID == "" {
		return SessionTabLayout{}, errors.New("worktree id is required")
	}
	m.mu.Lock()
	previous := m.sessionTabLayouts[worktreeID]
	layout := SessionTabLayout{
		WorktreeID:        worktreeID,
		ActiveTabID:       strings.TrimSpace(req.ActiveTabID),
		ActiveGroupID:     strings.TrimSpace(req.ActiveGroupID),
		TabGroups:         cloneRawMessage(req.TabGroups),
		TabGroupLayout:    cloneRawMessage(req.TabGroupLayout),
		PaneLayoutByTabID: cloneRawMessageMap(req.PaneLayoutByTabID),
		TabPropsByTabID:   cloneRawMessageMap(req.TabPropsByTabID),
		SnapshotVersion:   previous.SnapshotVersion + 1,
		UpdatedAt:         time.Now().UTC(),
	}
	m.sessionTabLayouts[worktreeID] = layout
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return SessionTabLayout{}, err
	}
	m.emit("session.tabs.layout", layout)
	return layout, nil
}

func (m *Manager) GetSessionTabLayout(worktreeID string) (SessionTabLayout, error) {
	m.mu.RLock()
	layout, ok := m.sessionTabLayouts[strings.TrimSpace(worktreeID)]
	m.mu.RUnlock()
	if !ok {
		return SessionTabLayout{}, ErrSessionTabLayoutNotFound
	}
	return layout, nil
}

func (m *Manager) DeleteSessionTabLayout(worktreeID string) (bool, error) {
	worktreeID = strings.TrimSpace(worktreeID)
	m.mu.Lock()
	_, ok := m.sessionTabLayouts[worktreeID]
	if ok {
		delete(m.sessionTabLayouts, worktreeID)
	}
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return false, err
	}
	return ok, nil
}

func (s *processSession) updatePlacement(tabID *string, leafID *string) Session {
	s.mu.Lock()
	if tabID != nil {
		s.tabID = strings.TrimSpace(*tabID)
	}
	if leafID != nil {
		s.leafID = strings.TrimSpace(*leafID)
	}
	s.updatedAt = time.Now().UTC()
	snapshot := s.snapshotLocked()
	s.mu.Unlock()
	return snapshot
}

func cloneRawMessage(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	return append(json.RawMessage(nil), raw...)
}

func cloneRawMessageMap(raw map[string]json.RawMessage) map[string]json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	cloned := make(map[string]json.RawMessage, len(raw))
	for key, value := range raw {
		cloned[key] = cloneRawMessage(value)
	}
	return cloned
}
