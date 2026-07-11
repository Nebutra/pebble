package providercli

import (
	"context"
	"testing"
)

func stringPtr(s string) *string { return &s }

func TestUpdateGitHubPullRequestEditsTitleAndBody(t *testing.T) {
	dir := fakeCLIStub(t, "gh", "", 0)
	withPath(t, dir)

	result := UpdateGitHubPullRequest(context.Background(), t.TempDir(), UpdateReviewRequest{
		Provider: "github",
		Number:   42,
		Title:    stringPtr("New title"),
		Body:     stringPtr("New body"),
	})
	if !result.OK {
		t.Fatalf("expected update to succeed, got %+v", result)
	}
}

func TestUpdateGitHubPullRequestRejectsMissingNumber(t *testing.T) {
	result := UpdateGitHubPullRequest(context.Background(), t.TempDir(), UpdateReviewRequest{
		Provider: "github",
		Title:    stringPtr("New title"),
	})
	if result.OK || result.Code != "validation" {
		t.Fatalf("expected validation error for missing number, got %+v", result)
	}
}

func TestUpdateGitHubPullRequestRejectsEmptyTitle(t *testing.T) {
	result := UpdateGitHubPullRequest(context.Background(), t.TempDir(), UpdateReviewRequest{
		Provider: "github",
		Number:   1,
		Title:    stringPtr("   "),
	})
	if result.OK || result.Code != "validation" {
		t.Fatalf("expected validation error for blank title, got %+v", result)
	}
}

func TestUpdateGitHubPullRequestClosesAndReopens(t *testing.T) {
	dir := fakeCLIStub(t, "gh", "", 0)
	withPath(t, dir)

	closed := UpdateGitHubPullRequest(context.Background(), t.TempDir(), UpdateReviewRequest{
		Provider: "github",
		Number:   7,
		State:    "closed",
	})
	if !closed.OK {
		t.Fatalf("expected close to succeed, got %+v", closed)
	}

	reopened := UpdateGitHubPullRequest(context.Background(), t.TempDir(), UpdateReviewRequest{
		Provider: "github",
		Number:   7,
		State:    "open",
	})
	if !reopened.OK {
		t.Fatalf("expected reopen to succeed, got %+v", reopened)
	}
}

func TestUpdateGitHubPullRequestRejectsInvalidState(t *testing.T) {
	result := UpdateGitHubPullRequest(context.Background(), t.TempDir(), UpdateReviewRequest{
		Provider: "github",
		Number:   7,
		State:    "merged",
	})
	if result.OK || result.Code != "validation" {
		t.Fatalf("expected validation error for unsupported state, got %+v", result)
	}
}

func TestUpdateGitHubPullRequestAddsAndRemovesReviewers(t *testing.T) {
	dir := fakeCLIStub(t, "gh", "", 0)
	withPath(t, dir)

	added := UpdateGitHubPullRequest(context.Background(), t.TempDir(), UpdateReviewRequest{
		Provider:     "github",
		Number:       3,
		AddReviewers: []string{"octocat", " hubot "},
	})
	if !added.OK {
		t.Fatalf("expected add-reviewers to succeed, got %+v", added)
	}

	removed := UpdateGitHubPullRequest(context.Background(), t.TempDir(), UpdateReviewRequest{
		Provider:        "github",
		Number:          3,
		RemoveReviewers: []string{"octocat"},
	})
	if !removed.OK {
		t.Fatalf("expected remove-reviewers to succeed, got %+v", removed)
	}
}

func TestUpdateGitHubPullRequestClassifiesAuthFailure(t *testing.T) {
	dir := fakeCLIStub(t, "gh", "gh auth login required: not authenticated", 1)
	withPath(t, dir)

	result := UpdateGitHubPullRequest(context.Background(), t.TempDir(), UpdateReviewRequest{
		Provider: "github",
		Number:   1,
		Title:    stringPtr("New title"),
	})
	if result.OK || result.Code != "auth_required" {
		t.Fatalf("expected auth-required result, got %+v", result)
	}
}

func TestUpdateGitLabMergeRequestEditsTitleAndBody(t *testing.T) {
	dir := fakeCLIStub(t, "glab", "", 0)
	withPath(t, dir)

	result := UpdateGitLabMergeRequest(context.Background(), t.TempDir(), UpdateReviewRequest{
		Provider: "gitlab",
		Number:   17,
		Title:    stringPtr("New title"),
		Body:     stringPtr("New body"),
	})
	if !result.OK {
		t.Fatalf("expected update to succeed, got %+v", result)
	}
}

func TestUpdateGitLabMergeRequestClosesAndReopens(t *testing.T) {
	dir := fakeCLIStub(t, "glab", "", 0)
	withPath(t, dir)

	closed := UpdateGitLabMergeRequest(context.Background(), t.TempDir(), UpdateReviewRequest{
		Provider: "gitlab",
		Number:   5,
		State:    "closed",
	})
	if !closed.OK {
		t.Fatalf("expected close to succeed, got %+v", closed)
	}

	reopened := UpdateGitLabMergeRequest(context.Background(), t.TempDir(), UpdateReviewRequest{
		Provider: "gitlab",
		Number:   5,
		State:    "open",
	})
	if !reopened.OK {
		t.Fatalf("expected reopen to succeed, got %+v", reopened)
	}
}

func TestUpdateGitLabMergeRequestTreatsAlreadyInStateAsSuccess(t *testing.T) {
	dir := fakeCLIStub(t, "glab", "merge request is already closed", 1)
	withPath(t, dir)

	result := UpdateGitLabMergeRequest(context.Background(), t.TempDir(), UpdateReviewRequest{
		Provider: "gitlab",
		Number:   5,
		State:    "closed",
	})
	if !result.OK {
		t.Fatalf("expected already-closed to be treated as success, got %+v", result)
	}
}

func TestUpdateGitLabMergeRequestRejectsIncrementalReviewers(t *testing.T) {
	result := UpdateGitLabMergeRequest(context.Background(), t.TempDir(), UpdateReviewRequest{
		Provider:     "gitlab",
		Number:       5,
		AddReviewers: []string{"tanuki"},
	})
	if result.OK || result.Code != "unsupported_provider" {
		t.Fatalf("expected unsupported_provider gap for reviewer deltas, got %+v", result)
	}
}

func TestUpdateGitLabMergeRequestRejectsMissingNumber(t *testing.T) {
	result := UpdateGitLabMergeRequest(context.Background(), t.TempDir(), UpdateReviewRequest{
		Provider: "gitlab",
		Title:    stringPtr("New title"),
	})
	if result.OK || result.Code != "validation" {
		t.Fatalf("expected validation error for missing number, got %+v", result)
	}
}
