package runtimecore

import (
	"errors"
	"strings"
)

// Relay-only SSH worktree deletion follows the same push pattern as remote
// file/git-status snapshots: pebble-relay-worker performs the bounded
// `git worktree remove` plus branch cleanup on the remote host (via the shared
// RemoveGitWorktreeOnHost), then posts the outcome here so the runtime can
// retire the metadata record instead of leaving a metadata-only delete.

type CompleteRemoteWorktreeRemovalRequest struct {
	ProjectID  string `json:"projectId"`
	WorktreeID string `json:"worktreeId"`
	// PreservedBranch carries the remote host's safe-delete refusal, so the
	// renderer can offer the same force-delete follow-up as local deletions.
	PreservedBranch *PreservedWorktreeBranch `json:"preservedBranch,omitempty"`
}

type CompleteRemotePreservedBranchRemovalRequest struct {
	ProjectID  string `json:"projectId"`
	BranchName string `json:"branchName"`
}

// RemotePreservedBranchRemoval is emitted (and returned) when a relay worker
// reports that a preserved branch was force-deleted on the remote host.
type RemotePreservedBranchRemoval struct {
	ProjectID  string `json:"projectId"`
	BranchName string `json:"branchName"`
	Deleted    bool   `json:"deleted"`
}

// CompleteRemoteWorktreeRemoval retires the worktree record after a relay
// worker removed the git worktree on the remote host. It refuses local
// projects (local deletions run the git removal in-process) and worktrees that
// do not belong to the reported project, so a stale relay cannot delete an
// unrelated record.
func (m *Manager) CompleteRemoteWorktreeRemoval(req CompleteRemoteWorktreeRemovalRequest) (DeleteWorktreeResponse, error) {
	projectID := strings.TrimSpace(req.ProjectID)
	worktreeID := strings.TrimSpace(req.WorktreeID)
	if projectID == "" {
		return DeleteWorktreeResponse{}, ErrProjectRequired
	}
	if worktreeID == "" {
		return DeleteWorktreeResponse{}, errors.New("worktree id is required")
	}
	m.mu.Lock()
	project, ok := m.projects[projectID]
	if !ok {
		m.mu.Unlock()
		return DeleteWorktreeResponse{}, ErrNotFound
	}
	if project.LocationKind == "local" {
		m.mu.Unlock()
		return DeleteWorktreeResponse{}, errors.New("remote worktree removals are only for remote projects")
	}
	worktree, ok := m.worktrees[worktreeID]
	if !ok || worktree.ProjectID != projectID {
		m.mu.Unlock()
		return DeleteWorktreeResponse{}, ErrNotFound
	}
	delete(m.worktrees, worktreeID)
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return DeleteWorktreeResponse{}, err
	}
	m.emit("worktree.changed", map[string]interface{}{
		"deleted":         worktree,
		"preservedBranch": req.PreservedBranch,
	})
	return DeleteWorktreeResponse{Worktree: worktree, PreservedBranch: req.PreservedBranch}, nil
}

// CompleteRemotePreservedBranchRemoval records that a relay worker
// force-deleted a preserved branch on the remote host. The runtime keeps no
// preserved-branch state, so this only validates the project and fans the
// outcome out to subscribers.
func (m *Manager) CompleteRemotePreservedBranchRemoval(req CompleteRemotePreservedBranchRemovalRequest) (RemotePreservedBranchRemoval, error) {
	projectID := strings.TrimSpace(req.ProjectID)
	branchName := normalizeLocalBranchRef(req.BranchName)
	if projectID == "" {
		return RemotePreservedBranchRemoval{}, ErrProjectRequired
	}
	if branchName == "" {
		return RemotePreservedBranchRemoval{}, errors.New("invalid branch name")
	}
	m.mu.RLock()
	project, ok := m.projects[projectID]
	m.mu.RUnlock()
	if !ok {
		return RemotePreservedBranchRemoval{}, ErrNotFound
	}
	if project.LocationKind == "local" {
		return RemotePreservedBranchRemoval{}, errors.New("remote branch removals are only for remote projects")
	}
	removal := RemotePreservedBranchRemoval{
		ProjectID:  projectID,
		BranchName: branchName,
		Deleted:    true,
	}
	m.emit("worktree.changed", map[string]interface{}{"remotePreservedBranchRemoval": removal})
	return removal, nil
}
