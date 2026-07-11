package providerrest

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const defaultBitbucketAPIBaseURL = "https://api.bitbucket.org/2.0"

// BitbucketConfig mirrors the auth config in src/main/bitbucket/client.ts:
// Bearer access token first, then Basic email:api-token.
type BitbucketConfig struct {
	APIBaseURL  string
	AccessToken string
	Email       string
	APIToken    string
}

// BitbucketConfigFromEnv reads the same PEBBLE_BITBUCKET_* env vars Electron reads.
func BitbucketConfigFromEnv() BitbucketConfig {
	base := strings.TrimRight(envValue("PEBBLE_BITBUCKET_API_BASE_URL"), "/")
	if base == "" {
		base = defaultBitbucketAPIBaseURL
	}
	return BitbucketConfig{
		APIBaseURL:  base,
		AccessToken: envValue("PEBBLE_BITBUCKET_ACCESS_TOKEN"),
		Email:       envValue("PEBBLE_BITBUCKET_EMAIL"),
		APIToken:    envValue("PEBBLE_BITBUCKET_API_TOKEN"),
	}
}

const bitbucketCredentialHint = "set PEBBLE_BITBUCKET_ACCESS_TOKEN or PEBBLE_BITBUCKET_EMAIL + PEBBLE_BITBUCKET_API_TOKEN"

func (c BitbucketConfig) authHeaders() map[string]string {
	if c.AccessToken != "" {
		return map[string]string{"Authorization": "Bearer " + c.AccessToken}
	}
	if c.Email != "" && c.APIToken != "" {
		encoded := base64.StdEncoding.EncodeToString([]byte(c.Email + ":" + c.APIToken))
		return map[string]string{"Authorization": "Basic " + encoded}
	}
	return nil
}

type bitbucketRepoRef struct {
	Workspace string
	RepoSlug  string
}

var bitbucketSCPLikePattern = regexp.MustCompile(`(?i)^(?:[^@]+@)?bitbucket\.org:(\S+?)(?:\.git)?$`)

// parseBitbucketRepoRef mirrors parseBitbucketRepoRef in
// src/main/bitbucket/repository-ref.ts: scp-like and URL remotes on
// bitbucket.org only.
func parseBitbucketRepoRef(remoteURL string) *bitbucketRepoRef {
	trimmed := strings.TrimSpace(remoteURL)
	if match := bitbucketSCPLikePattern.FindStringSubmatch(trimmed); match != nil {
		return parseBitbucketPath(match[1])
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || !strings.EqualFold(parsed.Hostname(), "bitbucket.org") {
		return nil
	}
	return parseBitbucketPath(parsed.Path)
}

func parseBitbucketPath(pathname string) *bitbucketRepoRef {
	withoutSuffix := strings.TrimSuffix(strings.TrimRight(pathname, "/"), ".git")
	parts := splitRemotePathSegments(withoutSuffix)
	if len(parts) < 2 {
		return nil
	}
	return &bitbucketRepoRef{
		Workspace: parts[len(parts)-2],
		RepoSlug:  parts[len(parts)-1],
	}
}

func splitRemotePathSegments(path string) []string {
	parts := make([]string, 0, 4)
	for _, part := range strings.Split(path, "/") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if decoded, err := url.PathUnescape(part); err == nil {
			part = decoded
		}
		parts = append(parts, part)
	}
	return parts
}

// bitbucketListStates maps the provider-neutral state filter onto Bitbucket's
// uppercase PR states (mirrors mapBitbucketPullRequestState's state space).
func bitbucketListStates(state string) []string {
	switch state {
	case "merged":
		return []string{"MERGED"}
	case "closed":
		return []string{"DECLINED", "SUPERSEDED"}
	case "all":
		return []string{"OPEN", "MERGED", "DECLINED", "SUPERSEDED"}
	default: // "opened"
		return []string{"OPEN"}
	}
}

type bitbucketPRRaw struct {
	ID        int     `json:"id"`
	Title     string  `json:"title"`
	State     *string `json:"state"`
	UpdatedOn string  `json:"updated_on"`
	Links     struct {
		HTML struct {
			Href string `json:"href"`
		} `json:"html"`
	} `json:"links"`
	Author *struct {
		Nickname    string `json:"nickname"`
		DisplayName string `json:"display_name"`
	} `json:"author"`
	Source      bitbucketPREndpoint `json:"source"`
	Destination bitbucketPREndpoint `json:"destination"`
}

type bitbucketPREndpoint struct {
	Branch struct {
		Name string `json:"name"`
	} `json:"branch"`
	Commit *struct {
		Hash string `json:"hash"`
	} `json:"commit"`
	Repository *struct {
		FullName string `json:"full_name"`
	} `json:"repository"`
}

