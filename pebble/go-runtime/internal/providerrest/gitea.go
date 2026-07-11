package providerrest

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// GiteaConfig mirrors src/main/gitea/client.ts: optional base-URL override and
// a `token` Authorization scheme.
type GiteaConfig struct {
	APIBaseURL string
	Token      string
}

// GiteaConfigFromEnv reads the same PEBBLE_GITEA_* env vars Electron reads.
func GiteaConfigFromEnv() GiteaConfig {
	base := envValue("PEBBLE_GITEA_API_BASE_URL")
	if base != "" {
		base = normalizeGiteaAPIBaseURL(base)
	}
	return GiteaConfig{
		APIBaseURL: base,
		Token:      envValue("PEBBLE_GITEA_TOKEN"),
	}
}

const giteaCredentialHint = "set PEBBLE_GITEA_TOKEN (and PEBBLE_GITEA_API_BASE_URL for self-hosted instances)"

var giteaAPIV1SuffixPattern = regexp.MustCompile(`(?i)/api/v1$`)

// normalizeGiteaAPIBaseURL mirrors normalizeGiteaApiBaseUrl in
// src/main/gitea/client.ts: append /api/v1 unless already present.
func normalizeGiteaAPIBaseURL(value string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(value), "/")
	if giteaAPIV1SuffixPattern.MatchString(trimmed) {
		return trimmed
	}
	return trimmed + "/api/v1"
}

func (c GiteaConfig) authHeaders() map[string]string {
	if c.Token == "" {
		return nil
	}
	return map[string]string{"Authorization": "token " + c.Token}
}

// knownNonGiteaHosts mirrors KNOWN_NON_GITEA_HOSTS in
// src/main/gitea/repository-ref.ts: Gitea is the fallback provider for
// self-hosted remotes, so remotes on the majors are excluded.
var knownNonGiteaHosts = map[string]bool{
	"github.com":        true,
	"gitlab.com":        true,
	"bitbucket.org":     true,
	"dev.azure.com":     true,
	"ssh.dev.azure.com": true,
}

type giteaRepoRef struct {
	Owner      string
	Repo       string
	APIBaseURL string
}

var giteaSCPLikePattern = regexp.MustCompile(`^(?:[^@/:]+@)?([^:\s/]+):(\S+?)(?:\.git)?$`)

// parseGiteaRepoRef mirrors parseGiteaRepoRef in
// src/main/gitea/repository-ref.ts, including subpath-hosted instances.
func parseGiteaRepoRef(remoteURL string) *giteaRepoRef {
	trimmed := strings.TrimSpace(remoteURL)
	if !urlSchemePattern.MatchString(trimmed) {
		if match := giteaSCPLikePattern.FindStringSubmatch(trimmed); match != nil {
			host := match[1]
			return makeGiteaRepoRef(host, match[2], "https://"+strings.ToLower(host))
		}
		return nil
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return nil
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" && scheme != "ssh" && scheme != "git+ssh" {
		return nil
	}
	webOrigin := "https://" + strings.ToLower(parsed.Hostname())
	if scheme == "http" || scheme == "https" {
		webOrigin = scheme + "://" + parsed.Host
	}
	return makeGiteaRepoRef(parsed.Hostname(), parsed.Path, webOrigin)
}

func makeGiteaRepoRef(host string, path string, webOrigin string) *giteaRepoRef {
	normalizedHost := strings.ToLower(host)
	if normalizedHost == "" || knownNonGiteaHosts[normalizedHost] ||
		strings.HasSuffix(normalizedHost, ".visualstudio.com") {
		return nil
	}
	parts := splitRemotePathSegments(strings.TrimSuffix(strings.TrimRight(path, "/"), ".git"))
	if len(parts) < 2 {
		return nil
	}
	owner := parts[len(parts)-2]
	repo := parts[len(parts)-1]
	// Gitea/Forgejo can be hosted below a URL subpath; SSH-style remotes carry
	// that base path in the repo path, so derive the API base from it.
	webBase := strings.TrimRight(webOrigin, "/")
	if basePath := parts[:len(parts)-2]; len(basePath) > 0 {
		webBase += "/" + strings.Join(basePath, "/")
	}
	return &giteaRepoRef{
		Owner:      owner,
		Repo:       repo,
		APIBaseURL: webBase + "/api/v1",
	}
}

