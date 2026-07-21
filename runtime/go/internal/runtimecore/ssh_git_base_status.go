package runtimecore

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type sshGitWorktreeCreateResult struct {
	CreatedBaseSHA string `json:"createdBaseSha"`
}

func (m *Manager) createSshGitWorktree(ctx context.Context, project Project, req CreateWorktreeRequest, path string) (string, error) {
	args := []string{"git-worktree-create-json", "--root", project.Path, "--path", path, "--branch", strings.TrimSpace(req.Branch), "--base", strings.TrimSpace(req.Base)}
	if req.SkipCheckout {
		args = append(args, "--skip-checkout")
	}
	output, err := m.runSshRelayWorker(ctx, project.HostID, args)
	if err != nil {
		return "", err
	}
	var result sshGitWorktreeCreateResult
	if err := json.Unmarshal(output, &result); err != nil {
		return "", errors.New("relay worker returned malformed worktree creation result")
	}
	return strings.TrimSpace(result.CreatedBaseSHA), nil
}

func (m *Manager) sshGitBaseStatus(ctx context.Context, req GitBaseStatusRequest) (GitBaseStatusResult, error) {
	project, root, err := m.sshFileRelayScope(req.ProjectID, req.WorktreeID)
	if err != nil {
		return GitBaseStatusResult{}, err
	}
	input, err := json.Marshal(req)
	if err != nil {
		return GitBaseStatusResult{}, err
	}
	output, err := m.runSshRelayWorkerWithInput(ctx, project.HostID, []string{"git-base-status-json", "--root", root}, input)
	if err != nil {
		return GitBaseStatusResult{}, err
	}
	var result GitBaseStatusResult
	if err := json.Unmarshal(output, &result); err != nil {
		return GitBaseStatusResult{}, errors.New("relay worker returned malformed base status")
	}
	return result, nil
}

func (m *Manager) recordGitBaseStatus(req GitBaseStatusRequest, result GitBaseStatusResult) error {
	repositoryID := strings.TrimSpace(req.ProjectID)
	workspaceID := strings.TrimSpace(req.WorktreeID)
	if workspaceID == "" {
		workspaceID = repositoryID
	}
	status := normalizeSourceControlBaseStatus(&SourceControlBaseStatus{
		Status: result.Status, Base: result.Base, Remote: result.Remote, Behind: result.Behind,
		RecentSubjects: result.RecentSubjects, Conflict: result.Conflict,
	})
	m.mu.Lock()
	projection, ok := m.sourceControlProjections[sourceControlProjectionKey(repositoryID, workspaceID)]
	if !ok {
		project, projectOK := m.projects[repositoryID]
		if !projectOK {
			m.mu.Unlock()
			return ErrNotFound
		}
		projection = SourceControlProjection{
			Kind: "source-control", RepositoryID: repositoryID, WorkspaceID: workspaceID,
			Provider: gitProviderKind(project.Provider), ReviewKind: "none", Branch: "unknown",
			SyncStatus: "unknown", Changes: []SourceControlChange{},
		}
		if worktree, worktreeOK := m.worktrees[workspaceID]; worktreeOK {
			projection.Branch = strings.TrimSpace(worktree.Branch)
			projection.BaseBranch = strings.TrimSpace(worktree.Base)
			projection.ReviewKind = reviewKind(worktree.ReviewKind)
		}
	}
	projection.BaseStatus = status
	projection.UpdatedAt = time.Now().UTC()
	m.sourceControlProjections[sourceControlProjectionKey(repositoryID, workspaceID)] = projection
	if err := m.saveLocked(); err != nil {
		m.mu.Unlock()
		return err
	}
	m.mu.Unlock()
	m.emit("source-control.changed", projection)
	event := WorktreeBaseStatusEvent{
		RepoID: repositoryID, WorktreeID: workspaceID, Status: status.Status,
		Base: status.Base, Remote: status.Remote, Behind: status.Behind,
		RecentSubjects: append([]string(nil), status.RecentSubjects...),
	}
	m.emit("worktree.base-status.changed", event)
	if status.Conflict != nil {
		m.emit("worktree.remote-branch-conflict.changed", map[string]string{
			"repoId": repositoryID, "worktreeId": workspaceID,
			"remote": status.Conflict.Remote, "branchName": status.Conflict.BranchName,
		})
	}
	return nil
}
