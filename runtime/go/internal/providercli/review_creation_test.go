package providercli

import (
	"context"
	"os"
	"path/filepath"
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

// writeTemplateFile creates dir/relativePath with contents, creating parent
// directories as needed, and returns the workdir root.
func writeTemplateFile(t *testing.T, workdir string, relativePath string, contents string) {
	t.Helper()
	fullPath := filepath.Join(workdir, relativePath)
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatalf("mkdir for template: %v", err)
	}
	if err := os.WriteFile(fullPath, []byte(contents), 0o644); err != nil {
		t.Fatalf("write template file: %v", err)
	}
}

func TestCreateGitHubPullRequestHydratesRootLevelTemplate(t *testing.T) {
	workdir := t.TempDir()
	// Why: PULL_REQUEST_TEMPLATE.md (no .github/ prefix) is a real GitHub
	// convention Electron's candidate list covers; exercise a candidate beyond
	// the two most obvious .github/ paths to catch a truncated candidate list.
	writeTemplateFile(t, workdir, "PULL_REQUEST_TEMPLATE.md", "## Summary\n## Test plan\n")

	dir := fakeCLIStub(t, "gh", "https://github.com/nebutra/pebble/pull/9", 0)
	withPath(t, dir)

	// gh reads --body-file; the fake stub can't inspect args, so verify via
	// resolveReviewBody directly for the exact hydrated content, and via the
	// full create call for the end-to-end wiring.
	body := resolveReviewBody(workdir, CreateReviewRequest{UseTemplate: true}, pullRequestTemplateCandidates)
	if body != "## Summary\n## Test plan\n" {
		t.Fatalf("expected root-level template hydration, got %q", body)
	}

	result := CreateGitHubPullRequest(context.Background(), workdir, CreateReviewRequest{
		Provider:    "github",
		Base:        "main",
		Head:        "feature/x",
		Title:       "Use template",
		UseTemplate: true,
	})
	if !result.OK {
		t.Fatalf("expected create to succeed, got %+v", result)
	}
}

func TestCreateGitHubPullRequestHydratesDocsTemplateWhenGithubDirMissing(t *testing.T) {
	workdir := t.TempDir()
	writeTemplateFile(t, workdir, "docs/pull_request_template.md", "docs template body")

	body := resolveReviewBody(workdir, CreateReviewRequest{UseTemplate: true}, pullRequestTemplateCandidates)
	if body != "docs template body" {
		t.Fatalf("expected docs/ template hydration, got %q", body)
	}
}

func TestCreateGitHubPullRequestPrefersGithubDirOverDocs(t *testing.T) {
	workdir := t.TempDir()
	writeTemplateFile(t, workdir, "docs/pull_request_template.md", "docs template body")
	writeTemplateFile(t, workdir, ".github/pull_request_template.md", ".github template body")

	body := resolveReviewBody(workdir, CreateReviewRequest{UseTemplate: true}, pullRequestTemplateCandidates)
	if body != ".github template body" {
		t.Fatalf("expected .github/ template to win over docs/, got %q", body)
	}
}

func TestCreateGitLabMergeRequestFallsBackToPullRequestTemplateCandidates(t *testing.T) {
	workdir := t.TempDir()
	// Why: GitLab's getTemplateCandidates falls back to the generic PR
	// candidates when no .gitlab/ MR template exists (mirrors Electron).
	writeTemplateFile(t, workdir, "pull_request_template.md", "shared template body")

	candidates := append(append([]string{}, mergeRequestTemplateCandidates...), pullRequestTemplateCandidates...)
	body := resolveReviewBody(workdir, CreateReviewRequest{UseTemplate: true}, candidates)
	if body != "shared template body" {
		t.Fatalf("expected fallback to shared PR template, got %q", body)
	}
}

func TestResolveReviewBodyDoesNotOverrideNonEmptyBody(t *testing.T) {
	workdir := t.TempDir()
	writeTemplateFile(t, workdir, "PULL_REQUEST_TEMPLATE.md", "template body")

	body := resolveReviewBody(workdir, CreateReviewRequest{UseTemplate: true, Body: "explicit body"}, pullRequestTemplateCandidates)
	if body != "explicit body" {
		t.Fatalf("expected explicit body to win, got %q", body)
	}
}

func TestResolveReviewBodyReturnsEmptyWhenTemplateMissing(t *testing.T) {
	workdir := t.TempDir()
	body := resolveReviewBody(workdir, CreateReviewRequest{UseTemplate: true}, pullRequestTemplateCandidates)
	if body != "" {
		t.Fatalf("expected empty body when no template file exists, got %q", body)
	}
}