// giteaListState maps the provider-neutral state filter onto Gitea's
// open/closed/all query values. Gitea has no dedicated "merged" filter;
// merged PRs are closed PRs with merged=true, filtered after mapping.
func giteaListState(state string) string {
	switch state {
	case "merged", "closed":
		return "closed"
	case "all":
		return "all"
	default: // "opened"
		return "open"
	}
}

type giteaPRRaw struct {
	Number    int     `json:"number"`
	Title     string  `json:"title"`
	State     *string `json:"state"`
	Merged    bool    `json:"merged"`
	Draft     bool    `json:"draft"`
	HTMLURL   string  `json:"html_url"`
	UpdatedAt string  `json:"updated_at"`
	User      *struct {
		Login    string `json:"login"`
		Username string `json:"username"`
	} `json:"user"`
	Labels []struct {
		Name string `json:"name"`
	} `json:"labels"`
	Head *giteaPRBranch `json:"head"`
	Base *giteaPRBranch `json:"base"`
}

type giteaPRBranch struct {
	Ref  string `json:"ref"`
	Sha  string `json:"sha"`
	Repo *struct {
		ID int `json:"id"`
	} `json:"repo"`
}

// ListGiteaPRs lists pull requests for the repo the remote URL points at,
// newest-updated first, mapped to the provider-neutral work-item shape.
func ListGiteaPRs(
	ctx context.Context,
	client *http.Client,
	config GiteaConfig,
	remoteURL string,
	state string,
	limit int,
) ([]ReviewWorkItem, error) {
	repo := parseGiteaRepoRef(remoteURL)
	if repo == nil {
		return nil, fmt.Errorf("%w: gitea", ErrRemoteMismatch)
	}
	if limit <= 0 {
		limit = 24
	}
	baseURL := repo.APIBaseURL
	if config.APIBaseURL != "" {
		baseURL = config.APIBaseURL
	}
	query := url.Values{}
	query.Set("state", giteaListState(state))
	query.Set("sort", "recentupdate")
	query.Set("limit", strconv.Itoa(limit))
	endpoint := fmt.Sprintf(
		"%s/repos/%s/%s/pulls?%s",
		strings.TrimRight(baseURL, "/"),
		url.PathEscape(repo.Owner),
		url.PathEscape(repo.Repo),
		query.Encode(),
	)
	var raw []giteaPRRaw
	err := fetchProviderJSON(ctx, client, endpoint, config.authHeaders(), giteaCredentialHint, &raw)
	if err != nil {
		return nil, err
	}
	items := make([]ReviewWorkItem, 0, len(raw))
	for i := range raw {
		item := mapGiteaPR(&raw[i])
		if state == "merged" && item.State != "merged" {
			continue
		}
		items = append(items, item)
	}
	return items, nil
}

func mapGiteaPR(raw *giteaPRRaw) ReviewWorkItem {
	var author *string
	if raw.User != nil {
		if raw.User.Login != "" {
			author = nullableString(raw.User.Login)
		} else {
			author = nullableString(raw.User.Username)
		}
	}
	labels := make([]string, 0, len(raw.Labels))
	for _, label := range raw.Labels {
		if label.Name != "" {
			labels = append(labels, label.Name)
		}
	}
	branchName := ""
	headSha := ""
	if raw.Head != nil {
		branchName = raw.Head.Ref
		headSha = strings.TrimSpace(raw.Head.Sha)
	}
	baseRefName := ""
	if raw.Base != nil {
		baseRefName = raw.Base.Ref
	}
	return ReviewWorkItem{
		ID:                "gitea-pr-" + strconv.Itoa(raw.Number),
		Type:              "pr",
		Number:            raw.Number,
		Title:             raw.Title,
		State:             mapGiteaPRState(raw),
		URL:               raw.HTMLURL,
		Labels:            labels,
		UpdatedAt:         raw.UpdatedAt,
		Author:            author,
		BranchName:        branchName,
		BaseRefName:       baseRefName,
		HeadSha:           headSha,
		IsCrossRepository: giteaIsCrossRepository(raw.Head, raw.Base),
	}
}

