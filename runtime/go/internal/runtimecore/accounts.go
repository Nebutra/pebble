package runtimecore

import (
	"encoding/json"
	"errors"
)

type AccountsSnapshot struct {
	Claude     json.RawMessage `json:"claude"`
	Codex      json.RawMessage `json:"codex"`
	RateLimits json.RawMessage `json:"rateLimits"`
}

func (m *Manager) GetAccountsSnapshot() json.RawMessage {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return append(json.RawMessage(nil), m.accountsSnapshot...)
}

func (m *Manager) SetAccountsSnapshot(snapshot AccountsSnapshot) (json.RawMessage, error) {
	if !validJSONObject(snapshot.Claude) || !validJSONObject(snapshot.Codex) || !validJSONObject(snapshot.RateLimits) {
		return nil, errors.New("accounts snapshot fields must be JSON objects")
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.accountsSnapshot = append(m.accountsSnapshot[:0], encoded...)
	err = m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return nil, err
	}
	result := append(json.RawMessage(nil), encoded...)
	m.emit("accounts.changed", result)
	return result, nil
}

func validJSONObject(raw json.RawMessage) bool {
	if len(raw) == 0 || !json.Valid(raw) {
		return false
	}
	var value map[string]interface{}
	return json.Unmarshal(raw, &value) == nil && value != nil
}
