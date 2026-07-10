package runtimecore

import (
	"context"
	"errors"
	"strings"
	"time"
)

// SessionHookState is the agent-hook-reported readiness of the process that
// owns a session's PTY, mirroring Electron's lastAgentStatus values.
type SessionHookState string

const (
	SessionHookWorking    SessionHookState = "working"
	SessionHookIdle       SessionHookState = "idle"
	SessionHookPermission SessionHookState = "permission"
)

type SessionHookStatusRequest struct {
	// State accepts Electron hook payload states (working/waiting/idle) plus the
	// already-resolved "permission" value from callers that classified the event.
	State         string `json:"state"`
	HookEventName string `json:"hookEventName,omitempty"`
	ToolName      string `json:"toolName,omitempty"`
}

type SessionWaitRequest struct {
	// Condition matches the Electron terminal wait contract: exit | tui-idle.
	Condition string   `json:"for,omitempty"`
	TimeoutMs *float64 `json:"timeoutMs,omitempty"`
}

type SessionWaitResult struct {
	SessionID      string           `json:"sessionId"`
	Condition      string           `json:"condition"`
	Satisfied      bool             `json:"satisfied"`
	TimedOut       bool             `json:"timedOut"`
	Status         SessionStatus    `json:"status"`
	HookAgentState SessionHookState `json:"hookAgentState,omitempty"`
	ExitCode       *int             `json:"exitCode,omitempty"`
}

// Matches Electron's TUI_IDLE_DEFAULT_TIMEOUT_MS ceiling for tui-idle waits;
// exit waits keep the caller-provided timeout (default below) as well.
const (
	defaultSessionWaitTimeout = 30 * time.Second
	maxSessionWaitTimeout     = 10 * time.Minute
)

var errInvalidSessionWaitCondition = errors.New("invalid wait condition; supported: exit, tui-idle")

func normalizeSessionHookState(raw string, hookEventName string) (SessionHookState, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "working":
		return SessionHookWorking, nil
	case "idle", "done":
		return SessionHookIdle, nil
	case "permission":
		return SessionHookPermission, nil
	case "waiting":
		// Why: Electron's hook payloads report permission prompts as
		// state=waiting (+PermissionRequest); either way the agent is blocked on
		// the user, which is 'permission' in the terminal agent-status contract.
		_ = hookEventName
		return SessionHookPermission, nil
	default:
		return "", errors.New("invalid hook state; supported: working, waiting, idle, permission")
	}
}

// ReportSessionHookStatus records agent-hook-reported readiness for a session.
// The id may be the session id or the launch token stamped into the PTY env,
// since hook scripts only know their own launch identity.
func (m *Manager) ReportSessionHookStatus(id string, req SessionHookStatusRequest) (Session, error) {
	state, err := normalizeSessionHookState(req.State, req.HookEventName)
	if err != nil {
		return Session{}, err
	}
	session, err := m.findSessionByIDOrLaunchToken(id)
	if err != nil {
		return Session{}, err
	}
	snapshot := session.setHookAgentState(state)
	m.emit("session.status", snapshot)
	return snapshot, nil
}

func (m *Manager) findSessionByIDOrLaunchToken(id string) (*processSession, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if session, ok := m.sessions[id]; ok {
		return session, nil
	}
	for _, session := range m.sessions {
		if session.matchesLaunchToken(id) {
			return session, nil
		}
	}
	return nil, ErrSessionNotFound
}

// WaitSession blocks until the requested condition is met, the timeout lapses,
// or ctx is cancelled. tui-idle is satisfied only by hook-reported idle (or
// process exit) — permission means blocked on the user, matching Electron.
func (m *Manager) WaitSession(ctx context.Context, id string, req SessionWaitRequest) (SessionWaitResult, error) {
	condition := strings.TrimSpace(req.Condition)
	if condition == "" {
		condition = "exit"
	}
	if condition != "exit" && condition != "tui-idle" {
		return SessionWaitResult{}, errInvalidSessionWaitCondition
	}
	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()
	if !ok {
		return SessionWaitResult{}, ErrSessionNotFound
	}
	timeout := defaultSessionWaitTimeout
	if req.TimeoutMs != nil && *req.TimeoutMs > 0 {
		timeout = time.Duration(*req.TimeoutMs) * time.Millisecond
	}
	if timeout > maxSessionWaitTimeout {
		timeout = maxSessionWaitTimeout
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		// Grab the change channel before reading state so a transition between
		// the check and the select cannot be missed.
		changed := session.stateChangeChannel()
		snapshot := session.snapshot()
		if satisfied := sessionWaitSatisfied(condition, snapshot); satisfied {
			return buildSessionWaitResult(condition, snapshot, true, false), nil
		}
		select {
		case <-ctx.Done():
			return SessionWaitResult{}, ctx.Err()
		case <-deadline.C:
			return buildSessionWaitResult(condition, session.snapshot(), false, true), nil
		case <-changed:
		}
	}
}

func sessionWaitSatisfied(condition string, snapshot Session) bool {
	exited := snapshot.Status != SessionStarting && snapshot.Status != SessionRunning
	if condition == "exit" {
		return exited
	}
	// tui-idle: hook-reported idle means the TUI is ready for input; a dead
	// session can never become ready, so exit also resolves the wait.
	return exited || snapshot.HookAgentState == SessionHookIdle
}

func buildSessionWaitResult(condition string, snapshot Session, satisfied bool, timedOut bool) SessionWaitResult {
	return SessionWaitResult{
		SessionID:      snapshot.ID,
		Condition:      condition,
		Satisfied:      satisfied,
		TimedOut:       timedOut,
		Status:         snapshot.Status,
		HookAgentState: snapshot.HookAgentState,
		ExitCode:       snapshot.ExitCode,
	}
}

func (s *processSession) setHookAgentState(state SessionHookState) Session {
	s.mu.Lock()
	s.hookAgentState = state
	s.hookAgentStateAt = time.Now().UTC()
	s.updatedAt = s.hookAgentStateAt
	s.notifyStateChangedLocked()
	snapshot := s.snapshotLocked()
	s.mu.Unlock()
	return snapshot
}

func (s *processSession) matchesLaunchToken(token string) bool {
	if token == "" {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.launchToken != "" && s.launchToken == token
}
