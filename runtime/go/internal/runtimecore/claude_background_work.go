package runtimecore

import (
	"encoding/json"
	"strings"
)

// claudeTerminalBackgroundTaskStatuses are the labels Claude reports for a
// background task that has stopped. Any other label — including one this
// runtime has never seen — is read as still running, so a future status name
// can never retire work that is in fact live.
var claudeTerminalBackgroundTaskStatuses = map[string]struct{}{
	"idle":       {},
	"done":       {},
	"success":    {},
	"succeeded":  {},
	"complete":   {},
	"completed":  {},
	"finished":   {},
	"failed":     {},
	"error":      {},
	"terminated": {},
	"exited":     {},
	"aborted":    {},
	"expired":    {},
	"skipped":    {},
	"crashed":    {},
	"killed":     {},
	"cancelled":  {},
	"canceled":   {},
	"timed_out":  {},
}

// claudeBackgroundWorkPayload is the slice of a Claude hook payload that
// describes work outliving the lead turn. Both fields are absent on older
// Claude builds, which is why nil means "no evidence", not "nothing running".
type claudeBackgroundWorkPayload struct {
	BackgroundTasks []json.RawMessage `json:"background_tasks"`
	SessionCrons    []json.RawMessage `json:"session_crons"`
}

// claudeOwnsRunningBackgroundWork reports whether a Stop payload still shows
// Claude-owned work in flight. Claude fires Stop when the lead turn ends, but
// background shells, subagents, and session crons keep running past it, so the
// pane is not idle yet.
func claudeOwnsRunningBackgroundWork(payload string) bool {
	var parsed claudeBackgroundWorkPayload
	if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
		return false
	}
	if len(parsed.SessionCrons) > 0 {
		return true
	}
	for _, raw := range parsed.BackgroundTasks {
		if backgroundTaskIsRunning(raw) {
			return true
		}
	}
	return false
}

func backgroundTaskIsRunning(raw json.RawMessage) bool {
	var task struct {
		Type   string `json:"type"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(raw, &task); err != nil {
		// Why: an entry we cannot read is no proof the task finished; fail active.
		return true
	}
	status := strings.ToLower(strings.TrimSpace(task.Status))
	if _, terminal := claudeTerminalBackgroundTaskStatuses[status]; terminal {
		return false
	}
	// Why: `teammate` rows report "running" permanently, even after the named
	// agent finished, so honouring them would pin the pane working forever.
	return strings.ToLower(strings.TrimSpace(task.Type)) != "teammate"
}