// mapGiteaPRState mirrors mapGiteaPullRequest's state derivation in
// src/main/gitea/pull-request-mappers.ts (merged > closed > draft > open).
func mapGiteaPRState(raw *giteaPRRaw) string {
	if raw.Merged {
		return "merged"
	}
	if raw.State != nil && strings.EqualFold(strings.TrimSpace(*raw.State), "closed") {
		return "closed"
	}
	if raw.Draft {
		return "draft"
	}
	return "open"
}

// giteaIsCrossRepository compares head/base repo ids. Nil when either side is
// missing so callers can't mistake "unknown" for "same repo".
func giteaIsCrossRepository(head, base *giteaPRBranch) *bool {
	if head == nil || base == nil || head.Repo == nil || base.Repo == nil {
		return nil
	}
	isCross := head.Repo.ID != base.Repo.ID
	return &isCross
}

// CreateGiteaPR creates a pull request via a POST to the pulls collection
// endpoint (Gitea/Forgejo REST API). Gitea's API is the closest of the three
// REST-backed providers to GitHub's own PR shape.
func CreateGiteaPR(
	ctx context.Context,
	client *http.Client,
	config GiteaConfig,
	remoteURL string,
	input CreateReviewInput,
) CreateReviewOutput {
	repo := parseGiteaRepoRef(remoteURL)
	if repo == nil {
		return CreateReviewOutput{Code: "unsupported_provider", Error: "Creating pull requests requires a Gitea remote."}
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
		"base":  base,
		"head":  head,
		"title": title,
		"body":  input.Body,
	}
	if input.Draft {
		requestBody["draft"] = true
	}
	baseURL := repo.APIBaseURL
	if config.APIBaseURL != "" {
		baseURL = config.APIBaseURL
	}
	endpoint := fmt.Sprintf("%s/repos/%s/%s/pulls", strings.TrimRight(baseURL, "/"), url.PathEscape(repo.Owner), url.PathEscape(repo.Repo))
	var raw giteaPRRaw
	_, err := mutateProviderJSON(ctx, client, http.MethodPost, endpoint, config.authHeaders(), giteaCredentialHint, requestBody, &raw)
	if err != nil {
		result := classifyGiteaWriteError("Create", err)
		if result.Code == "already_exists" || result.Code == "unknown_completion" {
			if existing := findExistingGiteaPR(ctx, client, config, repo, head); existing != nil {
				result.Code = "already_exists"
				result.Error = "A pull request already exists for this branch."
				result.ExistingReview = existing
			}
		}
		return result
	}
	if raw.Number <= 0 {
		if existing := findExistingGiteaPR(ctx, client, config, repo, head); existing != nil {
			return CreateReviewOutput{OK: true, Number: existing.Number, URL: existing.URL}
		}
		return CreateReviewOutput{Code: "unknown_completion", Error: "PR creation may have completed. Refreshing branch review state..."}
	}
	created := mapGiteaPR(&raw)
	return CreateReviewOutput{OK: true, Number: created.Number, URL: created.URL}
}

