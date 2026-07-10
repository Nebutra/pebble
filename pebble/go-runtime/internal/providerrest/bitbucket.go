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
