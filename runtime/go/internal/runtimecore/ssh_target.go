package runtimecore

import (
	"bufio"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// sshProbeTimeout bounds the system-ssh connectivity probe. It is BatchMode
// fail-closed without a cache and permits exactly one askpass attempt when the
// user has already supplied a memory-only credential.
const sshProbeTimeout = 12 * time.Second

// SshTarget mirrors packages/product-core/shared/ssh-types.ts SshTarget for the fields the
// desktop CRUD and probe surfaces persist. Relay-only fields (port forwards,
// grace period) are round-tripped as opaque JSON so the runtime never drops a
// desktop-authored value it does not itself interpret.
type SshTarget struct {
	ID                       string                 `json:"id"`
	Label                    string                 `json:"label"`
	ConfigHost               string                 `json:"configHost,omitempty"`
	Host                     string                 `json:"host"`
	Port                     int                    `json:"port"`
	Username                 string                 `json:"username"`
	IdentityFile             string                 `json:"identityFile,omitempty"`
	IdentityAgent            string                 `json:"identityAgent,omitempty"`
	IdentitiesOnly           *bool                  `json:"identitiesOnly,omitempty"`
	ProxyCommand             string                 `json:"proxyCommand,omitempty"`
	JumpHost                 string                 `json:"jumpHost,omitempty"`
	Source                   string                 `json:"source,omitempty"`
	RelayGracePeriodSeconds  *int                   `json:"relayGracePeriodSeconds,omitempty"`
	LastRequiredPassphrase   *bool                  `json:"lastRequiredPassphrase,omitempty"`
	PortForwards             []SavedSshPortForward  `json:"portForwards,omitempty"`
	SystemSshConnectionReuse *bool                  `json:"systemSshConnectionReuse,omitempty"`
	Owner                    map[string]interface{} `json:"owner,omitempty"`
	CreatedAt                time.Time              `json:"createdAt"`
	UpdatedAt                time.Time              `json:"updatedAt"`
}

type SavedSshPortForward struct {
	ID         string `json:"id,omitempty"`
	LocalPort  int    `json:"localPort"`
	RemoteHost string `json:"remoteHost"`
	RemotePort int    `json:"remotePort"`
	Label      string `json:"label,omitempty"`
}

// SshTargetInput is the desktop-authored create/update payload. Pointer/omitted
// distinction is not needed for creates, so plain fields are used and defaults
// are filled in when persisting.
type SshTargetInput struct {
	Label                    string                 `json:"label"`
	ConfigHost               string                 `json:"configHost,omitempty"`
	Host                     string                 `json:"host"`
	Port                     int                    `json:"port,omitempty"`
	Username                 string                 `json:"username"`
	IdentityFile             string                 `json:"identityFile,omitempty"`
	IdentityAgent            string                 `json:"identityAgent,omitempty"`
	IdentitiesOnly           *bool                  `json:"identitiesOnly,omitempty"`
	ProxyCommand             string                 `json:"proxyCommand,omitempty"`
	JumpHost                 string                 `json:"jumpHost,omitempty"`
	Source                   string                 `json:"source,omitempty"`
	RelayGracePeriodSeconds  *int                   `json:"relayGracePeriodSeconds,omitempty"`
	PortForwards             []SavedSshPortForward  `json:"portForwards,omitempty"`
	SystemSshConnectionReuse *bool                  `json:"systemSshConnectionReuse,omitempty"`
	Owner                    map[string]interface{} `json:"owner,omitempty"`
}

// SshTargetUpdate is a sparse patch. Only non-nil pointer fields are applied so
// omitted keys keep their persisted value.
type SshTargetUpdate struct {
	Label                    *string                `json:"label,omitempty"`
	ConfigHost               *string                `json:"configHost,omitempty"`
	Host                     *string                `json:"host,omitempty"`
	Port                     *int                   `json:"port,omitempty"`
	Username                 *string                `json:"username,omitempty"`
	IdentityFile             *string                `json:"identityFile,omitempty"`
	IdentityAgent            *string                `json:"identityAgent,omitempty"`
	IdentitiesOnly           *bool                  `json:"identitiesOnly,omitempty"`
	ProxyCommand             *string                `json:"proxyCommand,omitempty"`
	JumpHost                 *string                `json:"jumpHost,omitempty"`
	Source                   *string                `json:"source,omitempty"`
	RelayGracePeriodSeconds  *int                   `json:"relayGracePeriodSeconds,omitempty"`
	LastRequiredPassphrase   *bool                  `json:"lastRequiredPassphrase,omitempty"`
	PortForwards             *[]SavedSshPortForward `json:"portForwards,omitempty"`
	SystemSshConnectionReuse *bool                  `json:"systemSshConnectionReuse,omitempty"`
}

// SshProbeResult mirrors the desktop testConnection contract shape so the TS
// bridge can return it verbatim.
type SshProbeResult struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
	Status  string `json:"status"`
}

