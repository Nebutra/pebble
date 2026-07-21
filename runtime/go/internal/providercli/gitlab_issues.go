package providercli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
)

type glabIssueRaw struct {
	ID          int         `json:"id"`
	IID         int         `json:"iid"`
	Number      int         `json:"number"`
	Title       string      `json:"title"`
	State       string      `json:"state"`
	WebURL      string      `json:"web_url"`
	URL         string      `json:"url"`
	UpdatedAt   string      `json:"updated_at"`
	Description *string     `json:"description"`
	Author      *glabUser   `json:"author"`
	Labels      []glabLabel `json:"labels"`
	Assignees   []glabUser  `json:"assignees"`
}

func ListGitLabIssues(ctx context.Context, workdir, state, assignee string, limit int) GitLabIssueListResult {
	project, err := resolveGitLabProjectRef(ctx, workdir, nil)
	if err != nil {
		return GitLabIssueListResult{Items: []GitLabIssueInfo{}, Error: classifyGitLabIssueListError(err)}
	}
	raw, err := fetchGitLabIssues(ctx, workdir, project, state, assignee, 1, limit, "")
	if err != nil {
		return GitLabIssueListResult{Items: []GitLabIssueInfo{}, Error: classifyGitLabIssueListError(err)}
	}
	items := make([]GitLabIssueInfo, 0, len(raw))
	for i := range raw {
		items = append(items, mapGitLabIssueInfo(&raw[i]))
	}
	return GitLabIssueListResult{Items: items}
}

// ListGitLabWorkItems mirrors Electron's partial-success contract: MR and issue
// reads run concurrently, and one healthy side remains visible if the other fails.
func ListGitLabWorkItems(ctx context.Context, workdir, state string, page, perPage int, query string) GitLabWorkItemsResult {
	project, err := resolveGitLabProjectRef(ctx, workdir, nil)
	if err != nil {
		return GitLabWorkItemsResult{Items: []GitLabWorkItem{}, Error: classifyGitLabIssueListError(err)}
	}
	if page <= 0 {
		page = 1
	}
	if perPage <= 0 {
		perPage = 20
	}
	type itemResult struct {
		items []GitLabWorkItem
		err   error
	}
	mrResult := itemResult{}
	issueResult := itemResult{}
	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		mrResult.items, mrResult.err = ListGitLabMRs(ctx, workdir, state, perPage, query)
		for i := range mrResult.items {
			ref := project
			mrResult.items[i].ProjectRef = &ref
		}
	}()
	if state != "merged" {
		wait.Add(1)
		go func() {
			defer wait.Done()
			raw, fetchErr := fetchGitLabIssues(ctx, workdir, project, gitLabIssueFilterState(state), "", page, perPage, query)
			issueResult.err = fetchErr
			if fetchErr != nil {
				return
			}
			issueResult.items = make([]GitLabWorkItem, 0, len(raw))
			for i := range raw {
				issueResult.items = append(issueResult.items, mapGitLabIssueWorkItem(&raw[i], project))
			}
		}()
	}
	wait.Wait()
	items := append(mrResult.items, issueResult.items...)
	sort.SliceStable(items, func(i, j int) bool { return items[i].UpdatedAt > items[j].UpdatedAt })
	result := GitLabWorkItemsResult{Items: items}
	if mrResult.err != nil {
		result.Error = classifyGitLabIssueListError(mrResult.err)
	} else if issueResult.err != nil {
		result.Error = classifyGitLabIssueListError(issueResult.err)
	}
	return result
}

