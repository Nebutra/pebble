package providercli

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

type GitHubIssueUpdate struct {
	State           string   `json:"state,omitempty"`
	StateReason     string   `json:"stateReason,omitempty"`
	DuplicateOf     int      `json:"duplicateOf,omitempty"`
	Title           *string  `json:"title,omitempty"`
	Body            *string  `json:"body,omitempty"`
	AddLabels       []string `json:"addLabels,omitempty"`
	RemoveLabels    []string `json:"removeLabels,omitempty"`
	AddAssignees    []string `json:"addAssignees,omitempty"`
	RemoveAssignees []string `json:"removeAssignees,omitempty"`
}

type GitHubIssueMutationResult struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

func UpdateGitHubIssue(ctx context.Context, workdir string, number int, update GitHubIssueUpdate) GitHubIssueMutationResult {
	if number < 1 {
		return GitHubIssueMutationResult{Error: "A positive issue number is required"}
	}
	// Why: mutations remain on origin instead of following the live list preference;
	// changing that preference must never redirect an already-open issue edit.
	sources, err := ResolveGitHubWorkItemSources(ctx, workdir, "origin")
	if err != nil || sources.OriginCandidate == nil {
		return GitHubIssueMutationResult{Error: "Could not resolve GitHub owner/repo for this repository"}
	}
	source := *sources.OriginCandidate
	return updateGitHubIssueAtSource(ctx, workdir, source, number, update)
}

func UpdateGitHubIssueBySlug(ctx context.Context, owner, repo string, number int, update GitHubIssueUpdate) GitHubIssueMutationResult {
	if !validGitHubRepoSlug(owner, repo) {
		return GitHubIssueMutationResult{Error: "Valid GitHub owner/repository are required"}
	}
	return updateGitHubIssueAtSource(ctx, "", GitHubOwnerRepo{Owner: owner, Repo: repo}, number, update)
}

func updateGitHubIssueAtSource(ctx context.Context, workdir string, source GitHubOwnerRepo, number int, update GitHubIssueUpdate) GitHubIssueMutationResult {
	if number < 1 {
		return GitHubIssueMutationResult{Error: "A positive issue number is required"}
	}
	if update.DuplicateOf > 0 && (update.State != "closed" || update.StateReason != "duplicate") {
		return GitHubIssueMutationResult{Error: "Duplicate target is only valid when closing as duplicate"}
	}
	if update.State == "closed" && update.StateReason == "duplicate" && update.DuplicateOf < 1 {
		return GitHubIssueMutationResult{Error: "Duplicate target issue number is required"}
	}
	errors := make([]string, 0, 3)
	if update.State != "" {
		args := githubIssueStateArgs(source, number, update)
		if _, runErr := runCLI(ctx, "gh", workdir, args...); runErr != nil && !strings.Contains(strings.ToLower(runErr.Error()), "already") {
			errors = append(errors, strings.TrimSpace(runErr.Error()))
		}
	}
	if update.Body != nil {
		_, runErr := runCLI(ctx, "gh", workdir, "api", "-X", "PATCH", fmt.Sprintf("repos/%s/%s/issues/%d", source.Owner, source.Repo, number), "--raw-field", "body="+*update.Body)
		if runErr != nil {
			errors = append(errors, strings.TrimSpace(runErr.Error()))
		}
	}
	if args := githubIssueEditArgs(source, number, update); len(args) > 5 {
		if _, runErr := runCLI(ctx, "gh", workdir, args...); runErr != nil {
			errors = append(errors, strings.TrimSpace(runErr.Error()))
		}
	}
	if len(errors) > 0 {
		return GitHubIssueMutationResult{Error: strings.Join(errors, "; ")}
	}
	return GitHubIssueMutationResult{OK: true}
}

func githubIssueStateArgs(source GitHubOwnerRepo, number int, update GitHubIssueUpdate) []string {
	repo := source.Owner + "/" + source.Repo
	if update.State == "open" {
		return []string{"issue", "reopen", strconv.Itoa(number), "--repo", repo}
	}
	args := []string{"issue", "close", strconv.Itoa(number), "--repo", repo}
	switch update.StateReason {
	case "completed":
		args = append(args, "--reason", "completed")
	case "not_planned":
		args = append(args, "--reason", "not planned")
	case "duplicate":
		if update.DuplicateOf > 0 {
			args = append(args, "--duplicate-of", strconv.Itoa(update.DuplicateOf))
		}
	}
	return args
}

func githubIssueEditArgs(source GitHubOwnerRepo, number int, update GitHubIssueUpdate) []string {
	args := []string{"issue", "edit", strconv.Itoa(number), "--repo", source.Owner + "/" + source.Repo}
	if update.Title != nil {
		args = append(args, "--title", *update.Title)
	}
	for _, value := range update.AddLabels {
		args = append(args, "--add-label", value)
	}
	for _, value := range update.RemoveLabels {
		args = append(args, "--remove-label", value)
	}
	for _, value := range update.AddAssignees {
		args = append(args, "--add-assignee", value)
	}
	for _, value := range update.RemoveAssignees {
		args = append(args, "--remove-assignee", value)
	}
	return args
}
