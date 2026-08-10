package runtimecore

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// securityKeyKeyTypes are the FIDO2-backed key types OpenSSH advertises from 8.2.
var securityKeyKeyTypes = []string{
	"sk-ssh-ed25519@openssh.com",
	"sk-ecdsa-sha2-nistp256@openssh.com",
}

const sshCapabilityProbeTimeout = 5 * time.Second

// SshSystemCapabilities describes what the host's OpenSSH can do. Callers gate
// security-key auth on it so a missing or pre-8.2 ssh reports an actionable
// message up front instead of an opaque authentication failure mid-connect.
type SshSystemCapabilities struct {
	Path            string `json:"path,omitempty"`
	Available       bool   `json:"available"`
	SecurityKeyAuth bool   `json:"securityKeyAuth"`
}

// DetectSshSystemCapabilities probes the system ssh binary once.
func DetectSshSystemCapabilities(ctx context.Context) SshSystemCapabilities {
	path, ok := findSystemSshBinary()
	if !ok {
		return SshSystemCapabilities{}
	}
	probeCtx, cancel := context.WithTimeout(ctx, sshCapabilityProbeTimeout)
	defer cancel()
	// Why: `ssh -Q key` is the portable way to ask the local binary what it
	// supports. Version strings differ across vendors, forks, and Windows builds.
	output, err := exec.CommandContext(probeCtx, path, "-Q", "key").Output()
	if err != nil {
		// A binary too old to understand `-Q` also predates FIDO2 support.
		return SshSystemCapabilities{Path: path, Available: true}
	}
	return SshSystemCapabilities{
		Path:            path,
		Available:       true,
		SecurityKeyAuth: SshQueryListsSecurityKeyTypes(string(output)),
	}
}

var (
	sshCapabilityCacheMu sync.Mutex
	sshCapabilityCache   = map[string]SshSystemCapabilities{}
)

// CachedSshSystemCapabilities memoizes the probe per resolved binary so gating a
// connect costs one exec for the life of the process, not one exec per attempt.
func CachedSshSystemCapabilities(ctx context.Context) SshSystemCapabilities {
	path, ok := findSystemSshBinary()
	if !ok {
		return SshSystemCapabilities{}
	}
	sshCapabilityCacheMu.Lock()
	cached, hit := sshCapabilityCache[path]
	sshCapabilityCacheMu.Unlock()
	if hit {
		return cached
	}
	detected := DetectSshSystemCapabilities(ctx)
	sshCapabilityCacheMu.Lock()
	sshCapabilityCache[path] = detected
	sshCapabilityCacheMu.Unlock()
	return detected
}

// SshQueryListsSecurityKeyTypes reports whether `ssh -Q key` output names a
// FIDO2 key type.
func SshQueryListsSecurityKeyTypes(output string) bool {
	for _, line := range strings.Split(output, "\n") {
		if isSecurityKeyType(strings.TrimSpace(line)) {
			return true
		}
	}
	return false
}

// EnsureSshTargetTransport reports why a target cannot connect on this host,
// covering both a missing ssh binary and a FIDO2 identity the local ssh predates.
func EnsureSshTargetTransport(target SshTarget, capabilities SshSystemCapabilities) error {
	if !capabilities.Available {
		return ErrSystemSshMissing()
	}
	if !capabilities.SecurityKeyAuth && IdentityFileUsesSecurityKey(target.IdentityFile) {
		return errors.New(
			"this target authenticates with a FIDO2 security key, which needs OpenSSH 8.2 or newer; " +
				sshInstallHint(),
		)
	}
	return nil
}

// ErrSystemSshMissing names the install step for the running platform, so the
// renderer can show one actionable line instead of a bare "not found".
func ErrSystemSshMissing() error {
	return errors.New("system ssh binary not found: " + sshInstallHint())
}

func sshInstallHint() string {
	switch runtime.GOOS {
	case "darwin":
		return "install OpenSSH with `brew install openssh`, " +
			"or point PEBBLE_SYSTEM_SSH_PATH at the ssh executable"
	case "windows":
		return "enable the OpenSSH Client optional feature " +
			"(Settings > Apps > Optional features), " +
			"or point PEBBLE_SYSTEM_SSH_PATH at the ssh executable"
	default:
		return "install the openssh-client package " +
			"(`apt install openssh-client`, `dnf install openssh-clients`), " +
			"or point PEBBLE_SYSTEM_SSH_PATH at the ssh executable"
	}
}

// SshTargetNeedsUserPresence reports whether authenticating this target requires
// a hardware touch, which no batched exec can supply.
func SshTargetNeedsUserPresence(target SshTarget) bool {
	return IdentityFileUsesSecurityKey(target.IdentityFile)
}

// IdentityFileUsesSecurityKey reads the identity's `.pub` sibling because an
// OpenSSH private key is opaque without decoding it, and OpenSSH itself relies
// on the same naming convention.
func IdentityFileUsesSecurityKey(identityFile string) bool {
	resolved := expandSshUserPath(identityFile)
	if resolved == "" {
		return false
	}
	data, err := os.ReadFile(resolved + ".pub")
	if err != nil {
		return false
	}
	return PublicKeyLineUsesSecurityKey(string(data))
}

// PublicKeyLineUsesSecurityKey reports whether an authorized-keys style line
// names a FIDO2 key type.
func PublicKeyLineUsesSecurityKey(line string) bool {
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return false
	}
	return isSecurityKeyType(fields[0])
}

func isSecurityKeyType(candidate string) bool {
	for _, keyType := range securityKeyKeyTypes {
		if strings.EqualFold(candidate, keyType) {
			return true
		}
	}
	return false
}

// expandSshUserPath resolves a leading `~` the way ssh_config does; paths are
// otherwise returned untouched so relative entries keep their meaning.
func expandSshUserPath(path string) string {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" || !strings.HasPrefix(trimmed, "~") {
		return trimmed
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return trimmed
	}
	if trimmed == "~" {
		return home
	}
	if strings.HasPrefix(trimmed, "~/") || strings.HasPrefix(trimmed, `~\`) {
		return filepath.Join(home, trimmed[2:])
	}
	return trimmed
}
