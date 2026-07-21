package providercli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
)

type ghIssueRaw struct {
	ID        int         `json:"id"`
	Number    int         `json:"number"`
	Title     string      `json:"title"`
	State     string      `json:"state"`
	URL       string      `json:"url"`
	HTMLURL   string      `json:"html_url"`
	Labels    []ghLabel   `json:"labels"`
	UpdatedAt string      `json:"updated_at"`
	Author    *ghAuthor   `json:"author"`
	User      *ghAPIUser  `json:"user"`
	Pull      *struct{}   `json:"pull_request"`
	Body      string      `json:"body"`
	Assignees []ghAPIUser `json:"assignees"`
}

type ghAPIUser struct {
	Login string `json:"login"`
}

type ghPRAPIRaw struct {
	Number    int        `json:"number"`
	Title     string     `json:"title"`
	State     string     `json:"state"`
	HTMLURL   string     `json:"html_url"`
	URL       string     `json:"url"`
	Labels    []ghLabel  `json:"labels"`
	UpdatedAt string     `json:"updated_at"`
	User      *ghAPIUser `json:"user"`
	Draft     bool       `json:"draft"`
	MergedAt  *string    `json:"merged_at"`
	Body      string     `json:"body"`
	NodeID    string     `json:"node_id"`
	Head      *struct {
		Ref  string `json:"ref"`
		SHA  string `json:"sha"`
		Repo *struct {
			Owner *ghAPIUser `json:"owner"`
		} `json:"repo"`
	} `json:"head"`
	Base *struct {
		Ref string `json:"ref"`
		SHA string `json:"sha"`
	} `json:"base"`
}

func ListGitHubIssues(ctx context.Context, workdir string, limit int) GitHubIssueListResult {
	return ListGitHubIssuesWithPreference(ctx, workdir, limit, "")
}

func ListGitHubIssuesWithPreference(ctx context.Context, workdir string, limit int, preference string) GitHubIssueListResult {
	sources, err := ResolveGitHubWorkItemSources(ctx, workdir, preference)
	if err != nil {
		return GitHubIssueListResult{Items: []GitHubIssueInfo{}, Error: classifyGitHubIssueListError(err)}
	}
	raw, err := fetchGitHubIssueRows(ctx, workdir, sources.Issues.Owner, sources.Issues.Repo, limit, "", "")
	if err != nil {
		return GitHubIssueListResult{Items: []GitHubIssueInfo{}, Error: classifyGitHubIssueListError(err)}
	}
	items := make([]GitHubIssueInfo, 0, len(raw))
	for i := range raw {
		if raw[i].Pull == nil {
			items = append(items, mapGitHubIssueInfo(&raw[i]))
		}
	}
	return GitHubIssueListResult{Items: items}
}

func ListGitHubWorkItems(ctx context.Context, workdir string, limit int, query, before string) (GitHubWorkItemsResult, error) {
	return ListGitHubWorkItemsWithPreference(ctx, workdir, limit, query, before, "")
}

func ListGitHubWorkItemsWithPreference(ctx context.Context, workdir string, limit int, query, before, preference string) (GitHubWorkItemsResult, error) {
	if limit <= 0 {
		limit = 24
	}
	sources, err := ResolveGitHubWorkItemSources(ctx, workdir, preference)
	if err != nil {
		return GitHubWorkItemsResult{}, err
	}
	result := GitHubWorkItemsResult{Sources: sources}
	type sideResult struct {
		items []GitHubWorkItem
		err   error
	}
	issues, prs := sideResult{}, sideResult{}
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		raw, fetchErr := fetchGitHubIssueRows(ctx, workdir, sources.Issues.Owner, sources.Issues.Repo, limit, query, before)
		issues.err = fetchErr
		for i := range raw {
			if raw[i].Pull == nil {
				issues.items = append(issues.items, mapGitHubIssueWorkItem(&raw[i]))
			}
		}
	}()
	go func() {
		defer wait.Done()
		prs.items, prs.err = fetchGitHubPRRows(ctx, workdir, sources.PRs.Owner, sources.PRs.Repo, limit, query, before)
	}()
	wait.Wait()
	if prs.err != nil {
		return GitHubWorkItemsResult{}, prs.err
	}
	if issues.err != nil {
		result.Errors = &GitHubWorkItemErrors{Issues: classifyGitHubIssueListError(issues.err)}
	}
	result.Items = append(issues.items, prs.items...)
	sort.SliceStable(result.Items, func(i, j int) bool { return result.Items[i].UpdatedAt > result.Items[j].UpdatedAt })
	if len(result.Items) > limit {
		result.Items = result.Items[:limit]
	}
	return result, nil
}

