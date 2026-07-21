package providercli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

type GitHubProjectLabelsResult struct {
	OK     bool                    `json:"ok"`
	Labels []string                `json:"labels,omitempty"`
	Error  *GitHubProjectViewError `json:"error,omitempty"`
}

type GitHubProjectAssignableUsersResult struct {
	OK    bool                    `json:"ok"`
	Users []GitHubAssignableUser  `json:"users,omitempty"`
	Error *GitHubProjectViewError `json:"error,omitempty"`
}

type GitHubIssueType struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Color       *string `json:"color"`
	Description *string `json:"description"`
}

type GitHubProjectIssueTypesResult struct {
	OK    bool                    `json:"ok"`
	Types []GitHubIssueType       `json:"types,omitempty"`
	Error *GitHubProjectViewError `json:"error,omitempty"`
}

func ListGitHubLabelsBySlug(ctx context.Context, owner, repo string) GitHubProjectLabelsResult {
	if !validGitHubRepoSlug(owner, repo) {
		return GitHubProjectLabelsResult{Error: projectValidationError("Valid owner and repository are required.")}
	}
	out, err := runCLI(ctx, "gh", "", "api", "--paginate", fmt.Sprintf("repos/%s/%s/labels", owner, repo), "--jq", ".[].name")
	if err != nil {
		return GitHubProjectLabelsResult{Error: projectProviderError(err)}
	}
	labels := make([]string, 0)
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			labels = append(labels, line)
		}
	}
	return GitHubProjectLabelsResult{OK: true, Labels: labels}
}

func ListGitHubAssignableUsersBySlug(ctx context.Context, owner, repo string) GitHubProjectAssignableUsersResult {
	if !validGitHubRepoSlug(owner, repo) {
		return GitHubProjectAssignableUsersResult{Error: projectValidationError("Valid owner and repository are required.")}
	}
	out, err := runCLI(ctx, "gh", "", "api", "--paginate", fmt.Sprintf("repos/%s/%s/assignees?per_page=100", owner, repo), "--jq", ".[] | {login, avatar_url}")
	if err != nil {
		return GitHubProjectAssignableUsersResult{Error: projectProviderError(err)}
	}
	users := make([]GitHubAssignableUser, 0)
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		var row struct {
			Login     string `json:"login"`
			AvatarURL string `json:"avatar_url"`
		}
		if json.Unmarshal(scanner.Bytes(), &row) == nil && row.Login != "" {
			users = append(users, GitHubAssignableUser{Login: row.Login, AvatarURL: row.AvatarURL})
		}
	}
	return GitHubProjectAssignableUsersResult{OK: true, Users: users}
}

func ListGitHubIssueTypesBySlug(ctx context.Context, owner, repo string) GitHubProjectIssueTypesResult {
	if !validGitHubRepoSlug(owner, repo) {
		return GitHubProjectIssueTypesResult{Error: projectValidationError("Valid owner and repository are required.")}
	}
	query := `query($owner:String!, $repo:String!) { repository(owner:$owner, name:$repo) { issueTypes(first:100) { nodes { id name color description } } } }`
	out, err := runCLI(ctx, "gh", "", "api", "graphql", "-f", "query="+query, "-f", "owner="+owner, "-f", "repo="+repo)
	if err != nil {
		return GitHubProjectIssueTypesResult{Error: projectProviderError(err)}
	}
	var payload struct {
		Data struct {
			Repository *struct {
				IssueTypes struct {
					Nodes []GitHubIssueType `json:"nodes"`
				} `json:"issueTypes"`
			} `json:"repository"`
		} `json:"data"`
	}
	if json.Unmarshal(out, &payload) != nil || payload.Data.Repository == nil {
		return GitHubProjectIssueTypesResult{Error: &GitHubProjectViewError{Type: "schema_drift", Message: "GitHub issue type response was incomplete."}}
	}
	return GitHubProjectIssueTypesResult{OK: true, Types: payload.Data.Repository.IssueTypes.Nodes}
}

func validGitHubRepoSlug(owner, repo string) bool {
	return githubOwnerPattern.MatchString(owner) && githubOwnerPattern.MatchString(repo)
}

func projectValidationError(message string) *GitHubProjectViewError {
	return &GitHubProjectViewError{Type: "validation_error", Message: message}
}

func projectProviderError(err error) *GitHubProjectViewError {
	errorType := "unknown"
	lower := strings.ToLower(err.Error())
	if strings.Contains(lower, "auth") || strings.Contains(lower, "login") {
		errorType = "auth_required"
	}
	if strings.Contains(lower, "rate limit") {
		errorType = "rate_limited"
	}
	if strings.Contains(lower, "not found") || strings.Contains(lower, "404") {
		errorType = "not_found"
	}
	return &GitHubProjectViewError{Type: errorType, Message: strings.TrimSpace(err.Error())}
}
