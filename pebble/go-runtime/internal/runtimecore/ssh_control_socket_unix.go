//go:build unix

package runtimecore

import (
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

// controlSocketDirectory resolves (and validates) a private per-uid directory
// for control sockets, mirroring Electron's getControlSocketDirectory: prefer
// a short XDG_RUNTIME_DIR-backed path (keeps the joined socket path well
// under the platform's unix-domain-socket length limit — os.TempDir() on
// macOS is always the long, randomized $TMPDIR, never plain /tmp) and fall
// back to a TempDir-based path otherwise.
func controlSocketDirectory() (string, bool) {
	for _, dir := range controlSocketDirectoryCandidates() {
		if ensurePrivateDirectory(dir) {
			return dir, true
		}
	}
	return "", false
}

func controlSocketDirectoryCandidates() []string {
	var candidates []string
	if xdg := os.Getenv("XDG_RUNTIME_DIR"); xdg != "" && filepath.IsAbs(xdg) {
		candidates = append(candidates, filepath.Join(xdg, "pebble-ssh"))
	}
	candidates = append(candidates, filepath.Join(os.TempDir(), controlSocketTempDirName()))
	return candidates
}

func controlSocketTempDirName() string {
	return "pebble-ssh-" + strconv.Itoa(os.Geteuid())
}

// ensurePrivateDirectory creates dir if needed, then lstats it: mkdir's mode
// argument is a no-op for a pre-existing directory, so a directory left over
// from another user, a looser umask, or a planted symlink swap must be
// rejected explicitly rather than silently reused for the ControlMaster
// socket, mirroring Electron's ensurePrivateDirectory.
func ensurePrivateDirectory(dir string) bool {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return false
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}
	return int(stat.Uid) == os.Geteuid() && info.Mode().Perm()&0o077 == 0
}