func GetGitHubWorkItem(ctx context.Context, workdir string, number int, itemType, owner, repo string) *GitHubWorkItem {
	return GetGitHubWorkItemWithPreference(ctx, workdir, number, itemType, owner, repo, "")
}

func GetGitHubWorkItemWithPreference(ctx context.Context, workdir string, number int, itemType, owner, repo, preference string) *GitHubWorkItem {
	if strings.TrimSpace(owner) == "" || strings.TrimSpace(repo) == "" {
		sources, sourceErr := ResolveGitHubWorkItemSources(ctx, workdir, preference)
		if sourceErr != nil {
			return nil
		}
		owner, repo = sources.Issues.Owner, sources.Issues.Repo
		if itemType == "pr" {
			owner, repo = sources.PRs.Owner, sources.PRs.Repo
		}
	}
	resolvedOwner, resolvedRepo, err := resolveGitHubOwnerRepo(ctx, workdir, owner, repo)
	if err != nil || number < 1 {
		return nil
	}
	if itemType == "issue" || itemType == "" {
		raw, issueErr := readGitHubIssue(ctx, workdir, resolvedOwner, resolvedRepo, number)
		if issueErr == nil && raw.Pull == nil {
			item := mapGitHubIssueWorkItem(&raw)
			return &item
		}
		if itemType == "issue" || (issueErr != nil && !isProviderNotFound(issueErr)) {
			return nil
		}
	}
	if itemType == "pr" || itemType == "" {
		raw, prErr := readGitHubPR(ctx, workdir, resolvedOwner, resolvedRepo, number)
		if prErr == nil {
			item := mapGitHubPRAPI(&raw, resolvedOwner, resolvedRepo)
			return &item
		}
	}
	return nil
}

func ResolveGitHubWorkItemSources(ctx context.Context, workdir, preference string) (GitHubWorkItemSources, error) {
	origin, err := resolveGitHubRemoteOwnerRepo(ctx, workdir, "origin")
	if err != nil {
		owner, repo, fallbackErr := resolveGitHubOwnerRepo(ctx, workdir, "", "")
		if fallbackErr != nil {
			return GitHubWorkItemSources{}, fallbackErr
		}
		origin = &GitHubOwnerRepo{Owner: owner, Repo: repo}
	}
	upstream, _ := resolveGitHubRemoteOwnerRepo(ctx, workdir, "upstream")
	selected := origin
	if strings.TrimSpace(preference) == "upstream" && upstream != nil {
		selected = upstream
	}
	return GitHubWorkItemSources{
		Issues: selected, PRs: selected, OriginCandidate: origin, UpstreamCandidate: upstream,
	}, nil
}

func resolveGitHubRemoteOwnerRepo(ctx context.Context, workdir, remote string) (*GitHubOwnerRepo, error) {
	out, err := runCLI(ctx, "git", workdir, "remote", "get-url", remote)
	if err != nil {
		return nil, err
	}
	owner, repo, ok := parseGitHubRemoteOwnerRepo(strings.TrimSpace(string(out)))
	if !ok {
		return nil, fmt.Errorf("could not parse GitHub %s remote", remote)
	}
	return &GitHubOwnerRepo{Owner: owner, Repo: repo}, nil
}

func parseGitHubRemoteOwnerRepo(raw string) (string, string, bool) {
	value := strings.TrimSuffix(strings.TrimSpace(raw), ".git")
	if marker := strings.Index(value, "://"); marker >= 0 {
		value = value[marker+3:]
		if slash := strings.Index(value, "/"); slash >= 0 {
			value = value[slash+1:]
		}
	} else if colon := strings.Index(value, ":"); colon >= 0 {
		value = value[colon+1:]
	}
	value = strings.Trim(value, "/")
	parts := strings.Split(value, "/")
	if len(parts) < 2 {
		return "", "", false
	}
	owner, repo := parts[len(parts)-2], parts[len(parts)-1]
	return owner, repo, owner != "" && repo != ""
}

