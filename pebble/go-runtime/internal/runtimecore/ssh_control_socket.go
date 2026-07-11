package runtimecore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// controlSocketMaxPathLength mirrors Electron's CONTROL_SOCKET_PATH_MAX_LENGTH:
// unix domain socket paths have an OS-level length limit (~104 bytes on macOS,
// ~108 on Linux), minus headroom for OpenSSH's own ControlPath suffix.
const (
	controlSocketPathLimitDarwin = 104
	controlSocketPathLimitLinux  = 108
	controlSocketSuffixBudget    = 18
)

// controlSocketPath mirrors Electron's getControlSocketPath: a deterministic,
// private, per-user socket path derived from the target's identity, so
// repeated SSH execs against the same target reuse one OpenSSH ControlMaster
// connection instead of a fresh TCP+auth handshake each time. Returns
// ("", false) when reuse isn't possible (Windows has no unix domain sockets,
// or the computed path would exceed the platform's socket path limit) so the
// caller falls back to a plain, non-multiplexed connection rather than a
// broken ControlPath.
func controlSocketPath(target SshTarget) (string, bool) {
	if runtime.GOOS == "windows" {
		return "", false
	}
	if target.SystemSshConnectionReuse != nil && !*target.SystemSshConnectionReuse {
		return "", false
	}
	dir, ok := controlSocketDirectory()
	if !ok {
		return "", false
	}
	hash := controlSocketHash(target)
	path := filepath.Join(dir, hash)
	if len(path) > controlSocketMaxPathLength() {
		return "", false
	}
	return path, true
}

// controlSocketDirectory resolves (and ensures) a private per-uid directory
// for control sockets, mirroring Electron's uid-scoped socket directory.
func controlSocketDirectory() (string, bool) {
	dir := filepath.Join(os.TempDir(), fmt.Sprintf("pebble-ssh-cm-%d", os.Geteuid()))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", false
	}
	return dir, true
}

// controlSocketHash hashes the same identity fields Electron hashes (target
// ID, effective host, port, username, proxy/jump/identity settings) so a
// target that changes its connection shape gets a fresh socket rather than
// silently reusing a master dialed under stale settings.
func controlSocketHash(target SshTarget) string {
	destination := target.Host
	if target.ConfigHost != "" && target.Source == "ssh-config" {
		destination = target.ConfigHost
	}
	key := struct {
		ID            string `json:"id"`
		ConfigHost    string `json:"configHost"`
		Host          string `json:"host"`
		Port          int    `json:"port"`
		Username      string `json:"username"`
		ProxyCommand  string `json:"proxyCommand"`
		JumpHost      string `json:"jumpHost"`
		IdentityFile  string `json:"identityFile"`
		IdentityAgent string `json:"identityAgent"`
	}{
		ID:            target.ID,
		ConfigHost:    destination,
		Host:          target.Host,
		Port:          target.Port,
		Username:      target.Username,
		ProxyCommand:  target.ProxyCommand,
		JumpHost:      target.JumpHost,
		IdentityFile:  target.IdentityFile,
		IdentityAgent: target.IdentityAgent,
	}
	encoded, err := json.Marshal(key)
	if err != nil {
		// json.Marshal on a struct of plain strings/ints never fails; this is
		// unreachable in practice, but a zero-length hash input is still safe.
		encoded = nil
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])[:16]
}

func controlSocketMaxPathLength() int {
	limit := controlSocketPathLimitLinux
	if runtime.GOOS == "darwin" {
		limit = controlSocketPathLimitDarwin
	}
	return limit - controlSocketSuffixBudget
}

// removeControlSocketPath best-effort removes a stale control socket file;
// mirrors Electron's removeControlSocketPath (a missing file is not an error,
// nor is any other removal failure worth surfacing — cleanup is advisory).
func removeControlSocketPath(target SshTarget) {
	path, ok := controlSocketPath(target)
	if !ok {
		return
	}
	_ = os.Remove(path)
}
