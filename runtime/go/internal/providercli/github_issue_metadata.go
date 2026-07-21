package providercli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

const githubWorkItemsQueryMaxBytes = 8 * 1024

func CreateGitHubIssue(ctx context.Context, workdir, title, body string, labels, assignees []string, preference string) GitHubIssueCreateResult {
	title = strings.TrimSpace(title)
	if title == "" {
		return GitHubIssueCreateResult{Error: "Title is required"}
	}
	sources, err := ResolveGitHubWorkItemSources(ctx, workdir, preference)
	if err != nil || sources.Issues == nil {
		return GitHubIssueCreateResult{Error: "Could not resolve GitHub owner/repo for this repository"}
	}
	args := []string{"api", "-X", "POST", fmt.Sprintf("repos/%s/%s/issues", sources.Issues.Owner, sources.Issues.Repo), "--raw-field", "title=" + title, "--raw-field", "body=" + body}
	for _, label := range labels {
		if label = strings.TrimSpace(label); label != "" {
			args = append(args, "--raw-field", "labels[]="+label)
		}
	}
	for _, assignee := range assignees {
		if assignee = strings.TrimSpace(assignee); assignee != "" {
			args = append(args, "--raw-field", "assignees[]="+assignee)
		}
	}
	out, err := runCLI(ctx, "gh", workdir, args...)
	if err != nil {
		return GitHubIssueCreateResult{Error: strings.TrimSpace(err.Error())}
	}
	var payload struct {
		Number  int    `json:"number"`
		HTMLURL string `json:"html_url"`
		URL     string `json:"url"`
	}
	if json.Unmarshal(out, &payload) != nil || payload.Number < 1 {
		return GitHubIssueCreateResult{Error: "Unexpected response from GitHub"}
	}
	return GitHubIssueCreateResult{OK: true, Number: payload.Number, URL: firstNonEmpty(payload.HTMLURL, payload.URL)}
}

func CountGitHubWorkItems(ctx context.Context, workdir, query, preference string) int {
	query = strings.TrimSpace(query)
	if len([]byte(query)) > githubWorkItemsQueryMaxBytes {
		return 0
	}
	sources, err := ResolveGitHubWorkItemSources(ctx, workdir, preference)
	if err != nil || sources.Issues == nil {
		return 0
	}
	if query == "" {
		query = "is:open"
	}
	search := fmt.Sprintf("repo:%s/%s %s", sources.Issues.Owner, sources.Issues.Repo, query)
	out, err := runCLI(ctx, "gh", workdir, "api", "--cache", "120s", "search/issues", "-f", "q="+search, "--jq", ".total_count")
	if err != nil {
		return 0
	}
	count, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	return count
}

func ListGitHubLabels(ctx context.Context, workdir, preference string) []string {
	sources, err := ResolveGitHubWorkItemSources(ctx, workdir, preference)
	if err != nil || sources.Issues == nil {
		return []string{}
	}
	out, err := runCLI(ctx, "gh", workdir, "api", "--paginate", fmt.Sprintf("repos/%s/%s/labels", sources.Issues.Owner, sources.Issues.Repo), "--jq", ".[].name")
	if err != nil {
		return []string{}
	}
	labels := make([]string, 0)
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if label := strings.TrimSpace(line); label != "" {
			labels = append(labels, label)
		}
	}
	return labels
}

func ListGitHubAssignableUsers(ctx context.Context, workdir, preference string) []GitHubAssignableUser {
	sources, err := ResolveGitHubWorkItemSources(ctx, workdir, preference)
	if err != nil || sources.Issues == nil {
		return []GitHubAssignableUser{}
	}
	out, err := runCLI(ctx, "gh", workdir, "api", "--paginate", fmt.Sprintf("repos/%s/%s/assignees?per_page=100", sources.Issues.Owner, sources.Issues.Repo), "--jq", ".[] | {login, avatar_url}")
	if err != nil {
		return []GitHubAssignableUser{}
	}
	users := make([]GitHubAssignableUser, 0)
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		var row struct {
			Login     string `json:"login"`
			AvatarURL string `json:"avatar_url"`
		}
		if json.Unmarshal(scanner.Bytes(), &row) == nil && strings.TrimSpace(row.Login) != "" {
			users = append(users, GitHubAssignableUser{Login: row.Login, AvatarURL: row.AvatarURL})
		}
	}
	return users
}
