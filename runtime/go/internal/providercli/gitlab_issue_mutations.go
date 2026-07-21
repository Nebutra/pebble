package providercli

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

func CreateGitLabIssue(ctx context.Context, workdir, title, body string) GitLabIssueMutationResult {
	title = strings.TrimSpace(title)
	if title == "" {
		return GitLabIssueMutationResult{Error: "Title is required"}
	}
	project, err := resolveGitLabProjectRef(ctx, workdir, nil)
	if err != nil {
		return GitLabIssueMutationResult{Error: err.Error()}
	}
	args := gitLabAPIArgs(project, "-X", "POST", "projects/"+encodeGitLabProjectPath(project.Path)+"/issues", "-f", "title="+title, "-f", "description="+body)
	out, err := runCLI(ctx, "glab", workdir, args...)
	if err != nil {
		return GitLabIssueMutationResult{Error: err.Error()}
	}
	var response struct {
		IID    int    `json:"iid"`
		WebURL string `json:"web_url"`
		URL    string `json:"url"`
	}
	if json.Unmarshal(out, &response) != nil || response.IID < 1 {
		return GitLabIssueMutationResult{Error: "Unexpected response from GitLab"}
	}
	return GitLabIssueMutationResult{OK: true, Number: response.IID, URL: firstNonEmpty(response.WebURL, response.URL)}
}

func UpdateGitLabIssue(ctx context.Context, workdir string, number int, updates GitLabIssueUpdate, override *GitLabProjectRef) GitLabIssueMutationResult {
	if number < 1 {
		return GitLabIssueMutationResult{Error: "Issue number is required"}
	}
	project, err := resolveGitLabProjectRef(ctx, workdir, override)
	if err != nil {
		return GitLabIssueMutationResult{Error: err.Error()}
	}
	errorsFound := make([]string, 0, 3)
	if updates.State != "" {
		command := "reopen"
		if updates.State == "closed" {
			command = "close"
		}
		args := []string{"issue", command, strconv.Itoa(number), "-R", project.Path}
		args = append(args, gitLabHostnameArgs(project)...)
		if _, err := runCLI(ctx, "glab", workdir, args...); err != nil && !strings.Contains(strings.ToLower(err.Error()), "already") {
			errorsFound = append(errorsFound, gitLabIssueMutationError(err))
		}
	}
	if updates.Body != nil {
		resource := "projects/" + encodeGitLabProjectPath(project.Path) + "/issues/" + strconv.Itoa(number)
		if _, err := runCLI(ctx, "glab", workdir, gitLabAPIArgs(project, "-X", "PUT", resource, "-f", "description="+*updates.Body)...); err != nil {
			errorsFound = append(errorsFound, gitLabIssueMutationError(err))
		}
	}
	editArgs := []string{"issue", "update", strconv.Itoa(number), "-R", project.Path}
	editArgs = append(editArgs, gitLabHostnameArgs(project)...)
	hasEdits := false
	if updates.Title != nil && *updates.Title != "" {
		editArgs = append(editArgs, "--title", *updates.Title)
		hasEdits = true
	}
	hasEdits = appendGitLabIssueValues(&editArgs, "--label", updates.AddLabels) || hasEdits
	hasEdits = appendGitLabIssueValues(&editArgs, "--unlabel", updates.RemoveLabels) || hasEdits
	hasEdits = appendGitLabIssueValues(&editArgs, "--assignee", updates.AddAssignees) || hasEdits
	hasEdits = appendGitLabIssueValues(&editArgs, "--unassignee", updates.RemoveAssignees) || hasEdits
	if hasEdits {
		if _, err := runCLI(ctx, "glab", workdir, editArgs...); err != nil {
			errorsFound = append(errorsFound, gitLabIssueMutationError(err))
		}
	}
	if len(errorsFound) > 0 {
		return GitLabIssueMutationResult{Error: strings.Join(errorsFound, "; ")}
	}
	return GitLabIssueMutationResult{OK: true}
}

func AddGitLabIssueComment(ctx context.Context, workdir string, number int, body string, override *GitLabProjectRef) AddReviewCommentResult {
	if number < 1 || strings.TrimSpace(body) == "" {
		return AddReviewCommentResult{Code: "invalid_input", Error: "Issue number and comment body are required"}
	}
	project, err := resolveGitLabProjectRef(ctx, workdir, override)
	if err != nil {
		return AddReviewCommentResult{Code: "project_not_found", Error: err.Error()}
	}
	resource := "projects/" + encodeGitLabProjectPath(project.Path) + "/issues/" + strconv.Itoa(number) + "/notes"
	out, err := runCLI(ctx, "glab", workdir, gitLabAPIArgs(project, "-X", "POST", resource, "-f", "body="+body)...)
	if err != nil {
		return AddReviewCommentResult{Code: "provider_error", Error: gitLabIssueMutationError(err)}
	}
	var response struct {
		ID        int64  `json:"id"`
		Body      string `json:"body"`
		CreatedAt string `json:"created_at"`
		Author    *struct {
			Username  string `json:"username"`
			AvatarURL string `json:"avatar_url"`
			State     string `json:"state"`
		} `json:"author"`
	}
	if json.Unmarshal(out, &response) != nil || response.ID < 1 {
		return AddReviewCommentResult{Code: "invalid_response", Error: "Unexpected response from GitLab"}
	}
	comment := ReviewComment{ID: response.ID, Author: "You", Body: body, CreatedAt: time.Now().UTC().Format(time.RFC3339)}
	if response.Body != "" {
		comment.Body = response.Body
	}
	if response.CreatedAt != "" {
		comment.CreatedAt = response.CreatedAt
	}
	if response.Author != nil {
		if response.Author.Username != "" {
			comment.Author = response.Author.Username
		}
		comment.AuthorAvatarURL = response.Author.AvatarURL
		comment.IsBot = response.Author.State == "bot"
	}
	return AddReviewCommentResult{OK: true, Comment: &comment}
}

func ListGitLabLabels(ctx context.Context, workdir string) []string {
	project, err := resolveGitLabProjectRef(ctx, workdir, nil)
	if err != nil {
		return []string{}
	}
	resource := "projects/" + encodeGitLabProjectPath(project.Path) + "/labels"
	out, err := runCLI(ctx, "glab", workdir, gitLabAPIArgs(project, "--paginate", resource, "--jq", ".[].name")...)
	if err != nil {
		return []string{}
	}
	labels := make([]string, 0)
	for _, label := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if label != "" {
			labels = append(labels, label)
		}
	}
	return labels
}

func gitLabAPIArgs(project GitLabProjectRef, args ...string) []string {
	result := []string{"api"}
	result = append(result, gitLabHostnameArgs(project)...)
	return append(result, args...)
}

func gitLabHostnameArgs(project GitLabProjectRef) []string {
	if project.Host != "" && project.Host != "gitlab.com" {
		return []string{"--hostname", project.Host}
	}
	return nil
}

func appendGitLabIssueValues(args *[]string, flag string, values []string) bool {
	appended := false
	for _, value := range values {
		if value != "" {
			*args = append(*args, flag, value)
			appended = true
		}
	}
	return appended
}

func gitLabIssueMutationError(err error) string {
	result := classifyUpdateReviewError("issue", "GitLab", err)
	if result.Error != "" {
		return result.Error
	}
	return err.Error()
}
