package providercli

import (
	"context"
	"testing"
)

func TestAddGitHubReviewCommentMapsResponse(t *testing.T) {
	dir := fakeCLIStub(t, "gh", `{"id":123,"user":{"login":"octocat","avatar_url":"https://avatar","type":"Bot"},"body":"Done","created_at":"2026-01-02T03:04:05Z","html_url":"https://github/comment/123"}`, 0)
	withPath(t, dir)
	result := AddGitHubReviewComment(context.Background(), t.TempDir(), AddReviewCommentRequest{Provider: "github", Number: 7, Body: "Done", Owner: "nebutra", Repo: "pebble"})
	if !result.OK || result.Comment == nil || result.Comment.ID != 123 || result.Comment.Author != "octocat" || !result.Comment.IsBot || result.Comment.URL == "" {
		t.Fatalf("unexpected GitHub comment result: %+v", result)
	}
}

func TestAddGitLabReviewCommentMapsResponse(t *testing.T) {
	dir := fakeCLIStub(t, "glab", `{"id":456,"author":{"username":"tanuki","avatar_url":"https://avatar","state":"active"},"body":"Done","created_at":"2026-01-02T03:04:05Z"}`, 0)
	withPath(t, dir)
	result := AddGitLabReviewComment(context.Background(), t.TempDir(), AddReviewCommentRequest{Provider: "gitlab", Number: 9, Body: "Done"})
	if !result.OK || result.Comment == nil || result.Comment.ID != 456 || result.Comment.Author != "tanuki" || result.Comment.IsBot {
		t.Fatalf("unexpected GitLab comment result: %+v", result)
	}
}

func TestAddReviewCommentRejectsBlankBody(t *testing.T) {
	result := AddGitHubReviewComment(context.Background(), t.TempDir(), AddReviewCommentRequest{Provider: "github", Number: 1, Body: "  "})
	if result.OK || result.Code != "validation" {
		t.Fatalf("expected validation error, got %+v", result)
	}
}

func TestAddGitHubInlineReviewCommentMapsDiffPosition(t *testing.T) {
	dir := fakeCLIStub(t, "gh", `{"id":789,"user":{"login":"reviewer","avatar_url":"","type":"User"},"body":"Fix this","created_at":"2026-01-02T03:04:05Z","html_url":"https://github/comment/789","path":"src/app.ts","line":12}`, 0)
	withPath(t, dir)
	result := AddGitHubInlineReviewComment(context.Background(), t.TempDir(), AddInlineReviewCommentRequest{Provider: "github", Number: 3, Body: "Fix this", CommitID: "abc", Path: "src/app.ts", Line: 12, StartLine: 10})
	if !result.OK || result.Comment == nil || result.Comment.Path != "src/app.ts" || result.Comment.Line != 12 || result.Comment.StartLine != 10 {
		t.Fatalf("unexpected inline comment: %+v", result)
	}
}

func TestAddGitLabInlineReviewCommentMapsDiscussion(t *testing.T) {
	dir := fakeCLIStub(t, "glab", `{"id":"discussion-1","notes":[{"id":790,"author":{"username":"tanuki","avatar_url":"","state":"active"},"body":"Fix this","created_at":"2026-01-02T03:04:05Z","position":{"new_path":"src/app.ts","new_line":12}}]}`, 0)
	withPath(t, dir)
	result := AddGitLabInlineReviewComment(context.Background(), t.TempDir(), AddInlineReviewCommentRequest{Provider: "gitlab", Number: 3, Body: "Fix this", BaseSHA: "base", StartSHA: "start", HeadSHA: "head", Path: "src/app.ts", Line: 12})
	if !result.OK || result.Comment == nil || result.Comment.ThreadID != "discussion-1" || result.Comment.Path != "src/app.ts" || result.Comment.Line != 12 {
		t.Fatalf("unexpected inline discussion: %+v", result)
	}
}

func TestReplyGitHubReviewCommentPreservesThreadContext(t *testing.T) {
	dir := fakeCLIStub(t, "gh", `{"id":900,"user":{"login":"reviewer"},"body":"Reply","path":"app.ts","line":8}`, 0)
	withPath(t, dir)
	result := ReplyGitHubReviewComment(context.Background(), t.TempDir(), ReplyReviewCommentRequest{Number: 3, CommentID: 789, Body: "Reply", ThreadID: "thread-1", Path: "app.ts", Line: 8})
	if !result.OK || result.Comment == nil || result.Comment.ThreadID != "thread-1" || result.Comment.Line != 8 {
		t.Fatalf("unexpected reply: %+v", result)
	}
}
