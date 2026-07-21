package runtimecore

import (
	"crypto/rand"
	"encoding/hex"
	"sort"
	"time"
)

const automationDispatchTokenTTL = 30 * time.Minute

type automationDispatchTokenRecord struct {
	AutomationID string
	RunID        string
	ExpiresAt    time.Time
	ReservedBy   string
	InFlight     bool
}

type AutomationRendererDispatch struct {
	Automation    Automation    `json:"automation"`
	Run           AutomationRun `json:"run"`
	DispatchToken string        `json:"dispatchToken"`
}

func (m *Manager) issueAutomationDispatchToken(automationID, runID string) (string, error) {
	token, err := newAutomationDispatchToken()
	if err != nil {
		return "", err
	}
	now := time.Now().UTC()
	m.mu.Lock()
	m.pruneAutomationDispatchTokensLocked(now)
	m.automationDispatchTokens[token] = automationDispatchTokenRecord{
		AutomationID: automationID,
		RunID:        runID,
		ExpiresAt:    now.Add(automationDispatchTokenTTL),
	}
	m.mu.Unlock()
	return token, nil
}

func newAutomationDispatchToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

func (m *Manager) pruneAutomationDispatchTokensLocked(now time.Time) {
	for token, record := range m.automationDispatchTokens {
		if !record.ExpiresAt.After(now) {
			delete(m.automationDispatchTokens, token)
		}
	}
}

// CatchUpAutomationRendererDispatches closes the startup gap where a due run
// can be recorded before the renderer has attached its live event listener.
func (m *Manager) CatchUpAutomationRendererDispatches() ([]AutomationRendererDispatch, error) {
	m.mu.RLock()
	pending := make([]AutomationRendererDispatch, 0)
	for _, run := range m.automationRuns {
		automation, ok := m.automations[run.AutomationID]
		if !ok || run.Status != AutomationRunQueued || run.DispatchState != nil ||
			!hasRendererAutomationPayload(run.Payload) {
			continue
		}
		pending = append(pending, AutomationRendererDispatch{Automation: automation, Run: run})
	}
	m.mu.RUnlock()
	sort.Slice(pending, func(i, j int) bool {
		return pending[i].Run.CreatedAt.Before(pending[j].Run.CreatedAt)
	})
	dispatches := make([]AutomationRendererDispatch, 0, len(pending))
	for _, candidate := range pending {
		token, err := newAutomationDispatchToken()
		if err != nil {
			return nil, err
		}
		now := time.Now().UTC()
		m.mu.Lock()
		run, runOK := m.automationRuns[candidate.Run.ID]
		automation, automationOK := m.automations[run.AutomationID]
		if !runOK || !automationOK || run.Status != AutomationRunQueued ||
			run.DispatchState != nil || !hasRendererAutomationPayload(run.Payload) {
			m.mu.Unlock()
			continue
		}
		m.pruneAutomationDispatchTokensLocked(now)
		m.automationDispatchTokens[token] = automationDispatchTokenRecord{
			AutomationID: automation.ID,
			RunID:        run.ID,
			ExpiresAt:    now.Add(automationDispatchTokenTTL),
		}
		m.mu.Unlock()
		dispatches = append(dispatches, AutomationRendererDispatch{
			Automation: automation, Run: run, DispatchToken: token,
		})
	}
	return dispatches, nil
}
