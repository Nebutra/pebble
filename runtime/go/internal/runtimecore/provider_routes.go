package runtimecore

import (
	"context"
	"net/http"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/providercli"
	"github.com/nebutra/pebble/runtime/go/internal/providerrest"
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

func (m *Manager) providerIssueSourcePreference(projectID, worktreeID string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if worktreeID != "" {
		if worktree, ok := m.worktrees[worktreeID]; ok {
			projectID = worktree.ProjectID
		}
	}
	return m.projects[projectID].IssueSourcePreference
}

// ListGitHubPRs lists open/recent pull requests for a repo/worktree via the gh CLI.
func (m *Manager) ListGitHubPRs(ctx context.Context, projectID string, worktreeID string, limit int) ([]providercli.GitHubWorkItem, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.ListGitHubPRs(ctx, workdir, limit)
}

func (m *Manager) ListGitHubIssues(ctx context.Context, projectID, worktreeID string, limit int) (providercli.GitHubIssueListResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.GitHubIssueListResult{}, err
	}
	return providercli.ListGitHubIssuesWithPreference(ctx, workdir, limit, m.providerIssueSourcePreference(projectID, worktreeID)), nil
}

func (m *Manager) ListGitHubWorkItems(ctx context.Context, projectID, worktreeID string, limit int, query, before string) (providercli.GitHubWorkItemsResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.GitHubWorkItemsResult{}, err
	}
	return providercli.ListGitHubWorkItemsWithPreference(ctx, workdir, limit, query, before, m.providerIssueSourcePreference(projectID, worktreeID))
}

func (m *Manager) GetGitHubWorkItem(ctx context.Context, projectID, worktreeID string, number int, itemType, owner, repo string) (*providercli.GitHubWorkItem, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.GetGitHubWorkItemWithPreference(ctx, workdir, number, itemType, owner, repo, m.providerIssueSourcePreference(projectID, worktreeID)), nil
}

func (m *Manager) CreateGitHubIssue(ctx context.Context, projectID, worktreeID, title, body string, labels, assignees []string) (providercli.GitHubIssueCreateResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.GitHubIssueCreateResult{}, err
	}
	return providercli.CreateGitHubIssue(ctx, workdir, title, body, labels, assignees, m.providerIssueSourcePreference(projectID, worktreeID)), nil
}

func (m *Manager) UpdateGitHubIssue(ctx context.Context, projectID, worktreeID string, number int, update providercli.GitHubIssueUpdate) (providercli.GitHubIssueMutationResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.GitHubIssueMutationResult{}, err
	}
	return providercli.UpdateGitHubIssue(ctx, workdir, number, update), nil
}

func (m *Manager) CountGitHubWorkItems(ctx context.Context, projectID, worktreeID, query string) (int, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return 0, err
	}
	return providercli.CountGitHubWorkItems(ctx, workdir, query, m.providerIssueSourcePreference(projectID, worktreeID)), nil
}

func (m *Manager) ListGitHubLabels(ctx context.Context, projectID, worktreeID string) ([]string, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.ListGitHubLabels(ctx, workdir, m.providerIssueSourcePreference(projectID, worktreeID)), nil
}

func (m *Manager) ListGitHubAssignableUsers(ctx context.Context, projectID, worktreeID string) ([]providercli.GitHubAssignableUser, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.ListGitHubAssignableUsers(ctx, workdir, m.providerIssueSourcePreference(projectID, worktreeID)), nil
}

func (m *Manager) GetGitHubWorkItemDetails(ctx context.Context, projectID, worktreeID string, number int, itemType string) (*providercli.GitHubWorkItemDetails, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.GetGitHubWorkItemDetails(ctx, workdir, number, itemType, m.providerIssueSourcePreference(projectID, worktreeID))
}

func (m *Manager) GetGitHubPRFileContents(ctx context.Context, projectID, worktreeID string, input providercli.GitHubPRFileContentsRequest) (providercli.GitHubPRFileContents, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.GitHubPRFileContents{}, err
	}
	return providercli.GetGitHubPRFileContents(ctx, workdir, m.providerIssueSourcePreference(projectID, worktreeID), input), nil
}

func (m *Manager) ListGitHubPRComments(ctx context.Context, projectID, worktreeID string, number int) ([]providercli.GitHubPRComment, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.ListGitHubPRComments(ctx, workdir, number, m.providerIssueSourcePreference(projectID, worktreeID)), nil
}

