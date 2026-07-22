package runtimecore

import (
	"strconv"
	"strings"
)

// psRow is one line of `ps -o pid=,pgid=,stat=,comm=` output.
type psRow struct {
	pid  int
	pgid int
	stat string
	comm string
}

// parsePsRows parses the process table snapshot used for foreground resolution.
// Columns are pid, pgid, stat, then the command (which may contain spaces).
func parsePsRows(stdout string) []psRow {
	rows := make([]psRow, 0, 16)
	for _, line := range strings.Split(stdout, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 4 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		pgid, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		rows = append(rows, psRow{
			pid:  pid,
			pgid: pgid,
			stat: fields[2],
			comm: strings.Join(fields[3:], " "),
		})
	}
	return rows
}

// foregroundProcessNameForPgid resolves the command name of the foreground
// process group leader. Prefer the process that
// holds the terminal foreground (the `+` stat flag on Unix), falling back to the
// group leader itself. Returns "" when the pgid has no matching row.
func foregroundProcessNameForPgid(rows []psRow, pgid int) string {
	var leaderName string
	var foregroundName string
	for _, row := range rows {
		if row.pgid != pgid {
			continue
		}
		if row.pid == pgid {
			leaderName = baseComm(row.comm)
		}
		// `+` marks the process holding the controlling terminal's foreground.
		if strings.Contains(row.stat, "+") && foregroundName == "" {
			foregroundName = baseComm(row.comm)
		}
	}
	if foregroundName != "" {
		return foregroundName
	}
	return leaderName
}

// baseComm strips a leading path and arguments from a ps comm/command field so
// the renderer sees a short process name (e.g. "bash" not "/bin/bash -il").
func baseComm(comm string) string {
	trimmed := strings.TrimSpace(comm)
	if trimmed == "" {
		return ""
	}
	// Take the executable token, then its basename.
	first := strings.Fields(trimmed)[0]
	if idx := strings.LastIndexAny(first, "/\\"); idx >= 0 {
		first = first[idx+1:]
	}
	// Login shells report as "-bash"; drop the leading dash for a clean name.
	return strings.TrimPrefix(first, "-")
}
