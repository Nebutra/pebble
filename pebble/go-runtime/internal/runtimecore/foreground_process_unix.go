//go:build !windows

package runtimecore

import (
	"context"
	"os/exec"
	"syscall"
	"time"
)

// foregroundProbeTimeout bounds the ps snapshot so a wedged ps never stalls a
// status read.
const foregroundProbeTimeout = 2 * time.Second

// foregroundProcessSupported reports whether this platform can resolve the
// terminal foreground process. Unix can via the process group + ps.
const foregroundProcessSupported = true

// foregroundProcessUnsupportedReason is empty on unix (supported).
const foregroundProcessUnsupportedReason = ""

// resolveForegroundProcessName returns the foreground process name for a running
// session, given the child PID.
//
// These sessions are PTY-backed and started with Setsid (via creack/pty), so the
// child leads its own session and process group (pgid == pid). We read that
// process group and resolve its foreground member via `ps` — preferring the `+`
// controlling-terminal flag, which the PTY makes meaningful.
func resolveForegroundProcessName(pid int) (string, bool) {
	if pid <= 0 {
		return "", false
	}
	pgid, err := syscall.Getpgid(pid)
	if err != nil {
		return "", false
	}
	rows, ok := snapshotProcessTable()
	if !ok {
		return "", false
	}
	name := foregroundProcessNameForPgid(rows, pgid)
	if name == "" {
		return "", false
	}
	return name, true
}

// snapshotProcessTable runs a bounded `ps` and parses it. Columns are chosen to
// match parsePsRows: pid, pgid, stat, command.
func snapshotProcessTable() ([]psRow, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), foregroundProbeTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ps", "-eo", "pid=,pgid=,stat=,comm=").Output()
	if err != nil {
		return nil, false
	}
	return parsePsRows(string(out)), true
}
