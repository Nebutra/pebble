package providerrest

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// AzureDevOpsConfig mirrors src/main/azure-devops/azure-devops-api-request.ts:
// Bearer access token first, then Basic username:PAT.
type AzureDevOpsConfig struct {
	APIBaseURL  string
	PAT         string
	AccessToken string
	Username    string
}

// AzureDevOpsConfigFromEnv reads the same PEBBLE_AZURE_DEVOPS_* env vars Electron reads.
func AzureDevOpsConfigFromEnv() AzureDevOpsConfig {
	pat := envValue("PEBBLE_AZURE_DEVOPS_TOKEN")
	if pat == "" {
		pat = envValue("PEBBLE_AZURE_DEVOPS_PAT")
	}
	return AzureDevOpsConfig{
		APIBaseURL:  normalizeAzureDevOpsAPIBaseURL(envValue("PEBBLE_AZURE_DEVOPS_API_BASE_URL")),
		PAT:         pat,
		AccessToken: envValue("PEBBLE_AZURE_DEVOPS_ACCESS_TOKEN"),
		Username:    envValue("PEBBLE_AZURE_DEVOPS_USERNAME"),
	}
}

const azureDevOpsCredentialHint = "set PEBBLE_AZURE_DEVOPS_ACCESS_TOKEN or PEBBLE_AZURE_DEVOPS_TOKEN (PAT)"

var azureDevOpsAPIsSuffixPattern = regexp.MustCompile(`(?i)/_apis$`)

func normalizeAzureDevOpsAPIBaseURL(value string) string {
	return azureDevOpsAPIsSuffixPattern.ReplaceAllString(strings.TrimRight(strings.TrimSpace(value), "/"), "")
}

func (c AzureDevOpsConfig) authHeaders() map[string]string {
	if c.AccessToken != "" {
		return map[string]string{"Authorization": "Bearer " + c.AccessToken}
	}
	if c.PAT != "" {
		encoded := base64.StdEncoding.EncodeToString([]byte(c.Username + ":" + c.PAT))
		return map[string]string{"Authorization": "Basic " + encoded}
	}
	return nil
}

type azureDevOpsRepoRef struct {
	Repository string
	APIBaseURL string
	WebBaseURL string
}

var azureDevOpsSCPLikePattern = regexp.MustCompile(`^(?:[^@/:]+@)?([^:\s/]+):(\S+?)(?:\.git)?$`)