func (m *Manager) CreateSshTarget(input SshTargetInput) (SshTarget, error) {
	label := strings.TrimSpace(input.Label)
	host := strings.TrimSpace(input.Host)
	if host == "" {
		return SshTarget{}, errors.New("ssh target host is required")
	}
	if label == "" {
		label = host
	}
	configHost := strings.TrimSpace(input.ConfigHost)
	if configHost == "" {
		configHost = host
	}
	port := input.Port
	if port == 0 {
		port = 22
	}
	// Why: match SshConnectionStore.addTarget — user-created targets default to
	// 'manual' so a later ~/.ssh/config import never overwrites them.
	source := strings.TrimSpace(input.Source)
	if source == "" {
		source = "manual"
	}
	now := time.Now().UTC()
	target := SshTarget{
		ID:                       newID("ssh"),
		Label:                    label,
		ConfigHost:               configHost,
		Host:                     host,
		Port:                     port,
		Username:                 strings.TrimSpace(input.Username),
		IdentityFile:             strings.TrimSpace(input.IdentityFile),
		IdentityAgent:            strings.TrimSpace(input.IdentityAgent),
		IdentitiesOnly:           input.IdentitiesOnly,
		ProxyCommand:             strings.TrimSpace(input.ProxyCommand),
		JumpHost:                 strings.TrimSpace(input.JumpHost),
		Source:                   source,
		RelayGracePeriodSeconds:  input.RelayGracePeriodSeconds,
		PortForwards:             input.PortForwards,
		SystemSshConnectionReuse: input.SystemSshConnectionReuse,
		Owner:                    input.Owner,
		CreatedAt:                now,
		UpdatedAt:                now,
	}
	m.mu.Lock()
	m.sshTargets[target.ID] = target
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return SshTarget{}, err
	}
	m.emit("ssh.target.changed", target)
	return target, nil
}

