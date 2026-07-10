package providercli

import (
	"context"
	"testing"
)

func TestCreateGitHubPullRequestParsesCreatedURL(t *testing.T) {
	dir := fakeCLIStub(t, "gh", "https://github.com/nebutra/pebble/pull/42", 0)
	withPath(t, dir)

	result := CreateGitHubPullRequest(context.Background(), t.TempDir(), CreateReviewRequest{
		Provider: "github",
		Base:     "origin/main",
		Head:     "refs/heads/feature/review",
		Title:    "Open PR",
		Body:     "Body",
		Draft:    true,
	})

	if !result.OK || result.Number != 42 || result.URL != "https://github.com/nebutra/pebble/pull/42" {
		t.Fatalf("unexpected create result: %+v", result)
	}
}

func TestCreateGitLabMergeRequestParsesCreatedURL(t *testing.T) {
	dir := fakeCLIStub(
		t,
		"glab",
		"https://gitlab.com/nebutra/pebble/-/merge_requests/17",
		0,
	)
	withPath(t, dir)

	result := CreateGitLabMergeRequest(context.Background(), t.TempDir(), CreateReviewRequest{
		Provider: "gitlab",
		Base:     "upstream/main",
		Head:     "refs/remotes/origin/feature/review",
		Title:    "Open MR",
		Body:     "Body",
	})

	if !result.OK || result.Number != 17 || result.URL != "https://gitlab.com/nebutra/pebble/-/merge_requests/17" {
		t.Fatalf("unexpected create result: %+v", result)
	}
}

func TestCreateReviewRejectsMatchingHeadAndBase(t *testing.T) {
	result := CreateGitHubPullRequest(context.Background(), t.TempDir(), CreateReviewRequest{
		Provider: "github",
		Base:     "main",
		Head:     "refs/heads/main",
		Title:    "Invalid PR",
	})

	if result.OK || result.Code != "validation" {
		t.Fatalf("expected validation result, got %+v", result)
	}
}

func TestCreateReviewClassifiesAuthenticationFailure(t *testing.T) {
	dir := fakeCLIStub(t, "gh", "gh auth login required: not authenticated", 1)
	withPath(t, dir)

	result := CreateGitHubPullRequest(context.Background(), t.TempDir(), CreateReviewRequest{
		Provider: "github",
		Base:     "main",
		Head:     "feature/review",
		Title:    "Open PR",
	})

	if result.OK || result.Code != "auth_required" {
		t.Fatalf("expected auth-required result, got %+v", result)
	}
}