// GetGitHubPR returns a single pull request via the gh CLI.
func (m *Manager) GetGitHubPR(ctx context.Context, projectID string, worktreeID string, number int) (providercli.GitHubWorkItem, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.GitHubWorkItem{}, err
	}
	return providercli.GetGitHubPR(ctx, workdir, number)
}

func (m *Manager) GetGitHubPRForBranch(ctx context.Context, projectID, worktreeID string, input providercli.GitHubPRForBranchRequest) (*providercli.GitHubPRInfo, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.GetGitHubPRForBranch(ctx, workdir, input)
}

// GetGitHubPRChecks returns the check runs for a pull request via the gh CLI.
func (m *Manager) GetGitHubPRChecks(ctx context.Context, projectID string, worktreeID string, number int) ([]providercli.PRCheckDetail, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.GetGitHubPRChecks(ctx, workdir, number)
}

func (m *Manager) GetGitHubPRCheckDetails(ctx context.Context, projectID string, worktreeID string, options providercli.GitHubPRCheckDetailsOptions) (*providercli.PRCheckRunDetails, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.GetGitHubPRCheckDetails(ctx, workdir, options)
}

func (m *Manager) RerunGitHubPRChecks(ctx context.Context, projectID string, worktreeID string, number int, headSHA string, failedOnly bool) (providercli.GitHubRerunPRChecksResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.GitHubRerunPRChecksResult{}, err
	}
	return providercli.RerunGitHubPRChecks(ctx, workdir, number, headSHA, failedOnly), nil
}

func (m *Manager) GetGitHubRateLimit(ctx context.Context, force bool) providercli.GitHubRateLimitResult {
	return providercli.GetGitHubRateLimit(ctx, force)
}

func (m *Manager) GetGitHubViewer(ctx context.Context) *providercli.GitHubViewer {
	return providercli.GetGitHubViewer(ctx)
}

func (m *Manager) DiagnoseGitHubAuth(ctx context.Context) providercli.GitHubAuthDiagnostic {
	return providercli.DiagnoseGitHubAuth(ctx)
}

func (m *Manager) ResolveGitHubProjectRef(ctx context.Context, input string) providercli.GitHubProjectRefResult {
	return providercli.ResolveGitHubProjectRef(ctx, input)
}

func (m *Manager) ListAccessibleGitHubProjects(ctx context.Context) providercli.GitHubAccessibleProjectsResult {
	return providercli.ListAccessibleGitHubProjects(ctx)
}

func (m *Manager) ListGitHubProjectViews(ctx context.Context, owner, ownerType string, projectNumber int) providercli.GitHubProjectViewsResult {
	return providercli.ListGitHubProjectViews(ctx, owner, ownerType, projectNumber)
}

func (m *Manager) GetGitHubProjectViewTable(ctx context.Context, input providercli.GitHubProjectTableRequest) providercli.GitHubProjectTableResult {
	return providercli.GetGitHubProjectViewTable(ctx, input)
}

func (m *Manager) ListGitHubLabelsBySlug(ctx context.Context, owner, repo string) providercli.GitHubProjectLabelsResult {
	return providercli.ListGitHubLabelsBySlug(ctx, owner, repo)
}

func (m *Manager) ListGitHubAssignableUsersBySlug(ctx context.Context, owner, repo string) providercli.GitHubProjectAssignableUsersResult {
	return providercli.ListGitHubAssignableUsersBySlug(ctx, owner, repo)
}

func (m *Manager) ListGitHubIssueTypesBySlug(ctx context.Context, owner, repo string) providercli.GitHubProjectIssueTypesResult {
	return providercli.ListGitHubIssueTypesBySlug(ctx, owner, repo)
}

func (m *Manager) GetGitHubWorkItemDetailsBySlug(ctx context.Context, owner, repo string, number int, itemType string) (*providercli.GitHubWorkItemDetails, error) {
	return providercli.GetGitHubWorkItemDetailsBySlug(ctx, owner, repo, number, itemType)
}

func (m *Manager) UpdateGitHubIssueBySlug(ctx context.Context, owner, repo string, number int, update providercli.GitHubIssueUpdate) providercli.GitHubProjectMutationResult {
	result := providercli.UpdateGitHubIssueBySlug(ctx, owner, repo, number, update)
	if result.OK {
		return providercli.GitHubProjectMutationResult{OK: true}
	}
	return providercli.GitHubProjectMutationResult{Error: &providercli.GitHubProjectViewError{Type: "unknown", Message: result.Error}}
}