func (m *Manager) UpdateSshTarget(id string, update SshTargetUpdate) (SshTarget, error) {
	m.mu.Lock()
	target, ok := m.sshTargets[id]
	if !ok {
		m.mu.Unlock()
		return SshTarget{}, ErrNotFound
	}
	if update.Label != nil {
		target.Label = strings.TrimSpace(*update.Label)
	}
	if update.ConfigHost != nil {
		target.ConfigHost = strings.TrimSpace(*update.ConfigHost)
	}
	if update.Host != nil {
		target.Host = strings.TrimSpace(*update.Host)
	}
	if update.Port != nil {
		target.Port = *update.Port
	}
	if update.Username != nil {
		target.Username = strings.TrimSpace(*update.Username)
	}
	if update.IdentityFile != nil {
		target.IdentityFile = strings.TrimSpace(*update.IdentityFile)
	}
	if update.IdentityAgent != nil {
		target.IdentityAgent = strings.TrimSpace(*update.IdentityAgent)
	}
	if update.IdentitiesOnly != nil {
		target.IdentitiesOnly = update.IdentitiesOnly
	}
	if update.ProxyCommand != nil {
		target.ProxyCommand = strings.TrimSpace(*update.ProxyCommand)
	}
	if update.JumpHost != nil {
		target.JumpHost = strings.TrimSpace(*update.JumpHost)
	}
	if update.Source != nil {
		target.Source = strings.TrimSpace(*update.Source)
	}
	if update.RelayGracePeriodSeconds != nil {
		target.RelayGracePeriodSeconds = update.RelayGracePeriodSeconds
	}
	if update.LastRequiredPassphrase != nil {
		target.LastRequiredPassphrase = update.LastRequiredPassphrase
	}
	if update.PortForwards != nil {
		target.PortForwards = *update.PortForwards
	}
	if update.SystemSshConnectionReuse != nil {
		target.SystemSshConnectionReuse = update.SystemSshConnectionReuse
	}
	target.UpdatedAt = time.Now().UTC()
	m.sshTargets[id] = target
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return SshTarget{}, err
	}
	m.emit("ssh.target.changed", target)
	return target, nil
}

func (m *Manager) DeleteSshTarget(id string) (SshTarget, error) {
	id = strings.TrimSpace(id)
	target, ok := m.GetSshTarget(id)
	if !ok {
		return SshTarget{}, ErrNotFound
	}

	// Why: the Go runtime owns SSH child processes. Removing only metadata
	// would orphan remote PTYs and local forwarding processes with no target
	// left for a later cleanup request.
	termination, err := m.TerminateSshTargetSessions(id)
	if err != nil {
		return SshTarget{}, err
	}
	if len(termination.FailedIDs) > 0 {
		return SshTarget{}, errors.New("failed to terminate SSH target sessions: " + strings.Join(termination.FailedIDs, ", "))
	}
	if _, err := m.TerminateSshPortForwards(id); err != nil {
		return SshTarget{}, err
	}

	m.mu.Lock()
	current, ok := m.sshTargets[id]
	if !ok {
		m.mu.Unlock()
		return SshTarget{}, ErrNotFound
	}
	delete(m.sshTargets, id)
	err = m.saveLocked()
	if err != nil {
		m.sshTargets[id] = current
	}
	m.mu.Unlock()
	// Why: a removed target must not leave its credential resident in memory.
	m.sshCredentials.clear(id)
	m.invalidateSshRelayWorker(id)
	// Why: a stale ControlMaster socket for a deleted target is orphaned —
	// best-effort cleanup, not worth failing deletion over.
	removeControlSocketPath(target)
	if err != nil {
		return SshTarget{}, err
	}
	m.emit("ssh.target.changed", map[string]interface{}{"deleted": target})
	return target, nil
}

func (m *Manager) ListSshTargets() []SshTarget {
	m.mu.RLock()
	defer m.mu.RUnlock()
	targets := make([]SshTarget, 0, len(m.sshTargets))
	for _, target := range m.sshTargets {
		// Why: runtime-owned targets (on-demand VM plumbing) are hidden from the
		// host-management surface, matching SshConnectionStore.listTargets.
		if isRuntimeOwnedTarget(target) {
			continue
		}
		targets = append(targets, target)
	}
	sort.Slice(targets, func(i, j int) bool {
		return targets[i].CreatedAt.Before(targets[j].CreatedAt)
	})
	return targets
}

func (m *Manager) GetSshTarget(id string) (SshTarget, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	target, ok := m.sshTargets[id]
	return target, ok
}

