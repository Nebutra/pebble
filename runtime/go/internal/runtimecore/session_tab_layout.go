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

type MoveSessionTabRequest struct {
	Kind, TabID, TargetGroupID, SplitDirection string
	TabOrder                                   []string
	Index                                      *int
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

// ActivateSessionTab preserves the renderer-owned layout while making one live
// tab authoritative for every desktop, web, and mobile projection.
func (m *Manager) ActivateSessionTab(worktreeID, tabID string) (SessionTabLayout, error) {
	worktreeID = normalizeSessionTabsWorktreeSelector(worktreeID)
	tabID = strings.TrimSpace(tabID)
	if worktreeID == "" || tabID == "" {
		return SessionTabLayout{}, errors.New("worktree id and tab id are required")
	}
	found := false
	for _, session := range m.ListSessions() {
		if session.WorktreeID == worktreeID && session.Status != SessionStopped && sessionTabsID(session) == tabID {
			found = true
			break
		}
	}
	if !found {
		return SessionTabLayout{}, ErrSessionNotFound
	}
	m.mu.RLock()
	previous := m.sessionTabLayouts[worktreeID]
	m.mu.RUnlock()
	return m.SaveSessionTabLayout(worktreeID, SaveSessionTabLayoutRequest{
		ActiveTabID: tabID, ActiveGroupID: previous.ActiveGroupID,
		TabGroups: previous.TabGroups, TabGroupLayout: previous.TabGroupLayout,
		PaneLayoutByTabID: previous.PaneLayoutByTabID, TabPropsByTabID: previous.TabPropsByTabID,
	})
}

// CloseSessionTab resolves renderer tab ids to their native PTY before stopping
// it, then repairs the persisted active-tab pointer from the resulting snapshot.
func (m *Manager) CloseSessionTab(worktreeID, tabID string) (Session, error) {
	worktreeID = normalizeSessionTabsWorktreeSelector(worktreeID)
	tabID = strings.TrimSpace(tabID)
	var target Session
	for _, session := range m.ListSessions() {
		if session.WorktreeID == worktreeID && session.Status != SessionStopped && (sessionTabsID(session) == tabID || session.ID == tabID) {
			target = session
			break
		}
	}
	if target.ID == "" {
		return Session{}, ErrSessionNotFound
	}
	stopped, err := m.StopSession(target.ID)
	if err != nil {
		return Session{}, err
	}
	snapshot := m.SessionTabsSnapshot(worktreeID)
	activeTabID, _ := snapshot["activeTabId"].(string)
	m.mu.RLock()
	previous := m.sessionTabLayouts[worktreeID]
	m.mu.RUnlock()
	_, err = m.SaveSessionTabLayout(worktreeID, SaveSessionTabLayoutRequest{
		ActiveTabID: activeTabID, ActiveGroupID: previous.ActiveGroupID,
		TabGroups: previous.TabGroups, TabGroupLayout: previous.TabGroupLayout,
		PaneLayoutByTabID: previous.PaneLayoutByTabID, TabPropsByTabID: previous.TabPropsByTabID,
	})
	return stopped, err
}

func (m *Manager) UpdateSessionTabPaneLayout(worktreeID, tabID string, paneLayout json.RawMessage) (SessionTabLayout, error) {
	worktreeID = normalizeSessionTabsWorktreeSelector(worktreeID)
	tabID = strings.TrimSpace(tabID)
	if !m.sessionTabExists(worktreeID, tabID) {
		return SessionTabLayout{}, ErrSessionNotFound
	}
	m.mu.RLock()
	previous := m.sessionTabLayouts[worktreeID]
	m.mu.RUnlock()
	paneLayouts := cloneRawMessageMap(previous.PaneLayoutByTabID)
	if paneLayouts == nil {
		paneLayouts = make(map[string]json.RawMessage)
	}
	paneLayouts[tabID] = cloneRawMessage(paneLayout)
	return m.SaveSessionTabLayout(worktreeID, sessionTabLayoutSaveRequest(previous, paneLayouts, previous.TabPropsByTabID))
}

func (m *Manager) SetSessionTabProps(worktreeID, tabID string, props json.RawMessage) (SessionTabLayout, error) {
	worktreeID = normalizeSessionTabsWorktreeSelector(worktreeID)
	tabID = strings.TrimSpace(tabID)
	if !m.sessionTabExists(worktreeID, tabID) {
		return SessionTabLayout{}, ErrSessionNotFound
	}
	m.mu.RLock()
	previous := m.sessionTabLayouts[worktreeID]
	m.mu.RUnlock()
	merged := make(map[string]interface{})
	_ = json.Unmarshal(previous.TabPropsByTabID[tabID], &merged)
	var update map[string]interface{}
	if json.Unmarshal(props, &update) != nil {
		return SessionTabLayout{}, errors.New("invalid tab props")
	}
	for key, value := range update {
		merged[key] = value
	}
	encoded, err := json.Marshal(merged)
	if err != nil {
		return SessionTabLayout{}, err
	}
	tabProps := cloneRawMessageMap(previous.TabPropsByTabID)
	if tabProps == nil {
		tabProps = make(map[string]json.RawMessage)
	}
	tabProps[tabID] = encoded
	return m.SaveSessionTabLayout(worktreeID, sessionTabLayoutSaveRequest(previous, previous.PaneLayoutByTabID, tabProps))
}

func (m *Manager) PlaceCreatedSessionTab(worktreeID, tabID, targetGroupID, afterTabID string, activate bool) (SessionTabLayout, error) {
	worktreeID = normalizeSessionTabsWorktreeSelector(worktreeID)
	if !m.sessionTabExists(worktreeID, tabID) {
		return SessionTabLayout{}, ErrSessionNotFound
	}
	m.mu.RLock()
	previous := m.sessionTabLayouts[worktreeID]
	m.mu.RUnlock()
	var groups []map[string]interface{}
	_ = json.Unmarshal(previous.TabGroups, &groups)
	if len(groups) == 0 {
		order := make([]interface{}, 0)
		for _, session := range m.ListSessions() {
			if session.WorktreeID == worktreeID && session.Status != SessionStopped && sessionTabsID(session) != tabID {
				order = append(order, sessionTabsID(session))
			}
		}
		groups = []map[string]interface{}{{"id": "main", "activeTabId": nil, "tabOrder": order}}
	}
	if targetGroupID == "" {
		targetGroupID, _ = groups[0]["id"].(string)
	}
	foundGroup := false
	for _, group := range groups {
		if group["id"] != targetGroupID {
			continue
		}
		foundGroup = true
		order, _ := group["tabOrder"].([]interface{})
		filtered := make([]interface{}, 0, len(order)+1)
		inserted := false
		for _, value := range order {
			if value == tabID {
				continue
			}
			filtered = append(filtered, value)
			if value == afterTabID {
				filtered = append(filtered, tabID)
				inserted = true
			}
		}
		if !inserted {
			filtered = append(filtered, tabID)
		}
		group["tabOrder"] = filtered
		if activate {
			group["activeTabId"] = tabID
		}
		break
	}
	if !foundGroup {
		return SessionTabLayout{}, errors.New("target tab group not found")
	}
	encoded, err := json.Marshal(groups)
	if err != nil {
		return SessionTabLayout{}, err
	}
	req := sessionTabLayoutSaveRequest(previous, previous.PaneLayoutByTabID, previous.TabPropsByTabID)
	req.TabGroups = encoded
	if activate {
		req.ActiveTabID = tabID
		req.ActiveGroupID = targetGroupID
	}
	return m.SaveSessionTabLayout(worktreeID, req)
}

func (m *Manager) MoveSessionTab(worktreeID string, move MoveSessionTabRequest) (SessionTabLayout, error) {
	worktreeID = normalizeSessionTabsWorktreeSelector(worktreeID)
	move.TabID = strings.TrimSpace(move.TabID)
	move.TargetGroupID = strings.TrimSpace(move.TargetGroupID)
	if !m.sessionTabExists(worktreeID, move.TabID) {
		return SessionTabLayout{}, ErrSessionNotFound
	}
	m.mu.RLock()
	previous := m.sessionTabLayouts[worktreeID]
	m.mu.RUnlock()
	groups := m.currentSessionTabGroups(worktreeID, previous)
	targetIndex := sessionTabGroupIndex(groups, move.TargetGroupID)
	if targetIndex < 0 {
		return SessionTabLayout{}, errors.New("target tab group not found")
	}
	var layout interface{}
	_ = json.Unmarshal(previous.TabGroupLayout, &layout)
	switch move.Kind {
	case "reorder":
		current := sessionTabOrder(groups[targetIndex])
		if !sameSessionTabSet(current, move.TabOrder) {
			return SessionTabLayout{}, errors.New("invalid tab order")
		}
		groups[targetIndex]["tabOrder"] = stringSliceInterfaces(move.TabOrder)
		groups[targetIndex]["activeTabId"] = move.TabID
	case "move-to-group":
		groups = removeSessionTabFromGroups(groups, move.TabID, move.TargetGroupID)
		targetIndex = sessionTabGroupIndex(groups, move.TargetGroupID)
		order := sessionTabOrder(groups[targetIndex])
		index := len(order)
		if move.Index != nil && *move.Index >= 0 && *move.Index < index {
			index = *move.Index
		}
		order = append(order, "")
		copy(order[index+1:], order[index:])
		order[index] = move.TabID
		groups[targetIndex]["tabOrder"] = stringSliceInterfaces(order)
		groups[targetIndex]["activeTabId"] = move.TabID
		layout = pruneSessionTabGroupLayout(layout, groups)
	case "split":
		if len(sessionTabOrder(groups[targetIndex])) > 1 {
			newGroupID := newID("split")
			groups = removeSessionTabFromGroups(groups, move.TabID, "")
			groups = append(groups, map[string]interface{}{"id": newGroupID, "activeTabId": move.TabID, "tabOrder": []interface{}{move.TabID}})
			if layout == nil {
				layout = defaultSessionTabGroupLayout(groups[:len(groups)-1])
			}
			layout = insertSessionTabGroupSplit(layout, move.TargetGroupID, newGroupID, move.SplitDirection)
			move.TargetGroupID = newGroupID
		}
	default:
		return SessionTabLayout{}, errors.New("invalid move kind")
	}
	encodedGroups, err := json.Marshal(groups)
	if err != nil {
		return SessionTabLayout{}, err
	}
	encodedLayout, err := json.Marshal(layout)
	if err != nil {
		return SessionTabLayout{}, err
	}
	req := sessionTabLayoutSaveRequest(previous, previous.PaneLayoutByTabID, previous.TabPropsByTabID)
	req.ActiveTabID, req.ActiveGroupID, req.TabGroups = move.TabID, move.TargetGroupID, encodedGroups
	if layout != nil {
		req.TabGroupLayout = encodedLayout
	}
	return m.SaveSessionTabLayout(worktreeID, req)
}

func (m *Manager) sessionTabExists(worktreeID, tabID string) bool {
	for _, session := range m.ListSessions() {
		if session.WorktreeID == worktreeID && session.Status != SessionStopped && sessionTabsID(session) == tabID {
			return true
		}
	}
	return false
}

func sessionTabLayoutSaveRequest(previous SessionTabLayout, paneLayouts, tabProps map[string]json.RawMessage) SaveSessionTabLayoutRequest {
	return SaveSessionTabLayoutRequest{ActiveTabID: previous.ActiveTabID, ActiveGroupID: previous.ActiveGroupID, TabGroups: previous.TabGroups, TabGroupLayout: previous.TabGroupLayout, PaneLayoutByTabID: paneLayouts, TabPropsByTabID: tabProps}
}

func (m *Manager) currentSessionTabGroups(worktreeID string, layout SessionTabLayout) []map[string]interface{} {
	var groups []map[string]interface{}
	_ = json.Unmarshal(layout.TabGroups, &groups)
	if len(groups) > 0 {
		return groups
	}
	order := make([]interface{}, 0)
	for _, session := range m.ListSessions() {
		if session.WorktreeID == worktreeID && session.Status != SessionStopped {
			order = append(order, sessionTabsID(session))
		}
	}
	return []map[string]interface{}{{"id": "main", "activeTabId": layout.ActiveTabID, "tabOrder": order}}
}

func sessionTabGroupIndex(groups []map[string]interface{}, groupID string) int {
	for index, group := range groups {
		if group["id"] == groupID {
			return index
		}
	}
	return -1
}

func sessionTabOrder(group map[string]interface{}) []string {
	raw, _ := group["tabOrder"].([]interface{})
	order := make([]string, 0, len(raw))
	for _, value := range raw {
		if tabID, ok := value.(string); ok && tabID != "" {
			order = append(order, tabID)
		}
	}
	return order
}

func sameSessionTabSet(current, requested []string) bool {
	if len(current) != len(requested) {
		return false
	}
	seen := make(map[string]bool, len(current))
	for _, tabID := range current {
		seen[tabID] = true
	}
	for _, tabID := range requested {
		if !seen[tabID] {
			return false
		}
		delete(seen, tabID)
	}
	return len(seen) == 0
}

func stringSliceInterfaces(values []string) []interface{} {
	result := make([]interface{}, len(values))
	for index, value := range values {
		result[index] = value
	}
	return result
}

func removeSessionTabFromGroups(groups []map[string]interface{}, tabID, retainGroupID string) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(groups))
	for _, group := range groups {
		order := sessionTabOrder(group)
		filtered := make([]string, 0, len(order))
		for _, candidate := range order {
			if candidate != tabID {
				filtered = append(filtered, candidate)
			}
		}
		group["tabOrder"] = stringSliceInterfaces(filtered)
		if len(filtered) > 0 || group["id"] == retainGroupID {
			result = append(result, group)
		}
	}
	return result
}

