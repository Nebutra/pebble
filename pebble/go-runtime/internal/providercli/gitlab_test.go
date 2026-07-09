package providercli

import (
	"context"
	"errors"
	"testing"
)

const glabMRListJSON = `[
  {"id":1001,"iid":7,"title":"Ship it","state":"opened","web_url":"https://gitlab.com/g/p/-/merge_requests/7","updated_at":"2024-02-03T04:05:06Z","author":{"username":"tanuki"},"labels":["backend","frontend"],"draft":false,"source_branch":"topic","target_branch":"main","source_project_id":5,"target_project_id":5},
  {"id":1002,"iid":6,"title":"Draft: WIP thing","state":"opened","web_url":"https://gitlab.com/g/p/-/merge_requests/6","updated_at":"2024-02-02T00:00:00Z","author":{"username":"dev"},"labels":[{"name":"chore"}],"draft":false,"source_branch":"wip","target_branch":"main","source_project_id":9,"target_project_id":5}
]`

func TestListGitLabMRsHappyPath(t *testing.T) {
	dir := fakeCLIStub(t, "glab", glabMRListJSON, 0)
	withPath(t, dir)
	items, err := ListGitLabMRs(context.Background(), "", "opened", 20, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(items))
	}
	first := items[0]
	if first.ID != "gitlab-mr-1001" || first.Type != "mr" || first.Number != 7 {
		t.Fatalf("unexpected id/type/number: %+v", first)
	}
	if first.State != "opened" {
		t.Fatalf("expected opened state, got %q", first.State)
	}
	if first.URL != "https://gitlab.com/g/p/-/merge_requests/7" {
		t.Fatalf("unexpected url: %q", first.URL)
	}
	if first.Author == nil || *first.Author != "tanuki" {
		t.Fatalf("expected author tanuki, got %+v", first.Author)
	}
	if first.BranchName != "topic" || first.BaseRefName != "main" {
		t.Fatalf("unexpected branches: %+v", first)
	}
	if len(first.Labels) != 2 || first.Labels[0] != "backend" {
		t.Fatalf("unexpected labels: %+v", first.Labels)
	}
	// Second item's title carries a Draft:/WIP: prefix, which maps to draft
	// state even though the draft boolean is false (mirrors mapMRState).
	if items[1].State != "draft" {
		t.Fatalf("expected draft state from title prefix, got %q", items[1].State)
	}
	if len(items[1].Labels) != 1 || items[1].Labels[0] != "chore" {
		t.Fatalf("expected object-form label to coerce to name: %+v", items[1].Labels)
	}
}

func TestListGitLabMRsMissingCLI(t *testing.T) {
	withEmptyPath(t, t.TempDir())
	_, err := ListGitLabMRs(context.Background(), "", "opened", 20, "")
	if !errors.Is(err, ErrCLIMissing) {
		t.Fatalf("expected ErrCLIMissing, got %v", err)
	}
}

func TestListGitLabMRsUnauthenticated(t *testing.T) {
	dir := fakeCLIStub(t, "glab", "error: run `glab auth login` to authenticate", 1)
	withPath(t, dir)
	_, err := ListGitLabMRs(context.Background(), "", "opened", 20, "")
	if !errors.Is(err, ErrCLIUnauthenticated) {
		t.Fatalf("expected ErrCLIUnauthenticated, got %v", err)
	}
}

func TestListGitLabMRsMalformedJSON(t *testing.T) {
	dir := fakeCLIStub(t, "glab", "<<not json>>", 0)
	withPath(t, dir)
	_, err := ListGitLabMRs(context.Background(), "", "opened", 20, "")
	if err == nil {
		t.Fatal("expected parse error, got nil")
	}
	if errors.Is(err, ErrCLIMissing) || errors.Is(err, ErrCLIUnauthenticated) {
		t.Fatalf("malformed JSON should not classify as missing/unauth: %v", err)
	}
}
