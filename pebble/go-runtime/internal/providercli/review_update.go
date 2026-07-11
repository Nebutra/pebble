package providercli

import (
	"context"
	"strconv"
	"strings"
)

// UpdateReviewRequest carries the realistic post-creation mutations Electron
// supports: title/body edits (updatePRDetails/updateMR), reviewer add/remove
// (requestPRReviewers/removePRReviewers), and close/reopen
// (updatePRState/closeMR+reopenMR). Retarget-base and draft<->ready toggles
// have no Electron-side implementation to mirror (see AGENTS.md honest-gap
// convention), so they are intentionally absent here.
type UpdateReviewRequest struct {
	Provider        string   `json:"provider"`
	Number          int      `json:"number"`
	Title           *string  `json:"title,omitempty"`
	Body            *string  `json:"body,omitempty"`
	State           string   `json:"state,omitempty"` // "open" | "closed"
	AddReviewers    []string `json:"addReviewers,omitempty"`
	RemoveReviewers []string `json:"removeReviewers,omitempty"`
}

type UpdateReviewResult struct {
	OK    bool   `json:"ok"`
	Code  string `json:"code,omitempty"`
	Error string `json:"error,omitempty"`
}

// UpdateGitHubPullRequest mirrors updatePRDetails/updatePRState/requestPRReviewers/
// removePRReviewers in src/main/github/client.ts using gh's `pr edit`/`pr close`/
// `pr reopen` subcommands instead of raw REST calls, since gh already exposes
// realistic subcommands for these operations.
func UpdateGitHubPullRequest(ctx context.Context, workdir string, input UpdateReviewRequest) UpdateReviewResult {
	if input.Number <= 0 {
		return UpdateReviewResult{Code: "validation", Error: "Update PR failed: a pull request number is required."}
	}
	number := strconv.Itoa(input.Number)

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
	if logins := normalizeReviewerLogins(input.AddReviewers); len(logins) > 0 {
		editArgs = append(editArgs, "--add-reviewer", strings.Join(logins, ","))
	}
	if logins := normalizeReviewerLogins(input.RemoveReviewers); len(logins) > 0 {
		editArgs = append(editArgs, "--remove-reviewer", strings.Join(logins, ","))
	}
	if len(editArgs) > 3 {
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
			if _, err := runCLI(ctx, "gh", workdir, "pr", cmd, number); err != nil {
				return classifyUpdateReviewError("PR", "GitHub", err)
			}
		}
	}
	return UpdateReviewResult{OK: true}
}

// UpdateGitLabMergeRequest mirrors updateMR/closeMR/reopenMR in
// src/main/gitlab/client.ts. Title/body use `glab api PUT` (as updateMR does);
// close/reopen use glab's dedicated subcommands.
func UpdateGitLabMergeRequest(ctx context.Context, workdir string, input UpdateReviewRequest) UpdateReviewResult {
	if input.Number <= 0 {
		return UpdateReviewResult{Code: "validation", Error: "Update MR failed: a merge request number is required."}
	}
	iid := strconv.Itoa(input.Number)

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
	return UpdateReviewResult{OK: true}
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
