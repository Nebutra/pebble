package runtimecore

import (
	"encoding/json"
	"strconv"
)

// agentHookProtocolVersion matches PEBBLE_HOOK_PROTOCOL_VERSION in
// src/shared/agent-hook-types.ts so unmodified Electron-installed hook
// scripts speak the same version handshake to the Go runtime.
const agentHookProtocolVersion = "1"

// sessionHookEndpoint is where hook scripts POST agent events. Stamped into
// every PTY env so the same managed scripts Electron installs (which read
// PEBBLE_AGENT_HOOK_PORT/TOKEN from their environment) reach the Go runtime.
type sessionHookEndpoint struct {
	port  int
	token string
}

// ConfigureSessionHookEndpoint tells the manager which local port/token hook
// scripts should target; called once by the HTTP server after it binds.
func (m *Manager) ConfigureSessionHookEndpoint(port int, token string) {
	m.mu.Lock()
	m.hookEndpoint = sessionHookEndpoint{port: port, token: token}
	m.mu.Unlock()
}

func (m *Manager) currentSessionHookEndpoint() sessionHookEndpoint {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.hookEndpoint
}

// agentHookSessionEnv mirrors the env contract of Electron's hook transport
// (see src/main/agent-hooks + the per-agent managed scripts): scripts require
// PORT, TOKEN, and PANE_KEY, and attribute events via LAUNCH_TOKEN.
func agentHookSessionEnv(endpoint sessionHookEndpoint, session *processSession) []string {
	paneKey := session.id
	if session.tabID != "" && session.leafID != "" {
		paneKey = session.tabID + ":" + session.leafID
	}
	return []string{
		"PEBBLE_AGENT_HOOK_PORT=" + strconv.Itoa(endpoint.port),
		"PEBBLE_AGENT_HOOK_TOKEN=" + endpoint.token,
		"PEBBLE_AGENT_HOOK_ENV=pebble-go-runtime",
		"PEBBLE_AGENT_HOOK_VERSION=" + agentHookProtocolVersion,
		"PEBBLE_AGENT_LAUNCH_TOKEN=" + session.launchToken,
		"PEBBLE_PANE_KEY=" + paneKey,
		"PEBBLE_TAB_ID=" + session.tabID,
		"PEBBLE_WORKTREE_ID=" + session.worktreeID,
	}
}

// AgentHookIngestRequest is the form-encoded body the managed hook scripts
// POST to /hook/{source} (paneKey/launchToken identify the PTY; payload is
// the agent's raw hook JSON from stdin).
type AgentHookIngestRequest struct {
	Source      string
	PaneKey     string
	TabID       string
	LaunchToken string
	Payload     string
}

type AgentHookIngestResult struct {
	Accepted  bool             `json:"accepted"`
	Reason    string           `json:"reason,omitempty"`
	SessionID string           `json:"sessionId,omitempty"`
	State     SessionHookState `json:"state,omitempty"`
}

// IngestAgentHookEvent classifies a raw hook payload into the session
// hook-state contract and records it. Best-effort by design: hook scripts
// fire-and-forget, so unresolvable sessions or unknown events are reported as
// not-accepted instead of errors.
func (m *Manager) IngestAgentHookEvent(req AgentHookIngestRequest) AgentHookIngestResult {
	state, ok := classifyAgentHookPayload(req.Payload)
	if !ok {
		return AgentHookIngestResult{Accepted: false, Reason: "unrecognized_event"}
	}
	session := m.resolveHookSession(req)
	if session == nil {
		return AgentHookIngestResult{Accepted: false, Reason: "session_not_found"}
	}
	snapshot := session.setHookAgentState(state)
	m.emit("session.status", snapshot)
	return AgentHookIngestResult{Accepted: true, SessionID: snapshot.ID, State: state}
}

// classifyAgentHookPayload maps Claude-shaped hook events (the schema shared
// by the managed scripts for Claude/Codex/Gemini/Droid/&c.) onto the
// working/idle/permission readiness contract. Payloads that carry an explicit
// `state` field (relay-style) fall through to the shared state normalizer.
func classifyAgentHookPayload(payload string) (SessionHookState, bool) {
	var parsed struct {
		HookEventName      string `json:"hook_event_name"`
		HookEventNameCamel string `json:"hookEventName"`
		State              string `json:"state"`
	}
	if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
		return "", false
	}
	event := parsed.HookEventName
	if event == "" {
		event = parsed.HookEventNameCamel
	}
	switch event {
	case "Stop", "StopFailure", "SubagentStop":
		return SessionHookIdle, true
	case "PermissionRequest", "Notification":
		// Notification is Claude's "waiting for user input" signal; both mean
		// the agent is blocked on the user, i.e. 'permission'.
		return SessionHookPermission, true
	case "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PreCompact", "SessionStart":
		return SessionHookWorking, true
	}
	if state, err := normalizeSessionHookState(parsed.State, event); err == nil {
		return state, true
	}
	return "", false
}

// resolveHookSession resolves by launch token first (the only identity a hook
// script reliably owns), then by pane key as a session id or tab:leaf pair.
func (m *Manager) resolveHookSession(req AgentHookIngestRequest) *processSession {
	if req.LaunchToken != "" {
		if session, err := m.findSessionByIDOrLaunchToken(req.LaunchToken); err == nil {
			return session
		}
	}
	if req.PaneKey == "" {
		return nil
	}
	if session, err := m.findSessionByIDOrLaunchToken(req.PaneKey); err == nil {
		return session
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, session := range m.sessions {
		if session.matchesPaneKey(req.PaneKey) {
			return session
		}
	}
	return nil
}

func (s *processSession) matchesPaneKey(paneKey string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.tabID != "" && s.leafID != "" && s.tabID+":"+s.leafID == paneKey
}
