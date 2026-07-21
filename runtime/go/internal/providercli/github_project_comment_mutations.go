package providercli

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

type GitHubProjectCommentMutationResult struct {
	OK      bool                    `json:"ok"`
	Comment *ReviewComment          `json:"comment,omitempty"`
	Error   *GitHubProjectViewError `json:"error,omitempty"`
}

type GitHubProjectMutationResult struct {
	OK    bool                    `json:"ok"`
	Error *GitHubProjectViewError `json:"error,omitempty"`
}

type GitHubProjectPullRequestUpdate struct {
	Title *string `json:"title,omitempty"`
	Body  *string `json:"body,omitempty"`
	State string  `json:"state,omitempty"`
}

func UpdateGitHubPullRequestBySlug(ctx context.Context, owner, repo string, number int, update GitHubProjectPullRequestUpdate) GitHubProjectMutationResult {
	if !validGitHubRepoSlug(owner, repo) || number < 1 {
		return GitHubProjectMutationResult{Error: projectValidationError("Valid repository and pull request number are required.")}
	}
	if update.State != "" && update.State != "open" && update.State != "closed" {
		return GitHubProjectMutationResult{Error: projectValidationError("Pull request state must be open or closed.")}
	}
	args := []string{"api", "-X", "PATCH", fmt.Sprintf("repos/%s/%s/pulls/%d", owner, repo, number)}
	if update.Title != nil {
		args = append(args, "--raw-field", "title="+*update.Title)
	}
	if update.Body != nil {
		args = append(args, "--raw-field", "body="+*update.Body)
	}
	if update.State != "" {
		args = append(args, "--raw-field", "state="+update.State)
	}
	if len(args) == 4 {
		return GitHubProjectMutationResult{OK: true}
	}
	if _, err := runCLI(ctx, "gh", "", args...); err != nil {
		return GitHubProjectMutationResult{Error: projectProviderError(err)}
	}
	return GitHubProjectMutationResult{OK: true}
}

func AddGitHubIssueCommentBySlug(ctx context.Context, owner, repo string, number int, body string) GitHubProjectCommentMutationResult {
	if !validGitHubRepoSlug(owner, repo) || number < 1 || strings.TrimSpace(body) == "" {
		return GitHubProjectCommentMutationResult{Error: projectValidationError("Valid repository, issue number, and comment body are required.")}
	}
	result := AddGitHubReviewComment(ctx, "", AddReviewCommentRequest{Provider: "github", Number: number, Body: body, Owner: owner, Repo: repo})
	if !result.OK {
		return GitHubProjectCommentMutationResult{Error: &GitHubProjectViewError{Type: "unknown", Message: result.Error}}
	}
	return GitHubProjectCommentMutationResult{OK: true, Comment: result.Comment}
}

func UpdateGitHubIssueCommentBySlug(ctx context.Context, owner, repo string, commentID int, body string) GitHubProjectMutationResult {
	if !validGitHubRepoSlug(owner, repo) || commentID < 1 || strings.TrimSpace(body) == "" {
		return GitHubProjectMutationResult{Error: projectValidationError("Valid repository, comment ID, and body are required.")}
	}
	_, err := runCLI(ctx, "gh", "", "api", "-X", "PATCH", fmt.Sprintf("repos/%s/%s/issues/comments/%d", owner, repo, commentID), "--raw-field", "body="+body)
	if err != nil {
		return GitHubProjectMutationResult{Error: projectProviderError(err)}
	}
	return GitHubProjectMutationResult{OK: true}
}

func DeleteGitHubIssueCommentBySlug(ctx context.Context, owner, repo string, commentID int) GitHubProjectMutationResult {
	if !validGitHubRepoSlug(owner, repo) || commentID < 1 {
		return GitHubProjectMutationResult{Error: projectValidationError("Valid repository and comment ID are required.")}
	}
	out, err := runCLI(ctx, "gh", "", "api", "-X", "DELETE", fmt.Sprintf("repos/%s/%s/issues/comments/%d", owner, repo, commentID))
	if err != nil {
		return GitHubProjectMutationResult{Error: projectProviderError(err)}
	}
	if len(strings.TrimSpace(string(out))) > 0 {
		var ignored interface{}
		_ = json.Unmarshal(out, &ignored)
	}
	return GitHubProjectMutationResult{OK: true}
}
