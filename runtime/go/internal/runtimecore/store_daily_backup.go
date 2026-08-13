package runtimecore

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// The runtime store holds every project, worktree, SSH target, emulator, and
// account the user has registered. It is written atomically, so it is never
// torn — but it was never versioned either, so anything that empties it is
// unrecoverable: a bad write, a bug, or one mistaken delete, with nothing to
// go back to.
//
// Keep a snapshot of the last good content once per day. Daily rather than
// per-save because save runs on every state change, and rotating that fast
// would simply overwrite the good snapshots with the bad state before anyone
// noticed. A day is the granularity at which "yesterday it was fine" is still
// a useful thing to be able to say.

const storeBackupSuffix = ".backup-"

const storeBackupRetention = 3

// snapshotStoreForDay copies the current store content aside before it is
// replaced, at most once per calendar day. Every failure is silent by design:
// a snapshot is a safety net, and failing to take one must never stop the
// runtime from saving real state.
func snapshotStoreForDay(storePath string, now time.Time) {
	content, err := os.ReadFile(storePath)
	if err != nil || len(content) == 0 {
		return
	}
	backupPath := storePath + storeBackupSuffix + now.Format("2006-01-02")
	if _, err := os.Stat(backupPath); err == nil {
		return
	}
	if os.WriteFile(backupPath, content, 0o600) != nil {
		return
	}
	pruneStoreBackups(storePath, storeBackupRetention)
}

func pruneStoreBackups(storePath string, keep int) {
	dir := filepath.Dir(storePath)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	prefix := filepath.Base(storePath) + storeBackupSuffix
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), prefix) {
			names = append(names, entry.Name())
		}
	}
	if len(names) <= keep {
		return
	}
	// The suffix is an ISO date, so lexical order is chronological order.
	sort.Strings(names)
	for _, name := range names[:len(names)-keep] {
		_ = os.Remove(filepath.Join(dir, name))
	}
}