func fetchGitLabIssues(ctx context.Context, workdir string, project GitLabProjectRef, state, assignee string, page, perPage int, query string) ([]glabIssueRaw, error) {
	if page <= 0 {
		page = 1
	}
	if perPage <= 0 {
		perPage = 20
	}
	params := url.Values{}
	params.Set("page", strconv.Itoa(page))
	params.Set("per_page", strconv.Itoa(perPage))
	params.Set("order_by", "updated_at")
	params.Set("sort", "desc")
	if state != "" && state != "all" {
		params.Set("state", state)
	}
	if assignee == "@me" {
		params.Set("scope", "assigned_to_me")
	}
	if strings.TrimSpace(query) != "" {
		params.Set("search", strings.TrimSpace(query))
	}
	args := []string{"api"}
	if project.Host != "" && project.Host != "gitlab.com" {
		args = append(args, "--hostname", project.Host)
	}
	resource := fmt.Sprintf("projects/%s/issues?%s", encodeGitLabProjectPath(project.Path), params.Encode())
	out, err := runCLI(ctx, "glab", workdir, append(args, resource)...)
	if err != nil {
		return nil, err
	}
	var raw []glabIssueRaw
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, fmt.Errorf("parse glab issue list output: %w", err)
	}
	return raw, nil
}

func mapGitLabIssueInfo(raw *glabIssueRaw) GitLabIssueInfo {
	labels := glabLabelNames(raw.Labels)
	number := raw.IID
	if number == 0 {
		number = raw.Number
	}
	return GitLabIssueInfo{
		Number: number, Title: raw.Title, State: gitLabIssueState(raw.State), URL: firstNonEmpty(raw.WebURL, raw.URL),
		Labels: labels, UpdatedAt: raw.UpdatedAt, Description: raw.Description,
		Author: glabAuthorUsername(raw.Author), AuthorAvatarURL: glabAuthorAvatar(raw.Author),
	}
}

func mapGitLabIssueWorkItem(raw *glabIssueRaw, project GitLabProjectRef) GitLabWorkItem {
	idPart := strconv.Itoa(raw.ID)
	if raw.ID == 0 {
		idPart = project.Path + "-" + strconv.Itoa(raw.IID)
	}
	ref := project
	return GitLabWorkItem{
		ID: "gitlab-issue-" + idPart, Type: "issue", Number: raw.IID, Title: raw.Title,
		State: gitLabIssueState(raw.State), URL: firstNonEmpty(raw.WebURL, raw.URL), Labels: glabLabelNames(raw.Labels),
		UpdatedAt: raw.UpdatedAt, Author: glabAuthorUsername(raw.Author), ProjectRef: &ref,
	}
}

func glabLabelNames(labels []glabLabel) []string {
	names := make([]string, 0, len(labels))
	for _, label := range labels {
		if label.Name != "" {
			names = append(names, label.Name)
		}
	}
	return names
}

func gitLabIssueState(state string) string {
	if strings.EqualFold(state, "opened") {
		return "opened"
	}
	return "closed"
}

func gitLabIssueFilterState(state string) string {
	switch state {
	case "closed", "all":
		return state
	default:
		return "opened"
	}
}

func classifyGitLabIssueListError(err error) *ProviderClassifiedError {
	message := strings.TrimSpace(err.Error())
	lower := strings.ToLower(message)
	switch {
	case errors.Is(err, ErrCLIUnauthenticated), strings.Contains(lower, "http 403"), strings.Contains(lower, "forbidden"), strings.Contains(lower, "insufficient_scope"):
		return &ProviderClassifiedError{Type: "permission_denied", Message: "You don't have permission to read issues for this project. Check your GitLab token scopes."}
	case strings.Contains(lower, "http 404"), strings.Contains(lower, "project not found"), strings.Contains(lower, "could not resolve gitlab project"):
		return &ProviderClassifiedError{Type: "not_found", Message: "Project not found."}
	case strings.Contains(lower, "rate limit"), strings.Contains(lower, "http 429"):
		return &ProviderClassifiedError{Type: "rate_limited", Message: "GitLab rate limit hit. Try again in a few minutes."}
	case errors.Is(err, context.DeadlineExceeded), strings.Contains(lower, "timeout"), strings.Contains(lower, "no such host"), strings.Contains(lower, "network"), strings.Contains(lower, "could not resolve host"):
		return &ProviderClassifiedError{Type: "network_error", Message: "Network error — check your connection."}
	default:
		return &ProviderClassifiedError{Type: "unknown", Message: "Failed to load issues: " + message}
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func glabAuthorAvatar(user *glabUser) *string {
	if user == nil || user.AvatarURL == "" {
		return nil
	}
	avatar := user.AvatarURL
	return &avatar
}
