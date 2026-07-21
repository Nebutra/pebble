package providercli

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
)

type SetAutoMergeRequest struct {
	Number  int    `json:"number"`
	Enabled bool   `json:"enabled"`
	Method  string `json:"method"`
}

type pullRequestAutoMergeIdentity struct {
	ID          string `json:"id"`
	HeadRefOID  string `json:"headRefOid"`
	BaseRefName string `json:"baseRefName"`
}

func SetGitHubPullRequestAutoMerge(ctx context.Context, workdir string, input SetAutoMergeRequest) UpdateReviewResult {
	if input.Number <= 0 || !isMergeMethod(input.Method) {
		return UpdateReviewResult{Code: "validation", Error: "Set PR auto-merge failed: a review number and valid merge method are required."}
	}
	number := strconv.Itoa(input.Number)
	if !input.Enabled {
		if _, err := runCLI(ctx, "gh", workdir, "pr", "merge", number, "--disable-auto"); err != nil {
			return classifyAutoMergeError(err)
		}
		return UpdateReviewResult{OK: true}
	}

	identity, result := readPullRequestAutoMergeIdentity(ctx, workdir, number)
	if result != nil {
		return *result
	}
	queued, result := repositoryUsesMergeQueue(ctx, workdir, identity.BaseRefName)
	if result != nil {
		return *result
	}
	if queued {
		if _, err := runCLI(ctx, "gh", workdir, "pr", "merge", number, "--auto", "--"+input.Method); err != nil {
			return classifyAutoMergeError(err)
		}
		return UpdateReviewResult{OK: true}
	}

	query := `mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!, $expectedHeadOid: GitObjectID) { enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod, expectedHeadOid: $expectedHeadOid }) { pullRequest { id } } }`
	args := []string{"api", "graphql", "-f", "query=" + query, "-f", "pullRequestId=" + identity.ID, "-f", "mergeMethod=" + strings.ToUpper(input.Method)}
	if identity.HeadRefOID != "" {
		args = append(args, "-f", "expectedHeadOid="+identity.HeadRefOID)
	}
	if _, err := runCLI(ctx, "gh", workdir, args...); err != nil {
		return classifyAutoMergeError(err)
	}
	return UpdateReviewResult{OK: true}
}

func readPullRequestAutoMergeIdentity(ctx context.Context, workdir string, number string) (pullRequestAutoMergeIdentity, *UpdateReviewResult) {
	out, err := runCLI(ctx, "gh", workdir, "pr", "view", number, "--json", "id,headRefOid,baseRefName")
	if err != nil {
		result := classifyAutoMergeError(err)
		return pullRequestAutoMergeIdentity{}, &result
	}
	var identity pullRequestAutoMergeIdentity
	if json.Unmarshal(out, &identity) != nil || identity.ID == "" {
		result := UpdateReviewResult{Code: "invalid_response", Error: "Could not resolve GitHub pull request ID"}
		return pullRequestAutoMergeIdentity{}, &result
	}
	return identity, nil
}

func repositoryUsesMergeQueue(ctx context.Context, workdir string, branch string) (bool, *UpdateReviewResult) {
	out, err := runCLI(ctx, "gh", workdir, "repo", "view", "--json", "nameWithOwner")
	if err != nil {
		result := classifyAutoMergeError(err)
		return false, &result
	}
	var repo struct {
		NameWithOwner string `json:"nameWithOwner"`
	}
	if json.Unmarshal(out, &repo) != nil {
		result := UpdateReviewResult{Code: "invalid_response", Error: "Could not resolve GitHub repository identity"}
		return false, &result
	}
	parts := strings.SplitN(repo.NameWithOwner, "/", 2)
	if len(parts) != 2 || branch == "" {
		return false, nil
	}
	query := `query($owner: String!, $repo: String!, $branch: String!) { repository(owner: $owner, name: $repo) { mergeQueue(branch: $branch) { id } } }`
	out, err = runCLI(ctx, "gh", workdir, "api", "graphql", "-f", "query="+query, "-f", "owner="+parts[0], "-f", "repo="+parts[1], "-f", "branch="+branch)
	if err != nil {
		result := classifyAutoMergeError(err)
		return false, &result
	}
	var response struct {
		Data struct {
			Repository struct {
				MergeQueue *struct {
					ID string `json:"id"`
				} `json:"mergeQueue"`
			} `json:"repository"`
		} `json:"data"`
	}
	if json.Unmarshal(out, &response) != nil {
		result := UpdateReviewResult{Code: "invalid_response", Error: "GitHub returned invalid merge metadata"}
		return false, &result
	}
	return response.Data.Repository.MergeQueue != nil, nil
}

func isMergeMethod(method string) bool {
	return method == "merge" || method == "squash" || method == "rebase"
}

func classifyAutoMergeError(err error) UpdateReviewResult {
	if strings.Contains(strings.ToLower(err.Error()), "in clean status") {
		return UpdateReviewResult{Code: "already_mergeable", Error: "This pull request can already be merged. Use Merge instead of auto-merge."}
	}
	return classifyUpdateReviewError("PR", "GitHub", err)
}
