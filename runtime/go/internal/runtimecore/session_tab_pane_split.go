package runtimecore

import (
	"encoding/json"
	"errors"
	"strings"
)

// SplitSessionTabPane replaces one leaf in the renderer-compatible pane tree
// while preserving the rest of the opaque layout snapshot.
func (m *Manager) SplitSessionTabPane(worktreeID, tabID, sourceLeafID, sourcePtyID, newLeafID, newPtyID, direction string) (SessionTabLayout, error) {
	sourceLeafID = strings.TrimSpace(sourceLeafID)
	newLeafID = strings.TrimSpace(newLeafID)
	if sourceLeafID == "" || newLeafID == "" {
		return SessionTabLayout{}, errors.New("source and split leaf ids are required")
	}
	if direction == "" {
		direction = "vertical"
	}
	if direction != "vertical" && direction != "horizontal" {
		return SessionTabLayout{}, errors.New("invalid pane split direction")
	}

	m.mu.RLock()
	previous := m.sessionTabLayouts[normalizeSessionTabsWorktreeSelector(worktreeID)]
	m.mu.RUnlock()
	snapshot := map[string]interface{}{}
	if raw := previous.PaneLayoutByTabID[strings.TrimSpace(tabID)]; len(raw) > 0 {
		if err := json.Unmarshal(raw, &snapshot); err != nil {
			return SessionTabLayout{}, errors.New("invalid existing pane layout")
		}
	}
	root := snapshot["root"]
	if root == nil {
		root = map[string]interface{}{"type": "leaf", "leafId": sourceLeafID}
	}
	replaced, found := replaceSessionPaneLeaf(root, sourceLeafID, newLeafID, direction)
	if !found {
		return SessionTabLayout{}, errors.New("source pane leaf is not present in layout")
	}
	snapshot["root"] = replaced
	snapshot["activeLeafId"] = newLeafID
	if _, exists := snapshot["expandedLeafId"]; !exists {
		snapshot["expandedLeafId"] = nil
	}
	ptyIDs := map[string]string{}
	if value, exists := snapshot["ptyIdsByLeafId"]; exists {
		bytes, _ := json.Marshal(value)
		_ = json.Unmarshal(bytes, &ptyIDs)
	}
	ptyIDs[sourceLeafID] = sourcePtyID
	ptyIDs[newLeafID] = newPtyID
	snapshot["ptyIdsByLeafId"] = ptyIDs
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		return SessionTabLayout{}, err
	}
	return m.UpdateSessionTabPaneLayout(worktreeID, tabID, encoded)
}

func replaceSessionPaneLeaf(node interface{}, sourceLeafID, newLeafID, direction string) (interface{}, bool) {
	object, ok := node.(map[string]interface{})
	if !ok {
		return node, false
	}
	if object["type"] == "leaf" && object["leafId"] == sourceLeafID {
		return map[string]interface{}{
			"type": "split", "direction": direction,
			"first":  object,
			"second": map[string]interface{}{"type": "leaf", "leafId": newLeafID},
		}, true
	}
	for _, key := range []string{"first", "second"} {
		child, exists := object[key]
		if !exists {
			continue
		}
		if replaced, found := replaceSessionPaneLeaf(child, sourceLeafID, newLeafID, direction); found {
			object[key] = replaced
			return object, true
		}
	}
	return object, false
}