func (m *Manager) AddGitHubIssueCommentBySlug(ctx context.Context, owner, repo string, number int, body string) providercli.GitHubProjectCommentMutationResult {
	return providercli.AddGitHubIssueCommentBySlug(ctx, owner, repo, number, body)
}

func (m *Manager) UpdateGitHubIssueCommentBySlug(ctx context.Context, owner, repo string, commentID int, body string) providercli.GitHubProjectMutationResult {
	return providercli.UpdateGitHubIssueCommentBySlug(ctx, owner, repo, commentID, body)
}

func (m *Manager) DeleteGitHubIssueCommentBySlug(ctx context.Context, owner, repo string, commentID int) providercli.GitHubProjectMutationResult {
	return providercli.DeleteGitHubIssueCommentBySlug(ctx, owner, repo, commentID)
}

func (m *Manager) UpdateGitHubPullRequestBySlug(ctx context.Context, owner, repo string, number int, update providercli.GitHubProjectPullRequestUpdate) providercli.GitHubProjectMutationResult {
	return providercli.UpdateGitHubPullRequestBySlug(ctx, owner, repo, number, update)
}

func (m *Manager) UpdateGitHubProjectItemField(ctx context.Context, projectID, itemID, fieldID string, value providercli.GitHubProjectFieldMutationValue) providercli.GitHubProjectMutationResult {
	return providercli.UpdateGitHubProjectItemField(ctx, projectID, itemID, fieldID, value)
}

func (m *Manager) ClearGitHubProjectItemField(ctx context.Context, projectID, itemID, fieldID string) providercli.GitHubProjectMutationResult {
	return providercli.ClearGitHubProjectItemField(ctx, projectID, itemID, fieldID)
}

func (m *Manager) UpdateGitHubIssueTypeBySlug(ctx context.Context, owner, repo string, number int, issueTypeID *string) providercli.GitHubProjectMutationResult {
	return providercli.UpdateGitHubIssueTypeBySlug(ctx, owner, repo, number, issueTypeID)
}

// ListGitLabMRs lists merge requests for a repo/worktree via the glab CLI.
func (m *Manager) GetGitLabProjectRef(ctx context.Context, projectID, worktreeID string) (*providercli.GitLabProjectRef, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.GetGitLabProjectRef(ctx, workdir), nil
}

func (m *Manager) GetGitLabMergeRequest(ctx context.Context, projectID, worktreeID string, iid int) (*providercli.GitLabMRInfo, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.GetGitLabMergeRequest(ctx, workdir, iid), nil
}

func (m *Manager) GetGitLabMergeRequestForBranch(ctx context.Context, projectID, worktreeID, branch string, linkedMRIID int) (*providercli.GitLabMRInfo, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.GetGitLabMergeRequestForBranch(ctx, workdir, branch, linkedMRIID), nil
}

func (m *Manager) GetGitLabIssue(ctx context.Context, projectID, worktreeID string, iid int) (*providercli.GitLabIssueInfo, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.GetGitLabIssue(ctx, workdir, iid), nil
}

func (m *Manager) ListGitLabAssignableUsers(ctx context.Context, projectID, worktreeID string) ([]providercli.GitLabAssignableUser, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.ListGitLabAssignableUsers(ctx, workdir), nil
}

func (m *Manager) ListGitLabMRs(ctx context.Context, projectID string, worktreeID string, state string, perPage int, query string) ([]providercli.GitLabWorkItem, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.ListGitLabMRs(ctx, workdir, state, perPage, query)
}

func (m *Manager) ListGitLabIssues(ctx context.Context, projectID, worktreeID, state, assignee string, limit int) (providercli.GitLabIssueListResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.GitLabIssueListResult{}, err
	}
	return providercli.ListGitLabIssues(ctx, workdir, state, assignee, limit), nil
}

func (m *Manager) ListGitLabWorkItems(ctx context.Context, projectID, worktreeID, state string, page, perPage int, query string) (providercli.GitLabWorkItemsResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.GitLabWorkItemsResult{}, err
	}
	return providercli.ListGitLabWorkItems(ctx, workdir, state, page, perPage, query), nil
}

func (m *Manager) CreateGitLabIssue(ctx context.Context, projectID, worktreeID, title, body string) (providercli.GitLabIssueMutationResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.GitLabIssueMutationResult{}, err
	}
	return providercli.CreateGitLabIssue(ctx, workdir, title, body), nil
}

