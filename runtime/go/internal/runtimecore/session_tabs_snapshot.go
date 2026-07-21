package runtimecore

import (
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"
)

func (m *Manager) SessionTabsSnapshot(worktreeSelector string) map[string]interface{} {
	worktreeID := normalizeSessionTabsWorktreeSelector(worktreeSelector)
	sessions := m.ListSessions()
	m.mu.RLock()
	layout := m.sessionTabLayouts[worktreeID]
	publicationEpoch := m.relayID
	m.mu.RUnlock()
	return buildSessionTabsSnapshot(worktreeID, publicationEpoch, layout, sessions)
}

func (m *Manager) AllSessionTabsSnapshots() []map[string]interface{} {
	sessions := m.ListSessions()
	m.mu.RLock()
	worktreeIDs := make(map[string]struct{}, len(m.sessionTabLayouts))
	for worktreeID := range m.sessionTabLayouts {
		worktreeIDs[worktreeID] = struct{}{}
	}
	for worktreeID := range m.worktrees {
		worktreeIDs[worktreeID] = struct{}{}
	}
	layouts := make(map[string]SessionTabLayout, len(m.sessionTabLayouts))
	for worktreeID, layout := range m.sessionTabLayouts {
		layouts[worktreeID] = layout
	}
	publicationEpoch := m.relayID
	m.mu.RUnlock()
	for _, session := range sessions {
		if session.WorktreeID != "" {
			worktreeIDs[session.WorktreeID] = struct{}{}
		}
	}
	ordered := make([]string, 0, len(worktreeIDs))
	for worktreeID := range worktreeIDs {
		ordered = append(ordered, worktreeID)
	}
	sort.Strings(ordered)
	result := make([]map[string]interface{}, 0, len(ordered))
	for _, worktreeID := range ordered {
		result = append(result, buildSessionTabsSnapshot(worktreeID, publicationEpoch, layouts[worktreeID], sessions))
	}
	return result
}

func buildSessionTabsSnapshot(worktreeID, publicationEpoch string, layout SessionTabLayout, sessions []Session) map[string]interface{} {
	matching := make([]Session, 0)
	for _, session := range sessions {
		if session.WorktreeID == worktreeID && session.Status != SessionStopped {
			matching = append(matching, session)
		}
	}
	tabs := make([]map[string]interface{}, 0, len(matching))
	topLevelIDs := make([]string, 0, len(matching))
	maxVersion := layout.SnapshotVersion
	for _, session := range matching {
		tabID := strings.TrimSpace(session.TabID)
		if tabID == "" {
			tabID = session.ID
		}
		leafID := strings.TrimSpace(session.LeafID)
		if leafID == "" {
			leafID = tabID
		}
		topLevelIDs = append(topLevelIDs, tabID)
		tab := map[string]interface{}{
			"type": "terminal", "id": leafID, "title": sessionTabsTerminalTitle(session),
			"parentTabId": tabID, "leafId": leafID, "ptyId": session.ID,
			"terminal": session.ID, "status": "ready", "startupCwd": session.Cwd,
			"isActive": false,
		}
		mergeSessionTabProps(tab, layout.TabPropsByTabID[tabID])
		if paneLayout := layout.PaneLayoutByTabID[tabID]; len(paneLayout) > 0 {
			var parsed map[string]interface{}
			if json.Unmarshal(paneLayout, &parsed) == nil {
				parsed["activeLeafId"] = leafID
				tab["parentLayout"] = parsed
			}
		}
		tabs = append(tabs, tab)
		if version := session.UpdatedAt.UnixMilli(); version > maxVersion {
			maxVersion = version
		}
	}
	activeTabID := strings.TrimSpace(layout.ActiveTabID)
	if !containsSessionTabID(topLevelIDs, activeTabID) {
		if len(topLevelIDs) > 0 {
			activeTabID = topLevelIDs[len(topLevelIDs)-1]
		} else {
			activeTabID = ""
		}
	}
	for _, tab := range tabs {
		tab["isActive"] = tab["parentTabId"] == activeTabID
	}
	tabGroups := decodeSessionTabGroups(layout.TabGroups, topLevelIDs, activeTabID)
	activeGroupID := strings.TrimSpace(layout.ActiveGroupID)
	if activeGroupID == "" && len(tabGroups) > 0 {
		activeGroupID, _ = tabGroups[0]["id"].(string)
	}
	return map[string]interface{}{
		"worktree": worktreeID, "publicationEpoch": publicationEpoch,
		"snapshotVersion": maxVersion, "activeGroupId": nullableSessionTabsString(activeGroupID),
		"activeTabId":   nullableSessionTabsString(activeTabID),
		"activeTabType": nullableSessionTabsType(activeTabID), "tabGroups": tabGroups,
		"tabGroupLayout": decodeNullableSessionTabsJSON(layout.TabGroupLayout), "tabs": tabs,
	}
}

func decodeSessionTabGroups(raw json.RawMessage, tabIDs []string, activeTabID string) []map[string]interface{} {
	var groups []map[string]interface{}
	if len(raw) > 0 && json.Unmarshal(raw, &groups) == nil && len(groups) > 0 {
		return groups
	}
	if len(tabIDs) == 0 {
		return []map[string]interface{}{}
	}
	return []map[string]interface{}{{"id": "main", "activeTabId": nullableSessionTabsString(activeTabID), "tabOrder": tabIDs}}
}

func mergeSessionTabProps(tab map[string]interface{}, raw json.RawMessage) {
	if len(raw) == 0 {
		return
	}
	var props map[string]interface{}
	if json.Unmarshal(raw, &props) != nil {
		return
	}
	for _, key := range []string{"color", "customTitle", "isPinned", "viewMode"} {
		if value, exists := props[key]; exists {
			tab[key] = value
		}
	}
}

func sessionTabsTerminalTitle(session Session) string {
	if session.AgentKind != "" {
		return session.AgentKind
	}
	if len(session.Command) > 0 && strings.TrimSpace(session.Command[0]) != "" {
		return filepath.Base(session.Command[0])
	}
	return filepath.Base(session.Cwd)
}

func normalizeSessionTabsWorktreeSelector(selector string) string {
	selector = strings.TrimSpace(selector)
	return strings.TrimPrefix(selector, "id:")
}

func containsSessionTabID(ids []string, candidate string) bool {
	for _, id := range ids {
		if id == candidate {
			return true
		}
	}
	return false
}

func nullableSessionTabsString(value string) interface{} {
	if value == "" {
		return nil
	}
	return value
}

func nullableSessionTabsType(activeTabID string) interface{} {
	if activeTabID == "" {
		return nil
	}
	return "terminal"
}

func decodeNullableSessionTabsJSON(raw json.RawMessage) interface{} {
	if len(raw) == 0 {
		return nil
	}
	var value interface{}
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return value
}
