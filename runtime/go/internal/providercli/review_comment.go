package providercli

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

type AddReviewCommentRequest struct {
	Provider string `json:"provider"`
	Number   int    `json:"number"`
	Body     string `json:"body"`
	Owner    string `json:"owner,omitempty"`
	Repo     string `json:"repo,omitempty"`
}

type ReviewComment struct {
	ID              int64  `json:"id"`
	Author          string `json:"author"`
	AuthorAvatarURL string `json:"authorAvatarUrl"`
	Body            string `json:"body"`
	CreatedAt       string `json:"createdAt"`
	URL             string `json:"url"`
	IsBot           bool   `json:"isBot"`
	Path            string `json:"path,omitempty"`
	ThreadID        string `json:"threadId,omitempty"`
	IsResolved      bool   `json:"isResolved,omitempty"`
	Line            int    `json:"line,omitempty"`
	StartLine       int    `json:"startLine,omitempty"`
}

type AddInlineReviewCommentRequest struct {
	Provider  string `json:"provider"`
	Number    int    `json:"number"`
	Body      string `json:"body"`
	Path      string `json:"path"`
	OldPath   string `json:"oldPath,omitempty"`
	Line      int    `json:"line"`
	StartLine int    `json:"startLine,omitempty"`
	CommitID  string `json:"commitId,omitempty"`
	BaseSHA   string `json:"baseSha,omitempty"`
	StartSHA  string `json:"startSha,omitempty"`
	HeadSHA   string `json:"headSha,omitempty"`
}

type ReplyReviewCommentRequest struct {
	Number    int    `json:"number"`
	CommentID int    `json:"commentId"`
	Body      string `json:"body"`
	ThreadID  string `json:"threadId,omitempty"`
	Path      string `json:"path,omitempty"`
	Line      int    `json:"line,omitempty"`
	Owner     string `json:"owner,omitempty"`
	Repo      string `json:"repo,omitempty"`
}

type AddReviewCommentResult struct {
	OK      bool           `json:"ok"`
	Code    string         `json:"code,omitempty"`
	Error   string         `json:"error,omitempty"`
	Comment *ReviewComment `json:"comment,omitempty"`
}

func AddGitHubReviewComment(ctx context.Context, workdir string, input AddReviewCommentRequest) AddReviewCommentResult {
	if result := validateReviewComment(input, "GitHub"); result != nil {
		return *result
	}
	repository := ":owner/:repo"
	if input.Owner != "" && input.Repo != "" {
		repository = input.Owner + "/" + input.Repo
	}
	out, err := runCLI(ctx, "gh", workdir, "api", "-X", "POST", "repos/"+repository+"/issues/"+strconv.Itoa(input.Number)+"/comments", "--raw-field", "body="+input.Body)
	if err != nil {
		return commentError(classifyUpdateReviewError("comment", "GitHub", err))
	}
	var response struct {
		ID        int64  `json:"id"`
		Body      string `json:"body"`
		CreatedAt string `json:"created_at"`
		HTMLURL   string `json:"html_url"`
		User      *struct {
			Login     string `json:"login"`
			AvatarURL string `json:"avatar_url"`
			Type      string `json:"type"`
		} `json:"user"`
	}
	if json.Unmarshal(out, &response) != nil || response.ID < 1 {
		return AddReviewCommentResult{Code: "invalid_response", Error: "Unexpected response from GitHub"}
	}
	comment := ReviewComment{ID: response.ID, Author: "You", Body: input.Body, CreatedAt: time.Now().UTC().Format(time.RFC3339), URL: response.HTMLURL}
	if response.Body != "" {
		comment.Body = response.Body
	}
	if response.CreatedAt != "" {
		comment.CreatedAt = response.CreatedAt
	}
	if response.User != nil {
		if response.User.Login != "" {
			comment.Author = response.User.Login
		}
		comment.AuthorAvatarURL = response.User.AvatarURL
		comment.IsBot = response.User.Type == "Bot"
	}
	return AddReviewCommentResult{OK: true, Comment: &comment}
}