func (m *Manager) UpdateGitLabIssue(ctx context.Context, projectID, worktreeID string, number int, updates providercli.GitLabIssueUpdate, projectRef *providercli.GitLabProjectRef) (providercli.GitLabIssueMutationResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.GitLabIssueMutationResult{}, err
	}
	return providercli.UpdateGitLabIssue(ctx, workdir, number, updates, projectRef), nil
}

func (m *Manager) AddGitLabIssueComment(ctx context.Context, projectID, worktreeID string, number int, body string, projectRef *providercli.GitLabProjectRef) (providercli.AddReviewCommentResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.AddReviewCommentResult{}, err
	}
	return providercli.AddGitLabIssueComment(ctx, workdir, number, body, projectRef), nil
}

func (m *Manager) ListGitLabLabels(ctx context.Context, projectID, worktreeID string) ([]string, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.ListGitLabLabels(ctx, workdir), nil
}

func (m *Manager) ListGitLabTodos(ctx context.Context, projectID, worktreeID string) ([]providercli.GitLabTodo, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.ListGitLabTodos(ctx, workdir), nil
}

func (m *Manager) GetGitLabWorkItemDetails(ctx context.Context, projectID, worktreeID string, iid int, itemType string, projectRef *providercli.GitLabProjectRef) (*providercli.GitLabWorkItemDetails, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.GetGitLabWorkItemDetails(ctx, workdir, iid, itemType, projectRef), nil
}

func (m *Manager) GetGitLabWorkItemByPath(ctx context.Context, projectID, worktreeID string, iid int, itemType string, projectRef providercli.GitLabProjectRef) (*providercli.GitLabWorkItem, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return nil, err
	}
	return providercli.GetGitLabWorkItemByPath(ctx, workdir, projectRef, iid, itemType), nil
}

func (m *Manager) GetGitLabJobTrace(ctx context.Context, projectID string, worktreeID string, jobID int64, projectRef *providercli.GitLabProjectRef) (providercli.GitLabJobTraceResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.GitLabJobTraceResult{}, err
	}
	return providercli.GetGitLabJobTrace(ctx, workdir, jobID, projectRef), nil
}

func (m *Manager) RetryGitLabJob(ctx context.Context, projectID string, worktreeID string, jobID int64, projectRef *providercli.GitLabProjectRef) (providercli.GitLabRetryJobResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.GitLabRetryJobResult{}, err
	}
	return providercli.RetryGitLabJob(ctx, workdir, jobID, projectRef), nil
}

func (m *Manager) GetGitLabRateLimit(ctx context.Context, force bool, host string) providercli.GitLabRateLimitResult {
	return providercli.GetGitLabRateLimit(ctx, force, host)
}

func (m *Manager) GetGitLabViewer(ctx context.Context) *providercli.GitLabViewer {
	return providercli.GetGitLabViewer(ctx)
}

func (m *Manager) DiagnoseGitLabAuth(ctx context.Context) providercli.GitLabAuthDiagnostic {
	return providercli.DiagnoseGitLabAuth(ctx)
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
	var result providercli.CreateReviewResult
	switch request.Provider {
	case "github":
		result = providercli.CreateGitHubPullRequest(ctx, workdir, request)
	case "gitlab":
		result = providercli.CreateGitLabMergeRequest(ctx, workdir, request)
	case "bitbucket", "azure-devops", "gitea":
		result, err = m.createRESTHostedReview(ctx, workdir, request)
	default:
		result = providercli.CreateReviewResult{
			Code:  "unsupported_provider",
			Error: "Creating reviews for this provider is not supported yet.",
		}
	}
	if err == nil && result.OK {
		m.recordCreatedReview(result.URL)
	}
	return result, err
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
// reviewer mutations, close/reopen, retarget, draft/ready) to an existing provider review. Remote
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

func (m *Manager) MergeHostedReview(
	ctx context.Context,
	projectID string,
	worktreeID string,
	request providercli.MergeReviewRequest,
) (providercli.UpdateReviewResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.UpdateReviewResult{}, err
	}
	switch request.Provider {
	case "github":
		return providercli.MergeGitHubPullRequest(ctx, workdir, request), nil
	case "gitlab":
		return providercli.MergeGitLabMergeRequest(ctx, workdir, request), nil
	default:
		return providercli.UpdateReviewResult{Code: "unsupported_provider", Error: "Merging reviews for this provider is not supported yet."}, nil
	}
}

func (m *Manager) SetHostedReviewAutoMerge(ctx context.Context, projectID string, worktreeID string, request providercli.SetAutoMergeRequest) (providercli.UpdateReviewResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.UpdateReviewResult{}, err
	}
	return providercli.SetGitHubPullRequestAutoMerge(ctx, workdir, request), nil
}

