package runtimecore

import (
	"context"

	"github.com/tsekaluk/pebble/go-runtime/internal/providercli"
)

// resolveProviderWorkdir maps a repo/worktree selector to a local directory the
// provider CLIs can run in. gh/glab infer owner/repo from the git remotes there,
// mirroring Electron's cwd-based resolution. Remote (SSH) projects have no local
// cwd, so they surface ErrRemoteNeedsRelay rather than resolving to an unrelated
// local project.
func (m *Manager) resolveProviderWorkdir(projectID string, worktreeID string) (string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if worktreeID != "" {
		worktree, ok := m.worktrees[worktreeID]
		if !ok {
			return "", ErrNotFound
		}
		project, ok := m.projects[worktree.ProjectID]
		if !ok {
			return "", ErrNotFound
		}
		if project.LocationKind != "local" {
			return "", ErrRemoteNeedsRelay
		}
		return worktree.Path, nil
	}
	project, ok := m.projects[projectID]
	if !ok {
		return "", ErrNotFound
	}
	if project.LocationKind != "local" {
		return "", ErrRemoteNeedsRelay
	}
	return project.Path, nil
}

// ListGitHubPRs lists open/recent pull requests for a repo/worktree via the gh CLI.
func (m *Manager) ListGitHubPRs(ctx context.Context, projectID string, worktreeID string, limit int) ([]providercli.GitHubWorkItem, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.ListGitHubPRs(ctx, workdir, limit)
}

// GetGitHubPR returns a single pull request via the gh CLI.
func (m *Manager) GetGitHubPR(ctx context.Context, projectID string, worktreeID string, number int) (providercli.GitHubWorkItem, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.GitHubWorkItem{}, err
	}
	return providercli.GetGitHubPR(ctx, workdir, number)
}

// GetGitHubPRChecks returns the check runs for a pull request via the gh CLI.
func (m *Manager) GetGitHubPRChecks(ctx context.Context, projectID string, worktreeID string, number int) ([]providercli.PRCheckDetail, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.GetGitHubPRChecks(ctx, workdir, number)
}

// ListGitLabMRs lists merge requests for a repo/worktree via the glab CLI.
func (m *Manager) ListGitLabMRs(ctx context.Context, projectID string, worktreeID string, state string, perPage int, query string) ([]providercli.GitLabWorkItem, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.ListGitLabMRs(ctx, workdir, state, perPage, query)
}
