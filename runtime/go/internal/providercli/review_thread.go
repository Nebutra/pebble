package providercli

import (
	"context"
	"net/url"
	"strconv"
	"strings"
)

type ResolveReviewThreadRequest struct {
	Provider string `json:"provider"`
	Number   int    `json:"number"`
	ThreadID string `json:"threadId"`
	Resolved bool   `json:"resolved"`
}

type SetReviewFileViewedRequest struct {
	PullRequestID string `json:"pullRequestId"`
	Path          string `json:"path"`
	Viewed        bool   `json:"viewed"`
}

func SetGitHubReviewFileViewed(ctx context.Context, workdir string, input SetReviewFileViewedRequest) UpdateReviewResult {
	pullRequestID := strings.TrimSpace(input.PullRequestID)
	path := strings.TrimSpace(input.Path)
	if pullRequestID == "" || path == "" {
		return UpdateReviewResult{Code: "validation", Error: "Set PR file viewed failed: pull request ID and path are required."}
	}
	mutation := "unmarkFileAsViewed"
	if input.Viewed {
		mutation = "markFileAsViewed"
	}
	query := "mutation($pullRequestId: ID!, $path: String!) { " + mutation + "(input: { pullRequestId: $pullRequestId, path: $path }) { pullRequest { id } } }"
	if _, err := runCLI(ctx, "gh", workdir, "api", "graphql", "-f", "query="+query, "-f", "pullRequestId="+pullRequestID, "-f", "path="+path); err != nil {
		return classifyUpdateReviewError("review file", "GitHub", err)
	}
	return UpdateReviewResult{OK: true}
}

func ResolveGitHubReviewThread(ctx context.Context, workdir string, input ResolveReviewThreadRequest) UpdateReviewResult {
	threadID := strings.TrimSpace(input.ThreadID)
	if threadID == "" {
		return UpdateReviewResult{Code: "validation", Error: "Resolve PR review thread failed: thread ID is required."}
	}
	mutation := "unresolveReviewThread"
	if input.Resolved {
		mutation = "resolveReviewThread"
	}
	query := "mutation($threadId: ID!) { " + mutation + "(input: { threadId: $threadId }) { thread { isResolved } } }"
	if _, err := runCLI(ctx, "gh", workdir, "api", "graphql", "-f", "query="+query, "-f", "threadId="+threadID); err != nil {
		return classifyUpdateReviewError("review thread", "GitHub", err)
	}
	return UpdateReviewResult{OK: true}
}

func ResolveGitLabReviewThread(ctx context.Context, workdir string, input ResolveReviewThreadRequest) UpdateReviewResult {
	threadID := strings.TrimSpace(input.ThreadID)
	if input.Number <= 0 || threadID == "" {
		return UpdateReviewResult{Code: "validation", Error: "Resolve MR discussion failed: MR number and discussion ID are required."}
	}
	if _, err := runCLI(ctx, "glab", workdir, "api", "-X", "PUT", "projects/:id/merge_requests/"+strconv.Itoa(input.Number)+"/discussions/"+url.PathEscape(threadID), "-f", "resolved="+strconv.FormatBool(input.Resolved)); err != nil {
		return classifyUpdateReviewError("discussion", "GitLab", err)
	}
	return UpdateReviewResult{OK: true}
}