func (m *Manager) AddHostedReviewComment(ctx context.Context, projectID string, worktreeID string, request providercli.AddReviewCommentRequest) (providercli.AddReviewCommentResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.AddReviewCommentResult{}, err
	}
	switch request.Provider {
	case "github":
		return providercli.AddGitHubReviewComment(ctx, workdir, request), nil
	case "gitlab":
		return providercli.AddGitLabReviewComment(ctx, workdir, request), nil
	default:
		return providercli.AddReviewCommentResult{Code: "unsupported_provider", Error: "Adding comments for this provider is not supported yet."}, nil
	}
}

func (m *Manager) AddHostedInlineReviewComment(ctx context.Context, projectID string, worktreeID string, request providercli.AddInlineReviewCommentRequest) (providercli.AddReviewCommentResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.AddReviewCommentResult{}, err
	}
	switch request.Provider {
	case "github":
		return providercli.AddGitHubInlineReviewComment(ctx, workdir, request), nil
	case "gitlab":
		return providercli.AddGitLabInlineReviewComment(ctx, workdir, request), nil
	default:
		return providercli.AddReviewCommentResult{Code: "unsupported_provider", Error: "Adding inline comments for this provider is not supported yet."}, nil
	}
}

func (m *Manager) ReplyHostedReviewComment(ctx context.Context, projectID string, worktreeID string, request providercli.ReplyReviewCommentRequest) (providercli.AddReviewCommentResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.AddReviewCommentResult{}, err
	}
	return providercli.ReplyGitHubReviewComment(ctx, workdir, request), nil
}

func (m *Manager) ResolveHostedReviewThread(ctx context.Context, projectID string, worktreeID string, request providercli.ResolveReviewThreadRequest) (providercli.UpdateReviewResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.UpdateReviewResult{}, err
	}
	switch request.Provider {
	case "github":
		return providercli.ResolveGitHubReviewThread(ctx, workdir, request), nil
	case "gitlab":
		return providercli.ResolveGitLabReviewThread(ctx, workdir, request), nil
	default:
		return providercli.UpdateReviewResult{Code: "unsupported_provider", Error: "Resolving review threads for this provider is not supported yet."}, nil
	}
}

func (m *Manager) SetHostedReviewFileViewed(ctx context.Context, projectID string, worktreeID string, request providercli.SetReviewFileViewedRequest) (providercli.UpdateReviewResult, error) {
	workdir, err := m.resolveProviderWorkdir(projectID, worktreeID)
	if err != nil {
		return providercli.UpdateReviewResult{}, err
	}
	return providercli.SetGitHubReviewFileViewed(ctx, workdir, request), nil
}

// updateRESTHostedReview dispatches PR updates for the REST-backed providers
// (bitbucket, azure-devops, gitea), mirroring createRESTHostedReview's
// remote-derived repo-ref resolution.
func (m *Manager) updateRESTHostedReview(
	ctx context.Context,
	workdir string,
	request providercli.UpdateReviewRequest,
) (providercli.UpdateReviewResult, error) {
	if request.Base != nil || request.Draft != nil {
		return providercli.UpdateReviewResult{
			Code:  "unsupported_provider",
			Error: "Retargeting and draft/ready updates are only supported for GitHub and GitLab reviews.",
		}, nil
	}
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
	if ok && (remote.Provider == hostedRemoteGitHub || remote.Provider == hostedRemoteGitLab) {
		provider := string(remote.Provider)
		currentBranch, _ := readGitOutput(ctx, workdir, "symbolic-ref", "--quiet", "--short", "HEAD")
		return HostedReviewCapabilities{
			Provider:       provider,
			Authenticated:  providercli.IsReviewProviderAuthenticated(ctx, workdir, provider, remote.Host),
			CurrentBranch:  strings.TrimSpace(currentBranch),
			DefaultBaseRef: readHostedReviewDefaultBaseRef(ctx, workdir),
		}, nil
	}
	restCapabilities, ok := providerrest.DetectReviewProviderCapabilities(remoteURL)
	if !ok {
		return HostedReviewCapabilities{Provider: "unsupported"}, nil
	}
	currentBranch, _ := readGitOutput(ctx, workdir, "symbolic-ref", "--quiet", "--short", "HEAD")
	return HostedReviewCapabilities{
		Provider:       restCapabilities.Provider,
		Authenticated:  restCapabilities.Authenticated,
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