// UpdateGiteaPR updates title/body/state via PATCH to the pull request
// resource, and reviewer add/remove via the requested_reviewers sub-resource
// (POST to add, DELETE to remove) -- following review_update.go's GitHub
// branch for behavior parity where Gitea's endpoints line up with gh's.
func UpdateGiteaPR(
	ctx context.Context,
	client *http.Client,
	config GiteaConfig,
	remoteURL string,
	number int,
	input UpdateReviewInput,
) UpdateReviewOutput {
	repo := parseGiteaRepoRef(remoteURL)
	if repo == nil {
		return UpdateReviewOutput{Code: "unsupported_provider", Error: "Updating pull requests requires a Gitea remote."}
	}
	if number <= 0 {
		return UpdateReviewOutput{Code: "validation", Error: "Update PR failed: a pull request number is required."}
	}
	baseURL := repo.APIBaseURL
	if config.APIBaseURL != "" {
		baseURL = config.APIBaseURL
	}
	resourcePath := fmt.Sprintf("%s/repos/%s/%s/pulls/%d", strings.TrimRight(baseURL, "/"), url.PathEscape(repo.Owner), url.PathEscape(repo.Repo), number)

	fields := map[string]interface{}{}
	if input.Title != nil {
		title := strings.TrimSpace(*input.Title)
		if title == "" {
			return UpdateReviewOutput{Code: "validation", Error: "Update PR failed: title cannot be empty."}
		}
		fields["title"] = title
	}
	if input.Body != nil {
		fields["body"] = *input.Body
	}
	switch input.State {
	case "closed":
		fields["state"] = "closed"
	case "open":
		fields["state"] = "open"
	case "":
		// no state change requested
	default:
		return UpdateReviewOutput{Code: "validation", Error: "Update PR failed: state must be \"open\" or \"closed\"."}
	}
	if len(fields) > 0 {
		if _, err := mutateProviderJSON(ctx, client, http.MethodPatch, resourcePath, config.authHeaders(), giteaCredentialHint, fields, nil); err != nil {
			result := classifyGiteaWriteError("Update", err)
			return UpdateReviewOutput{OK: false, Code: result.Code, Error: strings.Replace(result.Error, "Create PR", "Update PR", 1)}
		}
	}
	if len(input.AddReviewers) > 0 {
		if err := postGiteaReviewers(ctx, client, config, resourcePath, input.AddReviewers); err != nil {
			result := classifyGiteaWriteError("Update", err)
			return UpdateReviewOutput{OK: false, Code: result.Code, Error: strings.Replace(result.Error, "Create PR", "Update PR", 1)}
		}
	}
	if len(input.RemoveReviewers) > 0 {
		if err := deleteGiteaReviewers(ctx, client, config, resourcePath, input.RemoveReviewers); err != nil {
			result := classifyGiteaWriteError("Update", err)
			return UpdateReviewOutput{OK: false, Code: result.Code, Error: strings.Replace(result.Error, "Create PR", "Update PR", 1)}
		}
	}
	return UpdateReviewOutput{OK: true}
}

func postGiteaReviewers(ctx context.Context, client *http.Client, config GiteaConfig, resourcePath string, reviewers []string) error {
	logins := normalizeGiteaReviewerLogins(reviewers)
	if len(logins) == 0 {
		return nil
	}
	_, err := mutateProviderJSON(
		ctx, client, http.MethodPost, resourcePath+"/requested_reviewers",
		config.authHeaders(), giteaCredentialHint, map[string]interface{}{"reviewers": logins}, nil,
	)
	return err
}

func deleteGiteaReviewers(ctx context.Context, client *http.Client, config GiteaConfig, resourcePath string, reviewers []string) error {
	logins := normalizeGiteaReviewerLogins(reviewers)
	if len(logins) == 0 {
		return nil
	}
	_, err := mutateProviderJSON(
		ctx, client, http.MethodDelete, resourcePath+"/requested_reviewers",
		config.authHeaders(), giteaCredentialHint, map[string]interface{}{"reviewers": logins}, nil,
	)
	return err
}

func normalizeGiteaReviewerLogins(reviewers []string) []string {
	logins := make([]string, 0, len(reviewers))
	for _, reviewer := range reviewers {
		trimmed := strings.TrimSpace(reviewer)
		if trimmed != "" {
			logins = append(logins, trimmed)
		}
	}
	return logins
}

func findExistingGiteaPR(
	ctx context.Context,
	client *http.Client,
	config GiteaConfig,
	repo *giteaRepoRef,
	head string,
) *ReviewSummary {
	baseURL := repo.APIBaseURL
	if config.APIBaseURL != "" {
		baseURL = config.APIBaseURL
	}
	query := url.Values{}
	query.Set("state", "open")
	query.Set("limit", "25")
	endpoint := fmt.Sprintf("%s/repos/%s/%s/pulls?%s", strings.TrimRight(baseURL, "/"), url.PathEscape(repo.Owner), url.PathEscape(repo.Repo), query.Encode())
	var raw []giteaPRRaw
	if err := fetchProviderJSON(ctx, client, endpoint, config.authHeaders(), giteaCredentialHint, &raw); err != nil {
		return nil
	}
	for i := range raw {
		if raw[i].Head != nil && strings.EqualFold(raw[i].Head.Ref, head) {
			item := mapGiteaPR(&raw[i])
			return &ReviewSummary{Number: item.Number, URL: item.URL}
		}
	}
	return nil
}

func classifyGiteaWriteError(action string, err error) CreateReviewOutput {
	code, message := classifyReviewWriteError(action, "Gitea", err)
	return CreateReviewOutput{Code: code, Error: message}
}
