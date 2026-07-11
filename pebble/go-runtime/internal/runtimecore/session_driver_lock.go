package runtimecore

import "errors"

// SessionDriverState mirrors Electron's presence-based terminal driver lock
// (docs/mobile-presence-lock.md): exactly one driver per session at a time.
type SessionDriverState struct {
	Kind     string `json:"kind"` // "idle" | "desktop" | "mobile"
	ClientID string `json:"clientId,omitempty"`
}

// SessionInputSource identifies who is writing so the runtime can enforce the
// presence lock: desktop writes are refused while a mobile client drives.
type SessionInputSource string

const (
	SessionInputSourceDesktop SessionInputSource = "desktop"
	SessionInputSourceMobile  SessionInputSource = "mobile"
)

// ErrSessionInputLocked is returned for desktop-sourced writes while a mobile
// client holds the floor, matching Electron's refused pty:write acknowledge.
var ErrSessionInputLocked = errors.New("session input is locked by a mobile client")

func (m *Manager) GetSessionDriver(sessionID string) SessionDriverState {
	m.mu.RLock()
	driver, ok := m.sessionDrivers[sessionID]
	m.mu.RUnlock()
	if !ok {
		return SessionDriverState{Kind: "idle"}
	}
	return driver
}

// MobileTookSessionFloor records a deliberate mobile action on a session:
// the actor becomes the driver (most-recent-actor wins) and a session.driver
// event notifies the desktop shell so its lock banner can mount.
func (m *Manager) MobileTookSessionFloor(sessionID string, clientID string) {
	m.setSessionDriver(sessionID, SessionDriverState{Kind: "mobile", ClientID: clientID})
}

// ReclaimSessionForDesktop flips the driver to desktop (idempotent), so
// desktop input is accepted again. Returns whether a mobile lock was held.
func (m *Manager) ReclaimSessionForDesktop(sessionID string) bool {
	previous := m.GetSessionDriver(sessionID)
	m.setSessionDriver(sessionID, SessionDriverState{Kind: "desktop"})
	return previous.Kind == "mobile"
}

func (m *Manager) setSessionDriver(sessionID string, driver SessionDriverState) {
	m.mu.Lock()
	previous := m.sessionDrivers[sessionID]
	changed := previous != driver
	if changed {
		m.sessionDrivers[sessionID] = driver
	}
	m.mu.Unlock()
	if changed {
		m.emit("session.driver", map[string]interface{}{
			"sessionId": sessionID,
			"driver":    driver,
		})
	}
}

// WriteSessionFromClient enforces Electron's presence-lock write semantics:
// desktop writes are refused while mobile drives; mobile writes take the
// floor. Sourceless writes stay accepted for pre-refactor callers, matching
// Electron's clientless-legacy-mobile compatibility path.
func (m *Manager) WriteSessionFromClient(sessionID string, req SessionInputRequest, source SessionInputSource, clientID string) error {
	if source == SessionInputSourceDesktop && m.GetSessionDriver(sessionID).Kind == "mobile" {
		return ErrSessionInputLocked
	}
	if err := m.WriteSession(sessionID, req); err != nil {
		return err
	}
	if source == SessionInputSourceMobile && clientID != "" {
		m.MobileTookSessionFloor(sessionID, clientID)
	}
	return nil
}

// SessionResizeAllowedFor gates desktop resizes while mobile drives —
// Electron treats this as the load-bearing layer because the renderer's
// driver mirror lags by one hop.
func (m *Manager) SessionResizeAllowedFor(sessionID string, source SessionInputSource) bool {
	if source != SessionInputSourceDesktop {
		return true
	}
	return m.GetSessionDriver(sessionID).Kind != "mobile"
}
