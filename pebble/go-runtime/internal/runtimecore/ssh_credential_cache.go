package runtimecore

import "sync"

// sshCredentialCache mirrors Electron's per-connection in-memory credential
// cache (SshConnection.cachedPassphrase/cachedPassword): credentials live only
// in process memory for the runtime's lifetime and are never written to the
// state file. The zero value is ready to use so Manager needs no constructor
// wiring, and the dedicated mutex keeps credential access decoupled from the
// persistence lock — the cache can never be captured by a state snapshot.
type sshCredentialCache struct {
	mu       sync.Mutex
	byTarget map[string]sshCachedCredential
}

type sshCachedCredential struct {
	passphrase string
	password   string
}

// SshCredentialKind mirrors src/main/ssh/ssh-connection-utils SshCredentialKind.
const (
	SshCredentialKindPassphrase = "passphrase"
	SshCredentialKindPassword   = "password"
)

// SshCredentialStatus reports cache presence without ever echoing the secret.
type SshCredentialStatus struct {
	Cached bool `json:"cached"`
	// PromptRequired mirrors Electron ssh:needsPassphrasePrompt —
	// lastRequiredPassphrase persisted flag AND no in-memory credential.
	PromptRequired bool `json:"promptRequired"`
}

func (c *sshCredentialCache) set(targetID string, kind string, value string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.byTarget == nil {
		c.byTarget = make(map[string]sshCachedCredential)
	}
	entry := c.byTarget[targetID]
	// Why: Electron keeps passphrase and password caches side by side (an agent
	// fallback may need a password while the key still needs its passphrase).
	if kind == SshCredentialKindPassword {
		entry.password = value
	} else {
		entry.passphrase = value
	}
	c.byTarget[targetID] = entry
}

func (c *sshCredentialCache) get(targetID string) (sshCachedCredential, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.byTarget[targetID]
	return entry, ok
}

func (c *sshCredentialCache) clear(targetID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.byTarget, targetID)
}

// SeedSshCredential stores a prompt-obtained credential for a target in memory
// only. The desktop calls this after the user answers a passphrase/password
// prompt so later auto-connect gating stops re-prompting (Electron parity:
// SshConnection caches the value after onCredentialRequest resolves).
func (m *Manager) SeedSshCredential(targetID string, kind string, value string) (SshCredentialStatus, error) {
	if _, ok := m.GetSshTarget(targetID); !ok {
		return SshCredentialStatus{}, ErrNotFound
	}
	m.sshCredentials.set(targetID, kind, value)
	return m.SshCredentialStatus(targetID)
}

// ClearSshCredential drops any cached credential for a target. Called on
// explicit invalidation (auth failure, disconnect) and on target removal;
// idempotent so callers never need existence checks.
func (m *Manager) ClearSshCredential(targetID string) SshCredentialStatus {
	m.sshCredentials.clear(targetID)
	status, _ := m.SshCredentialStatus(targetID)
	return status
}

// SshCredentialStatus reports whether a credential is cached and whether an
// auto-connect flow must still prompt. It never returns the secret itself.
func (m *Manager) SshCredentialStatus(targetID string) (SshCredentialStatus, error) {
	target, ok := m.GetSshTarget(targetID)
	if !ok {
		return SshCredentialStatus{}, ErrNotFound
	}
	_, cached := m.sshCredentials.get(targetID)
	required := target.LastRequiredPassphrase != nil && *target.LastRequiredPassphrase
	return SshCredentialStatus{Cached: cached, PromptRequired: required && !cached}, nil
}

// CachedSshCredential exposes the raw cached values for a future native
// connect/relay path. Callers must never log or persist the returned values.
func (m *Manager) CachedSshCredential(targetID string) (passphrase string, password string, ok bool) {
	entry, ok := m.sshCredentials.get(targetID)
	return entry.passphrase, entry.password, ok
}