// ListBitbucketPRs lists pull requests for the repo the remote URL points at,
// newest-updated first, mapped to the provider-neutral work-item shape.
func ListBitbucketPRs(
	ctx context.Context,
	client *http.Client,
	config BitbucketConfig,
	remoteURL string,
	state string,
	limit int,
) ([]ReviewWorkItem, error) {
	repo := parseBitbucketRepoRef(remoteURL)
	if repo == nil {
		return nil, fmt.Errorf("%w: bitbucket", ErrRemoteMismatch)
	}
	if limit <= 0 {
		limit = 24
	}
	if limit > 50 {
		limit = 50 // Bitbucket caps pagelen at 50 for pull requests
	}
	query := url.Values{}
	query.Set("pagelen", strconv.Itoa(limit))
	query.Set("sort", "-updated_on")
	for _, s := range bitbucketListStates(state) {
		query.Add("state", s)
	}
	endpoint := fmt.Sprintf(
		"%s/repositories/%s/%s/pullrequests?%s",
		config.APIBaseURL,
		url.PathEscape(repo.Workspace),
		url.PathEscape(repo.RepoSlug),
		query.Encode(),
	)
	var response struct {
		Values []bitbucketPRRaw `json:"values"`
	}
	err := fetchProviderJSON(ctx, client, endpoint, config.authHeaders(), bitbucketCredentialHint, &response)
	if err != nil {
		return nil, err
	}
	items := make([]ReviewWorkItem, 0, len(response.Values))
	for i := range response.Values {
		items = append(items, mapBitbucketPR(&response.Values[i]))
	}
	return items, nil
}

func mapBitbucketPR(raw *bitbucketPRRaw) ReviewWorkItem {
	var author *string
	if raw.Author != nil {
		if raw.Author.Nickname != "" {
			author = nullableString(raw.Author.Nickname)
		} else {
			author = nullableString(raw.Author.DisplayName)
		}
	}
	headSha := ""
	if raw.Source.Commit != nil {
		headSha = strings.TrimSpace(raw.Source.Commit.Hash)
	}
	return ReviewWorkItem{
		ID:     "bitbucket-pr-" + strconv.Itoa(raw.ID),
		Type:   "pr",
		Number: raw.ID,
		Title:  raw.Title,
		State:  mapBitbucketPRState(raw.State),
		URL:    raw.Links.HTML.Href,
		// Bitbucket Cloud pull requests have no labels; keep the field present
		// (empty) so the row shape stays uniform across providers.
		Labels:            []string{},
		UpdatedAt:         raw.UpdatedOn,
		Author:            author,
		BranchName:        raw.Source.Branch.Name,
		BaseRefName:       raw.Destination.Branch.Name,
		HeadSha:           headSha,
		IsCrossRepository: bitbucketIsCrossRepository(&raw.Source, &raw.Destination),
	}
}

// mapBitbucketPRState mirrors mapBitbucketPullRequestState in
// src/main/bitbucket/pull-request-mappers.ts.
func mapBitbucketPRState(state *string) string {
	if state == nil {
		return "open"
	}
	switch strings.ToUpper(strings.TrimSpace(*state)) {
	case "MERGED":
		return "merged"
	case "DECLINED", "SUPERSEDED":
		return "closed"
	default:
		return "open"
	}
}

// bitbucketIsCrossRepository compares source/destination repo full names. Nil
// when either side is missing so callers can't mistake "unknown" for "same repo".
func bitbucketIsCrossRepository(source, destination *bitbucketPREndpoint) *bool {
	if source.Repository == nil || destination.Repository == nil ||
		source.Repository.FullName == "" || destination.Repository.FullName == "" {
		return nil
	}
	isCross := !strings.EqualFold(source.Repository.FullName, destination.Repository.FullName)
	return &isCross
}

// CreateBitbucketPR creates a pull request via a POST to the pullrequests
// collection endpoint (Bitbucket Cloud REST API). Bitbucket has no bundled
// CLI to shell out to, so this goes straight to REST using the same
// BitbucketConfig/authHeaders/repo-ref machinery ListBitbucketPRs uses.
func CreateBitbucketPR(
	ctx context.Context,
	client *http.Client,
	config BitbucketConfig,
	remoteURL string,
	input CreateReviewInput,
) CreateReviewOutput {
	repo := parseBitbucketRepoRef(remoteURL)
	if repo == nil {
		return CreateReviewOutput{Code: "unsupported_provider", Error: "Creating pull requests requires a Bitbucket remote."}
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
		"title":       title,
		"description": input.Body,
		"source":      map[string]interface{}{"branch": map[string]string{"name": head}},
		"destination": map[string]interface{}{"branch": map[string]string{"name": base}},
	}
	endpoint := fmt.Sprintf(
		"%s/repositories/%s/%s/pullrequests",
		config.APIBaseURL, url.PathEscape(repo.Workspace), url.PathEscape(repo.RepoSlug),
	)
	var raw bitbucketPRRaw
	_, err := mutateProviderJSON(ctx, client, http.MethodPost, endpoint, config.authHeaders(), bitbucketCredentialHint, requestBody, &raw)
	if err != nil {
		result := classifyBitbucketWriteError("Create", err)
		if result.Code == "already_exists" || result.Code == "unknown_completion" {
			if existing := findExistingBitbucketPR(ctx, client, config, repo, head); existing != nil {
				result.Code = "already_exists"
				result.Error = "A pull request already exists for this branch."
				result.ExistingReview = existing
			}
		}
		return result
	}
	if raw.ID <= 0 {
		if existing := findExistingBitbucketPR(ctx, client, config, repo, head); existing != nil {
			return CreateReviewOutput{OK: true, Number: existing.Number, URL: existing.URL}
		}
		return CreateReviewOutput{Code: "unknown_completion", Error: "PR creation may have completed. Refreshing branch review state..."}
	}
	created := mapBitbucketPR(&raw)
	return CreateReviewOutput{OK: true, Number: created.Number, URL: created.URL}
}