// parseAzureDevOpsRepoRef mirrors parseAzureDevOpsRepoRef in
// src/main/azure-devops/repository-ref.ts: dev.azure.com URLs,
// ssh.dev.azure.com v3 remotes, *.visualstudio.com, and on-prem servers
// identified by the `_git` path convention.
func parseAzureDevOpsRepoRef(remoteURL string) *azureDevOpsRepoRef {
	trimmed := strings.TrimSpace(remoteURL)
	if !urlSchemePattern.MatchString(trimmed) {
		if match := azureDevOpsSCPLikePattern.FindStringSubmatch(trimmed); match != nil {
			return parseAzureDevOpsCloudSSHPath(match[1], match[2])
		}
		return nil
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return nil
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "ssh.dev.azure.com" {
		return parseAzureDevOpsCloudSSHPath(host, parsed.Path)
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" && scheme != "ssh" && scheme != "git+ssh" {
		return nil
	}
	segments, gitIndex := azureDevOpsGitPathSegments(parsed.Path)
	if gitIndex < 1 {
		return nil
	}
	project := segments[gitIndex-1]
	repository := segments[gitIndex+1]
	prefix := segments[:gitIndex-1]
	if host == "dev.azure.com" {
		if len(prefix) == 0 {
			return nil
		}
		return makeAzureDevOpsCloudRef(prefix[0], project, repository)
	}
	if strings.HasSuffix(host, ".visualstudio.com") {
		organization := strings.TrimSuffix(host, ".visualstudio.com")
		if organization == "" {
			return nil
		}
		return makeAzureDevOpsCloudRef(organization, project, repository)
	}
	if scheme != "http" && scheme != "https" {
		return nil
	}
	// Azure DevOps Server remotes are self-hosted and only reliably
	// identifiable by the `_git` path convention.
	origin := scheme + "://" + parsed.Host
	base := joinAzureDevOpsURL(origin, append(append([]string{}, prefix...), project))
	return &azureDevOpsRepoRef{
		Repository: repository,
		APIBaseURL: base,
		WebBaseURL: joinAzureDevOpsURL(origin, append(append([]string{}, prefix...), project, "_git", repository)),
	}
}

func parseAzureDevOpsCloudSSHPath(host string, rawPath string) *azureDevOpsRepoRef {
	if !strings.EqualFold(host, "ssh.dev.azure.com") {
		return nil
	}
	parts := splitRemotePathSegments(strings.TrimSuffix(strings.TrimRight(rawPath, "/"), ".git"))
	if len(parts) < 4 || !strings.EqualFold(parts[0], "v3") {
		return nil
	}
	return makeAzureDevOpsCloudRef(parts[1], parts[2], parts[3])
}

func makeAzureDevOpsCloudRef(organization string, project string, repository string) *azureDevOpsRepoRef {
	if organization == "" || project == "" || repository == "" {
		return nil
	}
	return &azureDevOpsRepoRef{
		Repository: repository,
		APIBaseURL: joinAzureDevOpsURL("https://dev.azure.com", []string{organization, project}),
		WebBaseURL: joinAzureDevOpsURL("https://dev.azure.com", []string{organization, project, "_git", repository}),
	}
}

func azureDevOpsGitPathSegments(pathname string) ([]string, int) {
	segments := splitRemotePathSegments(strings.TrimSuffix(strings.TrimRight(pathname, "/"), ".git"))
	for i, segment := range segments {
		if strings.EqualFold(segment, "_git") {
			if i < 1 || i+1 >= len(segments) {
				return nil, -1
			}
			return segments, i
		}
	}
	return nil, -1
}

func joinAzureDevOpsURL(origin string, segments []string) string {
	encoded := make([]string, 0, len(segments))
	for _, segment := range segments {
		encoded = append(encoded, url.PathEscape(segment))
	}
	return strings.TrimRight(origin, "/") + "/" + strings.Join(encoded, "/")
}

// azureDevOpsListStatus maps the provider-neutral state filter onto
// searchCriteria.status values.
func azureDevOpsListStatus(state string) string {
	switch state {
	case "merged":
		return "completed"
	case "closed":
		return "abandoned"
	case "all":
		return "all"
	default: // "opened"
		return "active"
	}
}

type azureDevOpsPRRaw struct {
	PullRequestID int     `json:"pullRequestId"`
	Title         string  `json:"title"`
	Status        *string `json:"status"`
	IsDraft       bool    `json:"isDraft"`
	CreationDate  string  `json:"creationDate"`
	ClosedDate    string  `json:"closedDate"`
	SourceRefName string  `json:"sourceRefName"`
	TargetRefName string  `json:"targetRefName"`
	CreatedBy     *struct {
		UniqueName  string `json:"uniqueName"`
		DisplayName string `json:"displayName"`
	} `json:"createdBy"`
	LastMergeSourceCommit *struct {
		CommitID string `json:"commitId"`
	} `json:"lastMergeSourceCommit"`
	Labels []struct {
		Name string `json:"name"`
	} `json:"labels"`
	// ForkSource is only present on fork PRs; raw presence is the fork signal.
	ForkSource json.RawMessage `json:"forkSource"`
	Links      *struct {
		Web *struct {
			Href string `json:"href"`
		} `json:"web"`
	} `json:"_links"`
}

// ListAzureDevOpsPRs lists pull requests for the repo the remote URL points
// at, mapped to the provider-neutral work-item shape.
func ListAzureDevOpsPRs(
	ctx context.Context,
	client *http.Client,
	config AzureDevOpsConfig,
	remoteURL string,
	state string,
	limit int,
) ([]ReviewWorkItem, error) {
	repo := parseAzureDevOpsRepoRef(remoteURL)
	if repo == nil {
		return nil, fmt.Errorf("%w: azure-devops", ErrRemoteMismatch)
	}
	if limit <= 0 {
		limit = 24
	}
	baseURL := repo.APIBaseURL
	if config.APIBaseURL != "" {
		baseURL = config.APIBaseURL
	}
	query := url.Values{}
	query.Set("searchCriteria.status", azureDevOpsListStatus(state))
	query.Set("$top", strconv.Itoa(limit))
	query.Set("api-version", "7.1")
	endpoint := fmt.Sprintf(
		"%s/_apis/git/repositories/%s/pullrequests?%s",
		strings.TrimRight(baseURL, "/"),
		url.PathEscape(repo.Repository),
		query.Encode(),
	)
	var response struct {
		Value []azureDevOpsPRRaw `json:"value"`
	}
	err := fetchProviderJSON(ctx, client, endpoint, config.authHeaders(), azureDevOpsCredentialHint, &response)
	if err != nil {
		return nil, err
	}
	items := make([]ReviewWorkItem, 0, len(response.Value))
	for i := range response.Value {
		items = append(items, mapAzureDevOpsPR(&response.Value[i], repo.WebBaseURL))
	}
	return items, nil
}

func mapAzureDevOpsPR(raw *azureDevOpsPRRaw, webBaseURL string) ReviewWorkItem {
	var author *string
	if raw.CreatedBy != nil {
		if raw.CreatedBy.UniqueName != "" {
			author = nullableString(raw.CreatedBy.UniqueName)
		} else {
			author = nullableString(raw.CreatedBy.DisplayName)
		}
	}
	labels := make([]string, 0, len(raw.Labels))
	for _, label := range raw.Labels {
		if label.Name != "" {
			labels = append(labels, label.Name)
		}
	}
	prURL := ""
	if raw.Links != nil && raw.Links.Web != nil {
		prURL = raw.Links.Web.Href
	}
	if prURL == "" {
		prURL = strings.TrimRight(webBaseURL, "/") + "/pullrequest/" + strconv.Itoa(raw.PullRequestID)
	}
	updatedAt := raw.ClosedDate
	if updatedAt == "" {
		updatedAt = raw.CreationDate
	}
	headSha := ""
	if raw.LastMergeSourceCommit != nil {
		headSha = strings.TrimSpace(raw.LastMergeSourceCommit.CommitID)
	}
	// forkSource is only serialized for fork PRs, so raw presence is a reliable
	// same-repo/fork discriminator (mirrors Electron's fork handling).
	isCross := len(raw.ForkSource) > 0 && string(raw.ForkSource) != "null"
	return ReviewWorkItem{
		ID:                "azure-devops-pr-" + strconv.Itoa(raw.PullRequestID),
		Type:              "pr",
		Number:            raw.PullRequestID,
		Title:             raw.Title,
		State:             mapAzureDevOpsPRState(raw),
		URL:               prURL,
		Labels:            labels,
		UpdatedAt:         updatedAt,
		Author:            author,
		BranchName:        strings.TrimPrefix(raw.SourceRefName, "refs/heads/"),
		BaseRefName:       strings.TrimPrefix(raw.TargetRefName, "refs/heads/"),
		HeadSha:           headSha,
		IsCrossRepository: &isCross,
	}
}

// mapAzureDevOpsPRState mirrors mapAzureDevOpsPullRequestState in
// src/main/azure-devops/pull-request-mappers.ts.
func mapAzureDevOpsPRState(raw *azureDevOpsPRRaw) string {
	status := ""
	if raw.Status != nil {
		status = strings.ToLower(strings.TrimSpace(*raw.Status))
	}
	if status == "completed" {
		return "merged"
	}
	if status == "abandoned" {
		return "closed"
	}
	if raw.IsDraft {
		return "draft"
	}
	return "open"
}

func azureDevOpsBranchRef(branch string) string {
	return "refs/heads/" + strings.TrimPrefix(branch, "refs/heads/")
}

func azureDevOpsAPIURL(repo *azureDevOpsRepoRef, config AzureDevOpsConfig, path string) string {
	baseURL := repo.APIBaseURL
	if config.APIBaseURL != "" {
		baseURL = config.APIBaseURL
	}
	query := url.Values{}
	query.Set("api-version", "7.1")
	return strings.TrimRight(baseURL, "/") + path + "?" + query.Encode()
}

// CreateAzureDevOpsPR creates a pull request via a POST to the pullrequests
// collection endpoint (Azure DevOps REST API). Azure DevOps has no bundled
// CLI to shell out to, so this goes straight to REST.
func CreateAzureDevOpsPR(
	ctx context.Context,
	client *http.Client,
	config AzureDevOpsConfig,
	remoteURL string,
	input CreateReviewInput,
) CreateReviewOutput {
	repo := parseAzureDevOpsRepoRef(remoteURL)
	if repo == nil {
		return CreateReviewOutput{Code: "unsupported_provider", Error: "Creating pull requests requires an Azure DevOps remote."}
	}
	base := strings.TrimSpace(input.Base)
	head := strings.TrimSpace(input.Head)
	title := strings.TrimSpace(input.Title)
	if base == "" || head == "" || title == "" {
		return CreateReviewOutput{Code: "validation", Error: "Create PR failed: base branch, head branch, and title are required."}
	}
	if strings.EqualFold(base, head) {
		return CreateReviewOutput{Code: "validation", Error: "Create PR failed: choose a different base branch before creating a pull request."}
	}
	requestBody := map[string]interface{}{
		"sourceRefName": azureDevOpsBranchRef(head),
		"targetRefName": azureDevOpsBranchRef(base),
		"title":         title,
		"description":   input.Body,
	}
	if input.Draft {
		requestBody["isDraft"] = true
	}
	endpoint := azureDevOpsAPIURL(repo, config, "/_apis/git/repositories/"+url.PathEscape(repo.Repository)+"/pullrequests")
	var raw azureDevOpsPRRaw
	_, err := mutateProviderJSON(ctx, client, http.MethodPost, endpoint, config.authHeaders(), azureDevOpsCredentialHint, requestBody, &raw)
	if err != nil {
		result := classifyAzureDevOpsWriteError("Create", err)
		if result.Code == "already_exists" || result.Code == "unknown_completion" {
			if existing := findExistingAzureDevOpsPR(ctx, client, config, repo, head); existing != nil {
				result.Code = "already_exists"
				result.Error = "A pull request already exists for this branch."
				result.ExistingReview = existing
			}
		}
		return result
	}
	if raw.PullRequestID <= 0 {
		if existing := findExistingAzureDevOpsPR(ctx, client, config, repo, head); existing != nil {
			return CreateReviewOutput{OK: true, Number: existing.Number, URL: existing.URL}
		}
		return CreateReviewOutput{Code: "unknown_completion", Error: "PR creation may have completed. Refreshing branch review state..."}
	}
	created := mapAzureDevOpsPR(&raw, repo.WebBaseURL)
	return CreateReviewOutput{OK: true, Number: created.Number, URL: created.URL}
}

// UpdateAzureDevOpsPR updates title/description/status via PATCH to the pull
// request resource. Azure DevOps only supports status transitions among
// active/abandoned/completed (no distinct "closed" concept), so close maps to
// "abandoned" and reopen maps to "active" -- the closest real equivalents,
// not a faithful close/reopen pair (there is no way to un-complete a merged
// PR, and re-activating an abandoned PR is Azure's actual reopen mechanism).
func UpdateAzureDevOpsPR(
	ctx context.Context,
	client *http.Client,
	config AzureDevOpsConfig,
	remoteURL string,
	number int,
	input UpdateReviewInput,
) UpdateReviewOutput {
	repo := parseAzureDevOpsRepoRef(remoteURL)
	if repo == nil {
		return UpdateReviewOutput{Code: "unsupported_provider", Error: "Updating pull requests requires an Azure DevOps remote."}
	}
	if number <= 0 {
		return UpdateReviewOutput{Code: "validation", Error: "Update PR failed: a pull request number is required."}
	}
	resourcePath := "/_apis/git/repositories/" + url.PathEscape(repo.Repository) + "/pullrequests/" + strconv.Itoa(number)
	endpoint := azureDevOpsAPIURL(repo, config, resourcePath)

	fields := map[string]interface{}{}
	if input.Title != nil {
		title := strings.TrimSpace(*input.Title)
		if title == "" {
			return UpdateReviewOutput{Code: "validation", Error: "Update PR failed: title cannot be empty."}
		}
		fields["title"] = title
	}
	if input.Body != nil {
		fields["description"] = *input.Body
	}
	switch input.State {
	case "closed":
		fields["status"] = "abandoned"
	case "open":
		fields["status"] = "active"
	case "":
		// no state change requested
	default:
		return UpdateReviewOutput{Code: "validation", Error: "Update PR failed: state must be \"open\" or \"closed\"."}
	}
	if len(fields) > 0 {
		if _, err := mutateProviderJSON(ctx, client, http.MethodPatch, endpoint, config.authHeaders(), azureDevOpsCredentialHint, fields, nil); err != nil {
			result := classifyAzureDevOpsWriteError("Update", err)
			return UpdateReviewOutput{OK: false, Code: result.Code, Error: strings.Replace(result.Error, "Create PR", "Update PR", 1)}
		}
	}
	if len(input.AddReviewers) > 0 || len(input.RemoveReviewers) > 0 {
		if err := updateAzureDevOpsReviewers(ctx, client, config, repo, number, input); err != nil {
			result := classifyAzureDevOpsWriteError("Update", err)
			return UpdateReviewOutput{OK: false, Code: result.Code, Error: strings.Replace(result.Error, "Create PR", "Update PR", 1)}
		}
	}
	return UpdateReviewOutput{OK: true}
}

// updateAzureDevOpsReviewers adds/removes reviewers via the reviewers
// sub-resource: PUT to add (upsert-by-id), DELETE to remove.
func updateAzureDevOpsReviewers(
	ctx context.Context,
	client *http.Client,
	config AzureDevOpsConfig,
	repo *azureDevOpsRepoRef,
	number int,
	input UpdateReviewInput,
) error {
	base := "/_apis/git/repositories/" + url.PathEscape(repo.Repository) + "/pullrequests/" + strconv.Itoa(number) + "/reviewers"
	for _, reviewer := range input.AddReviewers {
		reviewer = strings.TrimSpace(reviewer)
		if reviewer == "" {
			continue
		}
		endpoint := azureDevOpsAPIURL(repo, config, base+"/"+url.PathEscape(reviewer))
		if _, err := mutateProviderJSON(ctx, client, http.MethodPut, endpoint, config.authHeaders(), azureDevOpsCredentialHint, map[string]interface{}{"vote": 0}, nil); err != nil {
			return err
		}
	}
	for _, reviewer := range input.RemoveReviewers {
		reviewer = strings.TrimSpace(reviewer)
		if reviewer == "" {
			continue
		}
		endpoint := azureDevOpsAPIURL(repo, config, base+"/"+url.PathEscape(reviewer))
		if _, err := mutateProviderJSON(ctx, client, http.MethodDelete, endpoint, config.authHeaders(), azureDevOpsCredentialHint, nil, nil); err != nil {
			return err
		}
	}
	return nil
}

func findExistingAzureDevOpsPR(
	ctx context.Context,
	client *http.Client,
	config AzureDevOpsConfig,
	repo *azureDevOpsRepoRef,
	head string,
) *ReviewSummary {
	items, err := ListAzureDevOpsPRs(ctx, client, config, repo.WebBaseURL, "all", 25)
	if err != nil {
		return nil
	}
	for i := range items {
		if strings.EqualFold(items[i].BranchName, head) {
			return &ReviewSummary{Number: items[i].Number, URL: items[i].URL}
		}
	}
	return nil
}

func classifyAzureDevOpsWriteError(action string, err error) CreateReviewOutput {
	code, message := classifyReviewWriteError(action, "Azure DevOps", err)
	return CreateReviewOutput{Code: code, Error: message}
}
