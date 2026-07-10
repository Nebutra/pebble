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