// ProbeSshTarget performs a bounded connectivity check using the system ssh
// binary. It never opens an OS prompt: an optional credential is supplied only
// through Pebble's forced askpass helper after the renderer prompt resolves.
func (m *Manager) ProbeSshTarget(ctx context.Context, id string) (SshProbeResult, error) {
	target, ok := m.GetSshTarget(id)
	if !ok {
		return SshProbeResult{}, ErrNotFound
	}
	sshPath, ok := findSystemSshBinary()
	if !ok {
		return SshProbeResult{
			Success: false,
			Status:  "error",
			Error:   "system ssh binary not found",
		}, nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, sshProbeTimeout)
	defer cancel()
	args := sshProbeArgs(target)
	cmd := exec.CommandContext(probeCtx, sshPath, args...)
	cleanup, configureErr := configureSshAskpass(cmd, m, id)
	if configureErr != nil {
		return SshProbeResult{}, configureErr
	}
	defer cleanup()
	output, err := cmd.CombinedOutput()
	if probeCtx.Err() == context.DeadlineExceeded {
		return SshProbeResult{
			Success: false,
			Status:  "error",
			Error:   "ssh probe timed out",
		}, nil
	}
	if err == nil {
		return SshProbeResult{Success: true, Status: "connected"}, nil
	}
	detail := strings.TrimSpace(string(output))
	if detail == "" {
		detail = err.Error()
	}
	return SshProbeResult{Success: false, Status: sshProbeErrorStatus(detail), Error: detail}, nil
}

// ImportSshTargetsFromConfig reconciles ~/.ssh/config Host entries into the
// store: it inserts new config hosts and refreshes existing config-sourced ones
// in place, never touching manual targets. It returns the inserted/updated set,
// matching SshConnectionStore.importFromSshConfig.
func (m *Manager) ImportSshTargetsFromConfig() ([]SshTarget, error) {
	candidates, err := loadSshConfigTargets()
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	changed := make([]SshTarget, 0, len(candidates))
	m.mu.Lock()
	manualAliases := make(map[string]bool)
	syncableByAlias := make(map[string]string)
	for _, existing := range m.sshTargets {
		alias := existing.ConfigHost
		if alias == "" {
			alias = existing.Label
		}
		if existing.Source == "manual" {
			manualAliases[alias] = true
			continue
		}
		if alias != "" {
			if _, seen := syncableByAlias[alias]; !seen {
				syncableByAlias[alias] = existing.ID
			}
		}
	}
	processed := make(map[string]bool)
	for _, candidate := range candidates {
		alias := candidate.ConfigHost
		if alias == "" {
			alias = candidate.Label
		}
		if manualAliases[alias] || processed[alias] {
			continue
		}
		processed[alias] = true
		if existingID, ok := syncableByAlias[alias]; ok {
			existing := m.sshTargets[existingID]
			// Why: skip the write (and "synced" report) when nothing config-derived
			// changed, so a repeat import on every pane open is a no-op. Source is
			// included so a legacy target is stamped 'ssh-config' exactly once.
			if existing.Source == "ssh-config" &&
				existing.ConfigHost == candidate.ConfigHost &&
				existing.Host == candidate.Host &&
				existing.Port == candidate.Port &&
				existing.Username == candidate.Username &&
				existing.IdentityFile == candidate.IdentityFile &&
				existing.ProxyCommand == candidate.ProxyCommand &&
				existing.JumpHost == candidate.JumpHost {
				continue
			}
			next := existing
			next.ConfigHost = candidate.ConfigHost
			next.Host = candidate.Host
			next.Port = candidate.Port
			next.Username = candidate.Username
			next.IdentityFile = candidate.IdentityFile
			next.ProxyCommand = candidate.ProxyCommand
			next.JumpHost = candidate.JumpHost
			next.Source = "ssh-config"
			next.UpdatedAt = now
			m.sshTargets[existingID] = next
			changed = append(changed, next)
			continue
		}
		inserted := candidate
		inserted.ID = newID("ssh")
		inserted.Source = "ssh-config"
		inserted.CreatedAt = now
		inserted.UpdatedAt = now
		m.sshTargets[inserted.ID] = inserted
		changed = append(changed, inserted)
	}
	if len(changed) > 0 {
		if err := m.saveLocked(); err != nil {
			m.mu.Unlock()
			return nil, err
		}
	}
	m.mu.Unlock()
	for _, target := range changed {
		m.emit("ssh.target.changed", target)
	}
	return changed, nil
}

