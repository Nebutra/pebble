package runtimecore

import (
	"context"
	"strings"

	"github.com/tsekaluk/pebble/go-runtime/internal/providercli"
)

type HostedReviewCapabilities struct {
	Provider       string `json:"provider"`
	Authenticated  bool   `json:"authenticated"`
	CurrentBranch  string `json:"currentBranch,omitempty"`
	DefaultBaseRef string `json:"defaultBaseRef,omitempty"`
}

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

// CreateHostedReview creates a provider review from a local project/worktree.
// Remote projects stay relay-owned and fail before any desktop-local CLI runs.
func (m *Manager) CreateHostedReview(
	ctx context.Context,
	projectID string,
	worktreeID string,
	request providercli.CreateReviewRequest,
) (providercli.CreateReviewResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.CreateReviewResult{}, err
	}
	switch request.Provider {
	case "github":
		return providercli.CreateGitHubPullRequest(ctx, workdir, request), nil
	case "gitlab":
		return providercli.CreateGitLabMergeRequest(ctx, workdir, request), nil
	default:
		return providercli.CreateReviewResult{
			Code:  "unsupported_provider",
			Error: "Creating reviews for this provider is not supported yet.",
		}, nil
	}
}

func (m *Manager) HostedReviewCapabilities(
	ctx context.Context,
	projectID string,
	worktreeID string,
) (HostedReviewCapabilities, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return HostedReviewCapabilities{}, err
	}
	remoteURL, err := readPrimaryGitRemoteURL(ctx, workdir)
	if err != nil {
		return HostedReviewCapabilities{Provider: "unsupported"}, nil
	}
	remote, ok := parseHostedRemote(remoteURL)
	if !ok || (remote.Provider != hostedRemoteGitHub && remote.Provider != hostedRemoteGitLab) {
		return HostedReviewCapabilities{Provider: "unsupported"}, nil
	}
	provider := string(remote.Provider)
	currentBranch, _ := readGitOutput(ctx, workdir, "symbolic-ref", "--quiet", "--short", "HEAD")
	return HostedReviewCapabilities{
		Provider:       provider,
		Authenticated:  providercli.IsReviewProviderAuthenticated(ctx, workdir, provider, remote.Host),
		CurrentBranch:  strings.TrimSpace(currentBranch),
		DefaultBaseRef: readHostedReviewDefaultBaseRef(ctx, workdir),
	}, nil
}

func readHostedReviewDefaultBaseRef(ctx context.Context, workdir string) string {
	for _, remoteName := range []string{"origin", "upstream"} {
		ref, err := readGitOutput(
			ctx,
			workdir,
			"symbolic-ref",
			"--quiet",
			"--short",
			"refs/remotes/"+remoteName+"/HEAD",
		)
		if err == nil {
			return strings.TrimPrefix(strings.TrimSpace(ref), remoteName+"/")
		}
	}
	for _, branch := range []string{"main", "master"} {
		if _, err := readGitOutput(
			ctx,
			workdir,
			"rev-parse",
			"--verify",
			"--quiet",
			"refs/remotes/origin/"+branch,
		); err == nil {
			return branch
		}
	}
	return ""
}