func AddGitLabReviewComment(ctx context.Context, workdir string, input AddReviewCommentRequest) AddReviewCommentResult {
	if result := validateReviewComment(input, "GitLab"); result != nil {
		return *result
	}
	out, err := runCLI(ctx, "glab", workdir, "api", "-X", "POST", "projects/:id/merge_requests/"+strconv.Itoa(input.Number)+"/notes", "-f", "body="+input.Body)
	if err != nil {
		return commentError(classifyUpdateReviewError("comment", "GitLab", err))
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
	comment := ReviewComment{ID: response.ID, Author: "You", Body: input.Body, CreatedAt: time.Now().UTC().Format(time.RFC3339), URL: ""}
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

func AddGitHubInlineReviewComment(ctx context.Context, workdir string, input AddInlineReviewCommentRequest) AddReviewCommentResult {
	if result := validateInlineReviewComment(input, true); result != nil {
		return *result
	}
	args := []string{"api", "-X", "POST", "repos/:owner/:repo/pulls/" + strconv.Itoa(input.Number) + "/comments", "--raw-field", "body=" + input.Body, "--raw-field", "commit_id=" + input.CommitID, "--raw-field", "path=" + input.Path, "--field", "line=" + strconv.Itoa(input.Line), "--raw-field", "side=RIGHT"}
	if input.StartLine > 0 && input.StartLine != input.Line {
		args = append(args, "--field", "start_line="+strconv.Itoa(input.StartLine), "--raw-field", "start_side=RIGHT")
	}
	out, err := runCLI(ctx, "gh", workdir, args...)
	if err != nil {
		return commentError(classifyUpdateReviewError("review comment", "GitHub", err))
	}
	var response struct {
		ID        int64  `json:"id"`
		Body      string `json:"body"`
		CreatedAt string `json:"created_at"`
		HTMLURL   string `json:"html_url"`
		Path      string `json:"path"`
		Line      int    `json:"line"`
		User      *struct {
			Login     string `json:"login"`
			AvatarURL string `json:"avatar_url"`
			Type      string `json:"type"`
		} `json:"user"`
	}
	if json.Unmarshal(out, &response) != nil || response.ID < 1 {
		return AddReviewCommentResult{Code: "invalid_response", Error: "Unexpected response from GitHub"}
	}
	comment := ReviewComment{ID: response.ID, Author: "You", Body: input.Body, CreatedAt: time.Now().UTC().Format(time.RFC3339), URL: response.HTMLURL, Path: input.Path, Line: input.Line, StartLine: input.StartLine}
	if response.Body != "" {
		comment.Body = response.Body
	}
	if response.CreatedAt != "" {
		comment.CreatedAt = response.CreatedAt
	}
	if response.Path != "" {
		comment.Path = response.Path
	}
	if response.Line > 0 {
		comment.Line = response.Line
	}
	if response.User != nil {
		if response.User.Login != "" {
			comment.Author = response.User.Login
		}
		comment.AuthorAvatarURL = response.User.AvatarURL
		comment.IsBot = response.User.Type == "Bot"
	}
	return AddReviewCommentResult{OK: true, Comment: &comment}
}

func AddGitLabInlineReviewComment(ctx context.Context, workdir string, input AddInlineReviewCommentRequest) AddReviewCommentResult {
	if result := validateInlineReviewComment(input, false); result != nil {
		return *result
	}
	oldPath := input.OldPath
	if oldPath == "" {
		oldPath = input.Path
	}
	args := []string{"api", "-X", "POST", "projects/:id/merge_requests/" + strconv.Itoa(input.Number) + "/discussions", "-f", "body=" + strings.TrimSpace(input.Body), "-f", "position[position_type]=text", "-f", "position[base_sha]=" + input.BaseSHA, "-f", "position[start_sha]=" + input.StartSHA, "-f", "position[head_sha]=" + input.HeadSHA, "-f", "position[old_path]=" + oldPath, "-f", "position[new_path]=" + input.Path, "-f", "position[new_line]=" + strconv.Itoa(input.Line)}
	out, err := runCLI(ctx, "glab", workdir, args...)
	if err != nil {
		return commentError(classifyUpdateReviewError("inline comment", "GitLab", err))
	}
	var response struct {
		ID    string `json:"id"`
		Notes []struct {
			ID        int64  `json:"id"`
			Body      string `json:"body"`
			CreatedAt string `json:"created_at"`
			Position  *struct {
				NewPath string `json:"new_path"`
				NewLine int    `json:"new_line"`
			} `json:"position"`
			Author *struct {
				Username  string `json:"username"`
				AvatarURL string `json:"avatar_url"`
				State     string `json:"state"`
			} `json:"author"`
		} `json:"notes"`
	}
	if json.Unmarshal(out, &response) != nil || len(response.Notes) == 0 || response.Notes[0].ID < 1 {
		return AddReviewCommentResult{Code: "invalid_response", Error: "Unexpected response from GitLab"}
	}
	note := response.Notes[0]
	comment := ReviewComment{ID: note.ID, Author: "You", Body: strings.TrimSpace(input.Body), CreatedAt: time.Now().UTC().Format(time.RFC3339), ThreadID: response.ID, Path: input.Path, Line: input.Line}
	if note.Body != "" {
		comment.Body = note.Body
	}
	if note.CreatedAt != "" {
		comment.CreatedAt = note.CreatedAt
	}
	if note.Position != nil {
		if note.Position.NewPath != "" {
			comment.Path = note.Position.NewPath
		}
		if note.Position.NewLine > 0 {
			comment.Line = note.Position.NewLine
		}
	}
	if note.Author != nil {
		if note.Author.Username != "" {
			comment.Author = note.Author.Username
		}
		comment.AuthorAvatarURL = note.Author.AvatarURL
		comment.IsBot = note.Author.State == "bot"
	}
	return AddReviewCommentResult{OK: true, Comment: &comment}
}

func ReplyGitHubReviewComment(ctx context.Context, workdir string, input ReplyReviewCommentRequest) AddReviewCommentResult {
	if input.Number <= 0 || input.CommentID <= 0 || strings.TrimSpace(input.Body) == "" {
		return AddReviewCommentResult{Code: "validation", Error: "Reply to review comment failed: PR, parent comment, and body are required."}
	}
	repository := ":owner/:repo"
	if input.Owner != "" && input.Repo != "" {
		repository = input.Owner + "/" + input.Repo
	}
	out, err := runCLI(ctx, "gh", workdir, "api", "-X", "POST", "repos/"+repository+"/pulls/"+strconv.Itoa(input.Number)+"/comments/"+strconv.Itoa(input.CommentID)+"/replies", "--raw-field", "body="+input.Body)
	if err != nil {
		return commentError(classifyUpdateReviewError("review reply", "GitHub", err))
	}
	var response struct {
		ID        int64  `json:"id"`
		Body      string `json:"body"`
		CreatedAt string `json:"created_at"`
		HTMLURL   string `json:"html_url"`
		Path      string `json:"path"`
		Line      int    `json:"line"`
		User      *struct {
			Login     string `json:"login"`
			AvatarURL string `json:"avatar_url"`
			Type      string `json:"type"`
		} `json:"user"`
	}
	if json.Unmarshal(out, &response) != nil || response.ID < 1 {
		return AddReviewCommentResult{Code: "invalid_response", Error: "Unexpected response from GitHub"}
	}
	comment := ReviewComment{ID: response.ID, Author: "You", Body: input.Body, CreatedAt: time.Now().UTC().Format(time.RFC3339), URL: response.HTMLURL, ThreadID: input.ThreadID, Path: input.Path, Line: input.Line}
	if response.Body != "" {
		comment.Body = response.Body
	}
	if response.CreatedAt != "" {
		comment.CreatedAt = response.CreatedAt
	}
	if response.Path != "" {
		comment.Path = response.Path
	}
	if response.Line > 0 {
		comment.Line = response.Line
	}
	if response.User != nil {
		if response.User.Login != "" {
			comment.Author = response.User.Login
		}
		comment.AuthorAvatarURL = response.User.AvatarURL
		comment.IsBot = response.User.Type == "Bot"
	}
	return AddReviewCommentResult{OK: true, Comment: &comment}
}

func validateInlineReviewComment(input AddInlineReviewCommentRequest, github bool) *AddReviewCommentResult {
	missing := input.Number <= 0 || strings.TrimSpace(input.Body) == "" || input.Path == "" || input.Line <= 0
	if github {
		missing = missing || input.CommitID == ""
	} else {
		missing = missing || input.BaseSHA == "" || input.StartSHA == "" || input.HeadSHA == ""
	}
	if missing {
		return &AddReviewCommentResult{Code: "validation", Error: "Add inline review comment failed: review identity, diff position, and body are required."}
	}
	return nil
}

func validateReviewComment(input AddReviewCommentRequest, provider string) *AddReviewCommentResult {
	if input.Number <= 0 || strings.TrimSpace(input.Body) == "" {
		return &AddReviewCommentResult{Code: "validation", Error: "Add " + provider + " review comment failed: a review number and comment body are required."}
	}
	return nil
}

func commentError(result UpdateReviewResult) AddReviewCommentResult {
	return AddReviewCommentResult{Code: result.Code, Error: result.Error}
}
