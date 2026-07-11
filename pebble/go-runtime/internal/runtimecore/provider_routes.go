package runtimecore

import (
	"context"
	"net/http"
	"strings"

	"github.com/tsekaluk/pebble/go-runtime/internal/providercli"
	"github.com/tsekaluk/pebble/go-runtime/internal/providerrest"
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

// ListReviewWorkItems lists pull requests for the REST-backed providers
// (bitbucket, azure-devops, gitea) that have no supported CLI. The provider's
// repo is derived from the workdir's primary git remote, mirroring Electron's
// repository-ref resolution; tokens come from the same PEBBLE_* env vars
// Electron's clients read.
func (m *Manager) ListReviewWorkItems(
	ctx context.Context,
	projectID string,
	worktreeID string,
	provider string,
	state string,
	limit int,
) ([]providerrest.ReviewWorkItem, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	remoteURL, err := readPrimaryGitRemoteURL(ctx, workdir)
	if err != nil {
		return nil, err
	}
	client := http.DefaultClient
	switch provider {
	case "bitbucket":
		return providerrest.ListBitbucketPRs(ctx, client, providerrest.BitbucketConfigFromEnv(), remoteURL, state, limit)
	case "azure-devops":
		return providerrest.ListAzureDevOpsPRs(ctx, client, providerrest.AzureDevOpsConfigFromEnv(), remoteURL, state, limit)
	case "gitea":
		return providerrest.ListGiteaPRs(ctx, client, providerrest.GiteaConfigFromEnv(), remoteURL, state, limit)
	default:
		return nil, providerrest.ErrProviderUnsupported
	}
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
	case "bitbucket", "azure-devops", "gitea":
		return m.createRESTHostedReview(ctx, workdir, request)
	default:
		return providercli.CreateReviewResult{
			Code:  "unsupported_provider",
			Error: "Creating reviews for this provider is not supported yet.",
		}, nil
	}
}

// createRESTHostedReview dispatches PR creation for the REST-backed providers
// (bitbucket, azure-devops, gitea), which have no bundled CLI. The repo ref is
// derived from the workdir's primary git remote, matching ListReviewWorkItems.
func (m *Manager) createRESTHostedReview(
	ctx context.Context,
	workdir string,
	request providercli.CreateReviewRequest,
) (providercli.CreateReviewResult, error) {
	remoteURL, err := readPrimaryGitRemoteURL(ctx, workdir)
	if err != nil {
		return providercli.CreateReviewResult{}, err
	}
	client := http.DefaultClient
	input := providerrest.CreateReviewInput{
		Base: request.Base, Head: request.Head, Title: request.Title,
		Body: request.Body, Draft: request.Draft, UseTemplate: request.UseTemplate,
	}
	var out providerrest.CreateReviewOutput
	switch request.Provider {
	case "bitbucket":
		out = providerrest.CreateBitbucketPR(ctx, client, providerrest.BitbucketConfigFromEnv(), remoteURL, input)
	case "azure-devops":
		out = providerrest.CreateAzureDevOpsPR(ctx, client, providerrest.AzureDevOpsConfigFromEnv(), remoteURL, input)
	case "gitea":
		out = providerrest.CreateGiteaPR(ctx, client, providerrest.GiteaConfigFromEnv(), remoteURL, input)
	default:
		return providercli.CreateReviewResult{
			Code:  "unsupported_provider",
			Error: "Creating reviews for this provider is not supported yet.",
		}, nil
	}
	return convertCreateReviewOutput(out), nil
}

func convertCreateReviewOutput(out providerrest.CreateReviewOutput) providercli.CreateReviewResult {
	result := providercli.CreateReviewResult{OK: out.OK, Number: out.Number, URL: out.URL, Code: out.Code, Error: out.Error}
	if out.ExistingReview != nil {
		result.ExistingReview = &providercli.ReviewSummary{Number: out.ExistingReview.Number, URL: out.ExistingReview.URL}
	}
	return result
}

// UpdateHostedReview applies a post-creation mutation (title/body edit,
// reviewer add/remove, close/reopen) to an existing provider review. Remote
// projects stay relay-owned, matching CreateHostedReview's local-only scope.
func (m *Manager) UpdateHostedReview(
	ctx context.Context,
	projectID string,
	worktreeID string,
	request providercli.UpdateReviewRequest,
) (providercli.UpdateReviewResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.UpdateReviewResult{}, err
	}
	switch request.Provider {
	case "github":
		return providercli.UpdateGitHubPullRequest(ctx, workdir, request), nil
	case "gitlab":
		return providercli.UpdateGitLabMergeRequest(ctx, workdir, request), nil
	case "bitbucket", "azure-devops", "gitea":
		return m.updateRESTHostedReview(ctx, workdir, request)
	default:
		return providercli.UpdateReviewResult{
			Code:  "unsupported_provider",
			Error: "Updating reviews for this provider is not supported yet.",
		}, nil
	}
}

// updateRESTHostedReview dispatches PR updates for the REST-backed providers
// (bitbucket, azure-devops, gitea), mirroring createRESTHostedReview's
// remote-derived repo-ref resolution.
func (m *Manager) updateRESTHostedReview(
	ctx context.Context,
	workdir string,
	request providercli.UpdateReviewRequest,
) (providercli.UpdateReviewResult, error) {
	remoteURL, err := readPrimaryGitRemoteURL(ctx, workdir)
	if err != nil {
		return providercli.UpdateReviewResult{}, err
	}
	client := http.DefaultClient
	input := providerrest.UpdateReviewInput{
		Title: request.Title, Body: request.Body, State: request.State,
		AddReviewers: request.AddReviewers, RemoveReviewers: request.RemoveReviewers,
	}
	var out providerrest.UpdateReviewOutput
	switch request.Provider {
	case "bitbucket":
		out = providerrest.UpdateBitbucketPR(ctx, client, providerrest.BitbucketConfigFromEnv(), remoteURL, request.Number, input)
	case "azure-devops":
		out = providerrest.UpdateAzureDevOpsPR(ctx, client, providerrest.AzureDevOpsConfigFromEnv(), remoteURL, request.Number, input)
	case "gitea":
		out = providerrest.UpdateGiteaPR(ctx, client, providerrest.GiteaConfigFromEnv(), remoteURL, request.Number, input)
	default:
		return providercli.UpdateReviewResult{
			Code:  "unsupported_provider",
			Error: "Updating reviews for this provider is not supported yet.",
		}, nil
	}
	return providercli.UpdateReviewResult{OK: out.OK, Code: out.Code, Error: out.Error}, nil
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