func defaultSessionTabGroupLayout(groups []map[string]interface{}) interface{} {
	var layout interface{}
	for _, group := range groups {
		leaf := map[string]interface{}{"type": "leaf", "groupId": group["id"]}
		if layout == nil {
			layout = leaf
		} else {
			layout = map[string]interface{}{"type": "split", "direction": "horizontal", "first": layout, "second": leaf, "ratio": 0.5}
		}
	}
	return layout
}

func insertSessionTabGroupSplit(layout interface{}, targetGroupID, newGroupID, direction string) interface{} {
	node, ok := layout.(map[string]interface{})
	if !ok {
		return layout
	}
	if node["type"] == "leaf" {
		if node["groupId"] != targetGroupID {
			return node
		}
		axis := "vertical"
		if direction == "left" || direction == "right" {
			axis = "horizontal"
		}
		oldLeaf := map[string]interface{}{"type": "leaf", "groupId": targetGroupID}
		newLeaf := map[string]interface{}{"type": "leaf", "groupId": newGroupID}
		if direction == "left" || direction == "up" {
			return map[string]interface{}{"type": "split", "direction": axis, "first": newLeaf, "second": oldLeaf, "ratio": 0.5}
		}
		return map[string]interface{}{"type": "split", "direction": axis, "first": oldLeaf, "second": newLeaf, "ratio": 0.5}
	}
	node["first"] = insertSessionTabGroupSplit(node["first"], targetGroupID, newGroupID, direction)
	node["second"] = insertSessionTabGroupSplit(node["second"], targetGroupID, newGroupID, direction)
	return node
}

func pruneSessionTabGroupLayout(layout interface{}, groups []map[string]interface{}) interface{} {
	// Why: renderer reconciliation can rebuild a balanced layout after an empty
	// group disappears; emitting only live groups prevents stale leaf ids.
	return defaultSessionTabGroupLayout(groups)
}

func sessionTabsID(session Session) string {
	if tabID := strings.TrimSpace(session.TabID); tabID != "" {
		return tabID
	}
	return session.ID
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
