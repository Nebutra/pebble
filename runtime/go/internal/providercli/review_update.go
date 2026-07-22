package providercli

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
)

// UpdateReviewRequest carries provider-backed post-creation mutations: edits,
// reviewer mutations, close/reopen, base retargets, and draft/ready transitions.
// Provider-specific functions below keep the gh and glab semantics explicit.
type UpdateReviewRequest struct {
	Provider        string   `json:"provider"`
	Number          int      `json:"number"`
	Owner           string   `json:"owner,omitempty"`
	Repo            string   `json:"repo,omitempty"`
	Title           *string  `json:"title,omitempty"`
	Body            *string  `json:"body,omitempty"`
	Base            *string  `json:"base,omitempty"`
	Draft           *bool    `json:"draft,omitempty"`
	State           string   `json:"state,omitempty"` // "open" | "closed"
	AddReviewers    []string `json:"addReviewers,omitempty"`
	RemoveReviewers []string `json:"removeReviewers,omitempty"`
	ReviewerIDs     *[]int   `json:"reviewerIds,omitempty"`
}

type GitLabReviewer struct {
	ID        int     `json:"id,omitempty"`
	Username  string  `json:"username"`
	Name      *string `json:"name,omitempty"`
	AvatarURL string  `json:"avatarUrl"`
	State     string  `json:"state,omitempty"`
}

type UpdateReviewResult struct {
	OK        bool             `json:"ok"`
	Code      string           `json:"code,omitempty"`
	Error     string           `json:"error,omitempty"`
	Reviewers []GitLabReviewer `json:"reviewers,omitempty"`
}

// UpdateGitHubPullRequest updates details, state, and reviewers using gh's `pr edit`/`pr close`/
// `pr reopen` subcommands instead of raw REST calls, since gh already exposes
// realistic subcommands for these operations.
func UpdateGitHubPullRequest(ctx context.Context, workdir string, input UpdateReviewRequest) UpdateReviewResult {
	if input.Number <= 0 {
		return UpdateReviewResult{Code: "validation", Error: "Update PR failed: a pull request number is required."}
	}
	number := strconv.Itoa(input.Number)
	owner, repo := strings.TrimSpace(input.Owner), strings.TrimSpace(input.Repo)
	if (owner == "") != (repo == "") {
		return UpdateReviewResult{Code: "validation", Error: "Update PR failed: both repository owner and name are required."}
	}
	repoArgs := []string{}
	if owner != "" {
		// Why: fork PR numbers belong to the upstream repository, not necessarily
		// the origin remote in the selected worktree.
		repoArgs = []string{"--repo", owner + "/" + repo}
	}

	editArgs := []string{"pr", "edit", number}
	if input.Title != nil {
		title := strings.TrimSpace(*input.Title)
		if title == "" {
			return UpdateReviewResult{Code: "validation", Error: "Update PR failed: title cannot be empty."}
		}
		editArgs = append(editArgs, "--title", title)
	}
	if input.Body != nil {
		editArgs = append(editArgs, "--body", *input.Body)
	}
	if input.Base != nil {
		base := strings.TrimSpace(*input.Base)
		if base == "" {
			return UpdateReviewResult{Code: "validation", Error: "Update PR failed: base branch cannot be empty."}
		}
		editArgs = append(editArgs, "--base", base)
	}
	if logins := normalizeReviewerLogins(input.AddReviewers); len(logins) > 0 {
		editArgs = append(editArgs, "--add-reviewer", strings.Join(logins, ","))
	}
	if logins := normalizeReviewerLogins(input.RemoveReviewers); len(logins) > 0 {
		editArgs = append(editArgs, "--remove-reviewer", strings.Join(logins, ","))
	}
	if len(editArgs) > 3 {
		editArgs = append(editArgs, repoArgs...)
		if _, err := runCLI(ctx, "gh", workdir, editArgs...); err != nil {
			return classifyUpdateReviewError("PR", "GitHub", err)
		}
	}

	if input.State != "" {
		cmd, ok := githubStateCommand(input.State)
		if !ok {
			return UpdateReviewResult{Code: "validation", Error: "Update PR failed: state must be \"open\" or \"closed\"."}
		}
		if cmd != "" {
			args := append([]string{"pr", cmd, number}, repoArgs...)
			if _, err := runCLI(ctx, "gh", workdir, args...); err != nil {
				return classifyUpdateReviewError("PR", "GitHub", err)
			}
		}
	}
	if input.Draft != nil {
		args := []string{"pr", "ready", number}
		if *input.Draft {
			args = append(args, "--undo")
		}
		args = append(args, repoArgs...)
		_, err := runCLI(ctx, "gh", workdir, args...)
		if err != nil && !strings.Contains(strings.ToLower(err.Error()), "already") {
			return classifyUpdateReviewError("PR", "GitHub", err)
		}
	}
	return UpdateReviewResult{OK: true}
}