// UpdateBitbucketPR updates title/description via PUT to the pull request
// resource. Reviewer replacement uses the same PUT (Bitbucket Cloud's PR
// update endpoint accepts a full reviewers array, not incremental add/remove).
// Close uses the /decline state-transition endpoint. Bitbucket Cloud has no
// reopen endpoint, so State: "open" on a closed PR is an explicit unsupported
// gap rather than a faked no-op.
func UpdateBitbucketPR(
	ctx context.Context,
	client *http.Client,
	config BitbucketConfig,
	remoteURL string,
	number int,
	input UpdateReviewInput,
) UpdateReviewOutput {
	repo := parseBitbucketRepoRef(remoteURL)
	if repo == nil {
		return UpdateReviewOutput{Code: "unsupported_provider", Error: "Updating pull requests requires a Bitbucket remote."}
	}
	if number <= 0 {
		return UpdateReviewOutput{Code: "validation", Error: "Update PR failed: a pull request number is required."}
	}
	resourcePath := fmt.Sprintf(
		"%s/repositories/%s/%s/pullrequests/%d",
		config.APIBaseURL, url.PathEscape(repo.Workspace), url.PathEscape(repo.RepoSlug), number,
	)

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
	if len(input.AddReviewers) > 0 || len(input.RemoveReviewers) > 0 {
		// Bitbucket Cloud's PUT replaces the whole reviewers array; there is no
		// incremental add/remove endpoint to mirror gh/glab's semantics with, so
		// treat this as an explicit unsupported gap rather than guessing at a
		// merge of add/remove against the PR's current reviewer list.
		return UpdateReviewOutput{
			Code:  "unsupported_provider",
			Error: "Update PR failed: incremental reviewer add/remove is not supported for Bitbucket; it only supports replacing the full reviewer list.",
		}
	}
	if len(fields) > 0 {
		if _, err := mutateProviderJSON(ctx, client, http.MethodPut, resourcePath, config.authHeaders(), bitbucketCredentialHint, fields, nil); err != nil {
			result := classifyBitbucketWriteError("Update", err)
			return UpdateReviewOutput{OK: false, Code: result.Code, Error: strings.Replace(result.Error, "Create PR", "Update PR", 1)}
		}
	}

	if input.State == "closed" {
		declinePath := resourcePath + "/decline"
		if _, err := mutateProviderJSON(ctx, client, http.MethodPost, declinePath, config.authHeaders(), bitbucketCredentialHint, nil, nil); err != nil {
			result := classifyBitbucketWriteError("Update", err)
			return UpdateReviewOutput{OK: false, Code: result.Code, Error: strings.Replace(result.Error, "Create PR", "Update PR", 1)}
		}
	} else if input.State == "open" {
		// Bitbucket Cloud has no reopen endpoint for a declined PR (unlike
		// GitHub/GitLab); a declined PR can only be superseded by a new one.
		return UpdateReviewOutput{
			Code:  "unsupported_provider",
			Error: "Update PR failed: Bitbucket Cloud has no API to reopen a declined pull request; create a new one instead.",
		}
	}
	return UpdateReviewOutput{OK: true}
}

func findExistingBitbucketPR(
	ctx context.Context,
	client *http.Client,
	config BitbucketConfig,
	repo *bitbucketRepoRef,
	head string,
) *ReviewSummary {
	query := url.Values{}
	query.Set("pagelen", "1")
	query.Set("sort", "-updated_on")
	query.Set("q", fmt.Sprintf(`source.branch.name = "%s"`, escapeBitbucketQuery(head)))
	for _, s := range bitbucketListStates("all") {
		query.Add("state", s)
	}
	endpoint := fmt.Sprintf(
		"%s/repositories/%s/%s/pullrequests?%s",
		config.APIBaseURL, url.PathEscape(repo.Workspace), url.PathEscape(repo.RepoSlug), query.Encode(),
	)
	var response struct {
		Values []bitbucketPRRaw `json:"values"`
	}
	if err := fetchProviderJSON(ctx, client, endpoint, config.authHeaders(), bitbucketCredentialHint, &response); err != nil || len(response.Values) != 1 {
		return nil
	}
	item := mapBitbucketPR(&response.Values[0])
	return &ReviewSummary{Number: item.Number, URL: item.URL}
}

func escapeBitbucketQuery(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`)
	return replacer.Replace(value)
}

func classifyBitbucketWriteError(action string, err error) CreateReviewOutput {
	code, message := classifyReviewWriteError(action, "Bitbucket", err)
	return CreateReviewOutput{Code: code, Error: message}
}
