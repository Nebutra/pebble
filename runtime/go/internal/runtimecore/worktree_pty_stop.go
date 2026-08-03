package runtimecore

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Why (#64 / Orca #11960): destructive worktree removal must prove PTYs are
// dead before (or while) filesystem work proceeds. A stop RPC that fails is not
// evidence the process is still live — Session not found means already gone.
// Verification gets its own budget so a spent sweep deadline cannot forever
// refuse removal.

const (
	// UnstoppedPtyRemovalPrefix is the stable classifier string for the
	// renderer's Force Delete affordance (canForceDelete / unstopped-pty).
	UnstoppedPtyRemovalPrefix = "Failed to physically stop every PTY for worktree:"

	// WorktreePtyStopBudget is the total time allowed for stop RPCs on one worktree.
	WorktreePtyStopBudget = 10 * time.Second
	// WorktreePtyVerifyGrace is the floor for the independent re-list budget.
	WorktreePtyVerifyGrace = 2 * time.Second
)

// PtyStopVerdict is the three-way result of verifying failed stop RPCs.
// "unverifiable" must stay distinct from "live" so force-delete can waive only
// the unproven case while still refusing hard live holds when appropriate.
type PtyStopVerdict string

const (
	PtyStopExited       PtyStopVerdict = "exited"
	PtyStopLive         PtyStopVerdict = "live"
	PtyStopUnverifiable PtyStopVerdict = "unverifiable"
)

// IsUnstoppedPtyRemovalError reports whether error text is the PTY gate refusal.
func IsUnstoppedPtyRemovalError(message string) bool {
	return strings.Contains(message, UnstoppedPtyRemovalPrefix)
}

// StopSessionsForWorktree stops every live session bound to worktreeID.
// When allowUnverified is true (user Force Delete / CLI --force), an
// unverifiable or residual-live inventory cannot permanently wedge removal —
// sessions that still list as live are best-effort stopped, then removal proceeds.
func (m *Manager) StopSessionsForWorktree(
	ctx context.Context,
	worktreeID string,
	allowUnverified bool,
) error {
	worktreeID = strings.TrimSpace(worktreeID)
	if worktreeID == "" {
		return nil
	}
	deadline := time.Now().Add(WorktreePtyStopBudget)
	live := m.listLiveSessionsForWorktree(worktreeID)
	if len(live) == 0 {
		return nil
	}

	failedIDs := make([]string, 0)
	for _, session := range live {
		if err := ctx.Err(); err != nil {
			return err
		}
		if time.Now().After(deadline) {
			// Why: spent sweep budget must still re-list with its own window.
			failedIDs = append(failedIDs, session.ID)
			continue
		}
		if _, err := m.StopSession(session.ID); err != nil {
			// Session already gone is success for teardown.
			if errors.Is(err, ErrSessionNotFound) {
				continue
			}
			failedIDs = append(failedIDs, session.ID)
		}
	}

	if len(failedIDs) == 0 {
		// Confirm nothing live remains under this worktree.
		remaining := m.listLiveSessionsForWorktree(worktreeID)
		if len(remaining) == 0 {
			return nil
		}
		failedIDs = sessionIDs(remaining)
	}

	verdict, detail := m.verifyUnstoppedSessions(worktreeID, failedIDs, WorktreePtyStopBudget)
	switch verdict {
	case PtyStopExited:
		return nil
	case PtyStopLive:
		if allowUnverified {
			// Last-ditch best-effort stops; do not block force delete.
			for _, id := range detail {
				_, _ = m.StopSession(id)
			}
			return nil
		}
		return fmt.Errorf("%s %s — still live: %s", UnstoppedPtyRemovalPrefix, worktreeID, strings.Join(detail, ", "))
	default: // unverifiable
		if allowUnverified {
			return nil
		}
		reason := "the session list timed out"
		if len(detail) > 0 {
			reason = detail[0]
		}
		return fmt.Errorf(
			"%s %s — could not verify these exited: %s (%s)",
			UnstoppedPtyRemovalPrefix,
			worktreeID,
			strings.Join(failedIDs, ", "),
			reason,
		)
	}
}

func (m *Manager) listLiveSessionsForWorktree(worktreeID string) []Session {
	all := m.ListSessions()
	out := make([]Session, 0, len(all))
	for _, session := range all {
		if session.WorktreeID != worktreeID {
			continue
		}
		if session.Status == SessionStopped {
			continue
		}
		out = append(out, session)
	}
	return out
}

func sessionIDs(sessions []Session) []string {
	ids := make([]string, 0, len(sessions))
	for _, session := range sessions {
		ids = append(ids, session.ID)
	}
	return ids
}

// verifyUnstoppedSessions re-lists live sessions with an independent budget.
// failedIDs are the stop attempts that did not cleanly succeed.
func (m *Manager) verifyUnstoppedSessions(
	worktreeID string,
	failedIDs []string,
	sweepBudget time.Duration,
) (PtyStopVerdict, []string) {
	verifyBudget := sweepBudget
	if verifyBudget < WorktreePtyVerifyGrace {
		verifyBudget = WorktreePtyVerifyGrace
	}
	// Why: do not share the spent sweep deadline — that was the Orca #11960 wedge.
	deadline := time.Now().Add(verifyBudget)
	type listResult struct {
		sessions []Session
		err      error
	}
	ch := make(chan listResult, 1)
	go func() {
		// ListSessions is synchronous today; run off-thread so the timer can win.
		defer func() {
			if recovered := recover(); recovered != nil {
				ch <- listResult{err: fmt.Errorf("session list panicked: %v", recovered)}
			}
		}()
		ch <- listResult{sessions: m.listLiveSessionsForWorktree(worktreeID)}
	}()
	var live []Session
	select {
	case <-time.After(time.Until(deadline)):
		return PtyStopUnverifiable, []string{"the session list timed out"}
	case result := <-ch:
		if result.err != nil {
			return PtyStopUnverifiable, []string{result.err.Error()}
		}
		live = result.sessions
	}
	liveSet := make(map[string]struct{}, len(live))
	for _, session := range live {
		liveSet[session.ID] = struct{}{}
	}
	stillLive := make([]string, 0)
	for _, id := range failedIDs {
		if _, ok := liveSet[id]; ok {
			stillLive = append(stillLive, id)
		}
	}
	// Also treat any other still-live worktree session as blocking.
	for _, session := range live {
		found := false
		for _, id := range failedIDs {
			if id == session.ID {
				found = true
				break
			}
		}
		if !found {
			stillLive = append(stillLive, session.ID)
		}
	}
	if len(stillLive) > 0 {
		return PtyStopLive, stillLive
	}
	return PtyStopExited, nil
}