// UpdateGitLabMergeRequest updates title/body with `glab api PUT`; close/reopen
// use glab's dedicated subcommands.
func UpdateGitLabMergeRequest(ctx context.Context, workdir string, input UpdateReviewRequest) UpdateReviewResult {
	if input.Number <= 0 {
		return UpdateReviewResult{Code: "validation", Error: "Update MR failed: a merge request number is required."}
	}
	iid := strconv.Itoa(input.Number)
	var updatedReviewers []GitLabReviewer
	base := ""
	if input.Base != nil {
		base = strings.TrimSpace(*input.Base)
		if base == "" {
			return UpdateReviewResult{Code: "validation", Error: "Update MR failed: target branch cannot be empty."}
		}
	}

	fields := make([]string, 0, 2)
	if input.Title != nil {
		title := strings.TrimSpace(*input.Title)
		if title == "" {
			return UpdateReviewResult{Code: "validation", Error: "Update MR failed: title cannot be empty."}
		}
		fields = append(fields, "title="+title)
	}
	if input.Body != nil {
		fields = append(fields, "description="+*input.Body)
	}
	if len(fields) > 0 {
		args := []string{"api", "-X", "PUT", "merge_requests/" + iid}
		for _, field := range fields {
			args = append(args, "-f", field)
		}
		if _, err := runCLI(ctx, "glab", workdir, args...); err != nil {
			return classifyUpdateReviewError("MR", "GitLab", err)
		}
	}
	updateArgs := []string{"mr", "update", iid}
	if input.Base != nil {
		updateArgs = append(updateArgs, "--target-branch", base)
	}
	if input.Draft != nil {
		if *input.Draft {
			updateArgs = append(updateArgs, "--draft")
		} else {
			updateArgs = append(updateArgs, "--ready")
		}
	}
	if len(updateArgs) > 3 {
		updateArgs = append(updateArgs, "--yes")
		_, err := runCLI(ctx, "glab", workdir, updateArgs...)
		if err != nil && !strings.Contains(strings.ToLower(err.Error()), "already") {
			return classifyUpdateReviewError("MR", "GitLab", err)
		}
	}
	if input.ReviewerIDs != nil {
		args := []string{"api", "-X", "PUT", "projects/:id/merge_requests/" + iid}
		if len(*input.ReviewerIDs) == 0 {
			args = append(args, "-f", "reviewer_ids=")
		} else {
			for _, reviewerID := range *input.ReviewerIDs {
				if reviewerID < 0 {
					return UpdateReviewResult{Code: "validation", Error: "Update MR failed: reviewer IDs must be non-negative."}
				}
				args = append(args, "-f", "reviewer_ids[]="+strconv.Itoa(reviewerID))
			}
		}
		out, err := runCLI(ctx, "glab", workdir, args...)
		if err != nil {
			return classifyUpdateReviewError("MR", "GitLab", err)
		}
		var response struct {
			Reviewers []struct {
				ID        int     `json:"id"`
				Username  string  `json:"username"`
				Name      *string `json:"name"`
				AvatarURL string  `json:"avatar_url"`
				State     string  `json:"state"`
			} `json:"reviewers"`
		}
		if err := json.Unmarshal(out, &response); err != nil {
			return UpdateReviewResult{Code: "invalid_response", Error: "Update MR failed: GitLab returned an invalid reviewer response."}
		}
		for _, reviewer := range response.Reviewers {
			if strings.TrimSpace(reviewer.Username) == "" {
				continue
			}
			updatedReviewers = append(updatedReviewers, GitLabReviewer{
				ID: reviewer.ID, Username: reviewer.Username, Name: reviewer.Name,
				AvatarURL: reviewer.AvatarURL, State: reviewer.State,
			})
		}
	}

	if input.State != "" {
		cmd, ok := gitlabStateCommand(input.State)
		if !ok {
			return UpdateReviewResult{Code: "validation", Error: "Update MR failed: state must be \"open\" or \"closed\"."}
		}
		if cmd != "" {
			out, err := runCLI(ctx, "glab", workdir, "mr", cmd, iid)
			// Why: glab exits non-zero when the MR is already in the target
			// state; treat that as success since the desired state is reached,
			// mirroring closeMR/reopenMR's "already" swallow in Electron.
			if err != nil && !strings.Contains(strings.ToLower(string(out)+err.Error()), "already") {
				return classifyUpdateReviewError("MR", "GitLab", err)
			}
		}
	}
	// GitLab reviewer add/remove has no gh/glab-parity Electron implementation
	// to mirror (GitLab reviewers are set via updateMRReviewers, a full-list
	// REST replace, not add/remove deltas), so incremental add/remove is an
	// honest gap here; callers should use the full-replace route if needed.
	if len(input.AddReviewers) > 0 || len(input.RemoveReviewers) > 0 {
		return UpdateReviewResult{
			Code:  "unsupported_provider",
			Error: "Update MR failed: incremental reviewer add/remove is not supported for GitLab yet; use the full reviewer list replace instead.",
		}
	}
	return UpdateReviewResult{OK: true, Reviewers: updatedReviewers}
}

func githubStateCommand(state string) (string, bool) {
	switch state {
	case "closed":
		return "close", true
	case "open":
		return "reopen", true
	default:
		return "", false
	}
}

func gitlabStateCommand(state string) (string, bool) {
	switch state {
	case "closed":
		return "close", true
	case "open":
		return "reopen", true
	default:
		return "", false
	}
}

func normalizeReviewerLogins(reviewers []string) []string {
	logins := make([]string, 0, len(reviewers))
	for _, reviewer := range reviewers {
		trimmed := strings.TrimSpace(reviewer)
		if trimmed != "" {
			logins = append(logins, trimmed)
		}
	}
	return logins
}

func classifyUpdateReviewError(shortLabel string, provider string, err error) UpdateReviewResult {
	result := classifyCreateReviewError(shortLabel, provider, err)
	return UpdateReviewResult{OK: false, Code: result.Code, Error: strings.Replace(result.Error, "Create "+shortLabel, "Update "+shortLabel, 1)}
}