func isRuntimeOwnedTarget(target SshTarget) bool {
	if target.Owner == nil {
		return false
	}
	kind, _ := target.Owner["type"].(string)
	return kind == "on-demand-runtime"
}

func sshProbeArgs(target SshTarget) []string {
	// The probe reuses the shared connection args (BatchMode/ConnectTimeout/
	// identity/proxy) and only adds its own no-op remote command.
	return append(sshConnectionArgs(target), "true")
}

func sshProbeErrorStatus(detail string) string {
	lower := strings.ToLower(detail)
	switch {
	case strings.Contains(lower, "permission denied"),
		strings.Contains(lower, "authentication"),
		strings.Contains(lower, "no supported authentication"):
		return "auth-failed"
	default:
		return "error"
	}
}

// findSystemSshBinary supports PEBBLE_SYSTEM_SSH_PATH so tests can inject a fake ssh.
func findSystemSshBinary() (string, bool) {
	if override := strings.TrimSpace(os.Getenv("PEBBLE_SYSTEM_SSH_PATH")); override != "" {
		return override, true
	}
	if resolved, err := exec.LookPath("ssh"); err == nil {
		return resolved, true
	}
	return "", false
}

// loadSshConfigTargets parses ~/.ssh/config into candidate targets. It supports
// the common subset the desktop importer relies on (Host / HostName / Port /
// User / IdentityFile / ProxyCommand / ProxyJump); wildcard host patterns are
// skipped because they do not name a connectable host.
func loadSshConfigTargets() ([]SshTarget, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	path := filepath.Join(home, ".ssh", "config")
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer file.Close()

	var targets []SshTarget
	var current *SshTarget
	flush := func() {
		if current != nil && current.Host != "" {
			targets = append(targets, *current)
		}
		current = nil
	}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := splitSshConfigLine(line)
		if !ok {
			continue
		}
		switch strings.ToLower(key) {
		case "host":
			flush()
			alias := firstConfigHostAlias(value)
			if alias == "" {
				continue
			}
			current = &SshTarget{Label: alias, ConfigHost: alias, Host: alias, Port: 22}
		case "hostname":
			if current != nil {
				current.Host = value
			}
		case "port":
			if current != nil {
				if port, convErr := strconv.Atoi(value); convErr == nil {
					current.Port = port
				}
			}
		case "user":
			if current != nil {
				current.Username = value
			}
		case "identityfile":
			if current != nil {
				current.IdentityFile = expandSshConfigHome(value, home)
			}
		case "proxycommand":
			if current != nil {
				current.ProxyCommand = value
			}
		case "proxyjump":
			if current != nil {
				current.JumpHost = value
			}
		}
	}
	flush()
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return targets, nil
}

func splitSshConfigLine(line string) (string, string, bool) {
	if idx := strings.IndexByte(line, '='); idx >= 0 {
		key := strings.TrimSpace(line[:idx])
		value := strings.TrimSpace(line[idx+1:])
		return key, value, key != ""
	}
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return "", "", false
	}
	return fields[0], strings.TrimSpace(line[len(fields[0]):]), true
}

func firstConfigHostAlias(value string) string {
	for _, token := range strings.Fields(value) {
		// Why: wildcard patterns (`*`, `?`, `!prefix`) match many hosts and name
		// none, so they cannot become a connectable target.
		if strings.ContainsAny(token, "*?!") {
			continue
		}
		return token
	}
	return ""
}

func expandSshConfigHome(value string, home string) string {
	if strings.HasPrefix(value, "~/") {
		return filepath.Join(home, value[2:])
	}
	return value
}
