package runtimecore

import (
	"context"
	"strings"
)

// WorktreeSetupDecision is how a caller answered "should this new worktree run
// the repo's pebble.yaml setup hook?". The zero value means the caller never
// said, which is warned about rather than silently treated as "no": a worktree
// with no dependencies installed is otherwise invisible until a build fails.
type WorktreeSetupDecision string

const (
	WorktreeSetupDecisionUnset WorktreeSetupDecision = ""
	WorktreeSetupDecisionRun   WorktreeSetupDecision = "run"
	WorktreeSetupDecisionSkip  WorktreeSetupDecision = "skip"
)

// Paired clients already surface this exact wording, so both transports keep
// reporting a passed-over hook the same way.
const worktreeSetupHookSkippedWarning = "pebble.yaml setup hook skipped; pass setupDecision=run to run it"

const worktreeSetupHookRemoteWarning = "pebble.yaml setup hook not run: worktrees on an SSH host run hooks on that host"

// WorktreeSetupDecisionFrom folds the two opt-in signals paired clients send
// (`runHooks`, `setupDecision`) into one decision.
func WorktreeSetupDecisionFrom(setupDecision string, runHooks bool) WorktreeSetupDecision {
	if runHooks || setupDecision == string(WorktreeSetupDecisionRun) {
		return WorktreeSetupDecisionRun
	}
	if setupDecision == string(WorktreeSetupDecisionSkip) {
		return WorktreeSetupDecisionSkip
	}
	return WorktreeSetupDecisionUnset
}

// ApplyWorktreeSetupHook runs a new worktree's setup hook when the caller opted
// in and returns the warning the transport should surface ("" when there is
// nothing to report). Both the REST and the paired create go through here so
// the opt-in rule cannot drift between them.
func (m *Manager) ApplyWorktreeSetupHook(
	ctx context.Context,
	projectID string,
	worktreePath string,
	decision WorktreeSetupDecision,
) string {
	if decision == WorktreeSetupDecisionSkip {
		return ""
	}
	m.mu.RLock()
	project, ok := m.projects[strings.TrimSpace(projectID)]
	m.mu.RUnlock()
	if !ok {
		return ""
	}
	if project.LocationKind == "ssh" {
		// The hook belongs where the worktree lives, and this host cannot even
		// read the remote pebble.yaml, so an opt-in that cannot be honoured is
		// reported instead of passing for success.
		if decision == WorktreeSetupDecisionRun {
			return worktreeSetupHookRemoteWarning
		}
		return ""
	}
	if LoadWorktreeSetupHookScript(worktreePath) == "" {
		return ""
	}
	if decision != WorktreeSetupDecisionRun {
		return worktreeSetupHookSkippedWarning
	}
	if err := RunWorktreeSetupHookOnHost(ctx, project.Path, worktreePath); err != nil {
		return err.Error()
	}
	return ""
}

// CreateWorktreeWithSetupHook creates the worktree and then applies the setup
// hook, returning the warning to surface. The hook only runs for a worktree
// this call actually created, so a repeated request for an existing path never
// re-runs the user's script.
func (m *Manager) CreateWorktreeWithSetupHook(
	ctx context.Context,
	req CreateWorktreeRequest,
) (Worktree, string, error) {
	worktree, created, err := m.createWorktree(ctx, req)
	if err != nil || !created {
		return worktree, "", err
	}
	decision := WorktreeSetupDecision(strings.TrimSpace(req.SetupDecision))
	return worktree, m.ApplyWorktreeSetupHook(ctx, worktree.ProjectID, worktree.Path, decision), nil
}