func fetchGitHubIssueRows(ctx context.Context, workdir, owner, repo string, limit int, query, before string) ([]ghIssueRaw, error) {
	if limit <= 0 {
		limit = 20
	}
	if strings.TrimSpace(query) == "" && strings.TrimSpace(before) == "" {
		out, err := runCLI(ctx, "gh", workdir, "api", "--cache", "120s", fmt.Sprintf("repos/%s/%s/issues?per_page=%d&state=open&sort=updated&direction=desc", owner, repo, limit))
		if err != nil {
			return nil, err
		}
		var raw []ghIssueRaw
		return raw, json.Unmarshal(out, &raw)
	}
	search := strings.TrimSpace(strings.Join([]string{strings.TrimSpace(query), gitHubBeforeSearch(before)}, " "))
	out, err := runCLI(ctx, "gh", workdir, "issue", "list", "--repo", owner+"/"+repo, "--limit", strconv.Itoa(limit), "--state", "all", "--search", strings.TrimSpace(search), "--json", "number,title,state,url,labels,updatedAt,author")
	if err != nil {
		return nil, err
	}
	var cliRows []ghPRRaw
	if err := json.Unmarshal(out, &cliRows); err != nil {
		return nil, err
	}
	raw := make([]ghIssueRaw, 0, len(cliRows))
	for _, row := range cliRows {
		raw = append(raw, ghIssueRaw{Number: row.Number, Title: row.Title, State: row.State, URL: row.URL, Labels: row.Labels, Author: row.Author, UpdatedAt: row.UpdatedAt})
	}
	return raw, nil
}

func fetchGitHubPRRows(ctx context.Context, workdir, owner, repo string, limit int, query, before string) ([]GitHubWorkItem, error) {
	if strings.TrimSpace(query) == "" && strings.TrimSpace(before) == "" {
		out, err := runCLI(ctx, "gh", workdir, "api", "--cache", "120s", fmt.Sprintf("repos/%s/%s/pulls?per_page=%d&state=open&sort=updated&direction=desc", owner, repo, limit))
		if err != nil {
			return nil, err
		}
		var raw []ghPRAPIRaw
		if err := json.Unmarshal(out, &raw); err != nil {
			return nil, err
		}
		items := make([]GitHubWorkItem, 0, len(raw))
		for i := range raw {
			items = append(items, mapGitHubPRAPI(&raw[i], owner, repo))
		}
		return items, nil
	}
	search := strings.TrimSpace(strings.Join([]string{strings.TrimSpace(query), gitHubBeforeSearch(before)}, " "))
	out, err := runCLI(ctx, "gh", workdir, "pr", "list", "--repo", owner+"/"+repo, "--limit", strconv.Itoa(limit), "--state", "all", "--search", search, "--json", ghPRListFields)
	if err != nil {
		return nil, err
	}
	var raw []ghPRRaw
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, err
	}
	items := make([]GitHubWorkItem, 0, len(raw))
	for i := range raw {
		items = append(items, mapGitHubPR(&raw[i]))
	}
	return items, nil
}

func readGitHubIssue(ctx context.Context, workdir, owner, repo string, number int) (ghIssueRaw, error) {
	out, err := runCLI(ctx, "gh", workdir, "api", "--cache", "300s", fmt.Sprintf("repos/%s/%s/issues/%d", owner, repo, number))
	var raw ghIssueRaw
	if err == nil {
		err = json.Unmarshal(out, &raw)
	}
	return raw, err
}

func readGitHubPR(ctx context.Context, workdir, owner, repo string, number int) (ghPRAPIRaw, error) {
	out, err := runCLI(ctx, "gh", workdir, "api", "--cache", "300s", fmt.Sprintf("repos/%s/%s/pulls/%d", owner, repo, number))
	var raw ghPRAPIRaw
	if err == nil {
		err = json.Unmarshal(out, &raw)
	}
	return raw, err
}

