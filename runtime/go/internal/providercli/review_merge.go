package providercli

import (
	"context"
	"strconv"
)

type MergeReviewRequest struct {
	Provider string `json:"provider"`
	Number   int    `json:"number"`
	Method   string `json:"method"`
}

func MergeGitHubPullRequest(ctx context.Context, workdir string, input MergeReviewRequest) UpdateReviewResult {
	if result := validateMergeReview(input, "PR"); result != nil {
		return *result
	}
	if _, err := runCLI(ctx, "gh", workdir, "pr", "merge", strconv.Itoa(input.Number), "--"+input.Method); err != nil {
		return classifyUpdateReviewError("PR", "GitHub", err)
	}
	return UpdateReviewResult{OK: true}
}

func MergeGitLabMergeRequest(ctx context.Context, workdir string, input MergeReviewRequest) UpdateReviewResult {
	if result := validateMergeReview(input, "MR"); result != nil {
		return *result
	}
	args := []string{"mr", "merge", strconv.Itoa(input.Number), "--yes"}
	if input.Method == "squash" {
		args = append(args, "--squash")
	} else if input.Method == "rebase" {
		args = append(args, "--rebase")
	}
	if _, err := runCLI(ctx, "glab", workdir, args...); err != nil {
		return classifyUpdateReviewError("MR", "GitLab", err)
	}
	return UpdateReviewResult{OK: true}
}

func validateMergeReview(input MergeReviewRequest, label string) *UpdateReviewResult {
	if input.Number <= 0 {
		return &UpdateReviewResult{Code: "validation", Error: "Merge " + label + " failed: a review number is required."}
	}
	if input.Method != "merge" && input.Method != "squash" && input.Method != "rebase" {
		return &UpdateReviewResult{Code: "validation", Error: "Merge " + label + " failed: method must be merge, squash, or rebase."}
	}
	return nil
}