func mapGitHubIssueInfo(raw *ghIssueRaw) GitHubIssueInfo {
	return GitHubIssueInfo{Number: raw.Number, Title: raw.Title, State: mapGitHubIssueState(raw.State), URL: firstNonEmpty(raw.HTMLURL, raw.URL), Labels: githubLabelNames(raw.Labels)}
}

func mapGitHubIssueWorkItem(raw *ghIssueRaw) GitHubWorkItem {
	return GitHubWorkItem{ID: "issue:" + strconv.Itoa(raw.Number), Type: "issue", Number: raw.Number, Title: raw.Title, State: mapGitHubIssueState(raw.State), URL: firstNonEmpty(raw.HTMLURL, raw.URL), Labels: githubLabelNames(raw.Labels), UpdatedAt: raw.UpdatedAt, Author: githubIssueAuthor(raw)}
}

func mapGitHubPRAPI(raw *ghPRAPIRaw, owner, repo string) GitHubWorkItem {
	state := strings.ToLower(raw.State)
	if raw.MergedAt != nil {
		state = "merged"
	} else if raw.Draft {
		state = "draft"
	}
	item := GitHubWorkItem{ID: "pr:" + strconv.Itoa(raw.Number), Type: "pr", Number: raw.Number, Title: raw.Title, State: state, URL: firstNonEmpty(raw.HTMLURL, raw.URL), Labels: githubLabelNames(raw.Labels), UpdatedAt: raw.UpdatedAt, Author: nil}
	if raw.User != nil && raw.User.Login != "" {
		login := raw.User.Login
		item.Author = &login
	}
	if raw.Head != nil {
		item.BranchName, item.HeadSha = raw.Head.Ref, raw.Head.SHA
		if raw.Head.Repo != nil && raw.Head.Repo.Owner != nil {
			cross := !strings.EqualFold(raw.Head.Repo.Owner.Login, owner)
			item.IsCrossRepository = &cross
		}
	}
	if raw.Base != nil {
		item.BaseRefName = raw.Base.Ref
	}
	return item
}

func githubLabelNames(labels []ghLabel) []string {
	names := make([]string, 0, len(labels))
	for _, label := range labels {
		if label.Name != "" {
			names = append(names, label.Name)
		}
	}
	return names
}
func githubIssueAuthor(raw *ghIssueRaw) *string {
	if raw.User != nil && raw.User.Login != "" {
		value := raw.User.Login
		return &value
	}
	if raw.Author != nil {
		return ghAuthorLogin(raw.Author)
	}
	return nil
}
func mapGitHubIssueState(state string) string {
	if strings.EqualFold(state, "open") {
		return "open"
	}
	return "closed"
}
func gitHubBeforeSearch(before string) string {
	if strings.TrimSpace(before) == "" {
		return ""
	}
	return "updated:<" + strings.TrimSpace(before)
}
func isProviderNotFound(err error) bool {
	lower := strings.ToLower(err.Error())
	return strings.Contains(lower, "http 404") || strings.Contains(lower, "not found")
}

func classifyGitHubIssueListError(err error) *ProviderClassifiedError {
	message := strings.TrimSpace(err.Error())
	lower := strings.ToLower(message)
	switch {
	case errors.Is(err, ErrCLIUnauthenticated), strings.Contains(lower, "http 403"), strings.Contains(lower, "forbidden"):
		return &ProviderClassifiedError{Type: "permission_denied", Message: "You don't have permission to read issues for this repository. Check your GitHub token scopes."}
	case isProviderNotFound(err):
		return &ProviderClassifiedError{Type: "not_found", Message: "Repository not found."}
	case strings.Contains(lower, "rate limit"), strings.Contains(lower, "http 429"):
		return &ProviderClassifiedError{Type: "rate_limited", Message: "GitHub rate limit hit. Try again in a few minutes."}
	case errors.Is(err, context.DeadlineExceeded), strings.Contains(lower, "timeout"), strings.Contains(lower, "network"), strings.Contains(lower, "could not resolve host"):
		return &ProviderClassifiedError{Type: "network_error", Message: "Network error — check your connection."}
	default:
		return &ProviderClassifiedError{Type: "unknown", Message: "Failed to load issues: " + message}
	}
}
